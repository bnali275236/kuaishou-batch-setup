import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  BatchTaskDetail,
  BatchTaskItemView,
  BatchTaskSummary,
  CREATE_DAILY_LIMIT,
  DEFAULT_INITIAL_STATUS,
  findHomePushViolation,
  HOME_PUSH_GUARD,
  InitialStatus,
  MapiErrorKind,
  PlanRow,
  PUT_STATUS_CODE,
  TASK_ITEM_STATUS,
  TASK_LEVEL,
  TASK_STATUS,
  VERIFY_STATUS,
} from '@wkbd/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { MapiError } from '../../mapi/mapi-error';
import { PlanApi, type CreateResult } from './plan.api';
import { buildCampaignPayload, buildCreativePayload, buildUnitPayload, SEARCH_KEYWORDS_META, SearchKeywordsMeta } from './plan.mapper';
import { validateRows } from './plan.validator';

/** 一个条目在库里的形态（执行器需要） */
interface RunItem {
  id: number;
  seq: number;
  advertiserId: string;
  level: string;
  parentId: number | null;
  rowNo: number;
  payloadJson: string;
  displayName: string | null;
  status: string;
  platformId: string | null;
}

/**
 * 展开后的待创建条目。
 *
 * 建任务时用它落库；**重试时也用它重建请求体**——见 retryFailed 的说明。
 */
interface PendingItem {
  seq: number;
  advertiserId: string;
  level: string;
  rowNo: number;
  payload: Record<string, unknown>;
  displayName: string;
  /** 同行的父级在数组中的下标，用于回填平台 ID */
  parentIndex: number | null;
}

/**
 * 批量任务引擎。
 *
 * ## 为什么不用「循环调用 + Promise.all」
 *
 * 用户点一次「提交 100 条」，实际是 300 次平台调用（计划/组/创意各一次）。
 * 这不是一个请求里能做完的事——按 600 QPM 限流要跑十几分钟，
 * 浏览器早超时了。所以必须：
 *
 *   1. **落库成条目**（BatchTaskItem），每个条目 = 一次平台调用
 *   2. **后台串行执行**，由令牌桶控制节奏
 *   3. **父子依赖**：组要拿到计划的 campaign_id、创意要拿到组 unit_id，
 *      父级失败时子级必须 SKIP 而不是硬着头皮发（否则会产生一批孤儿报错）
 *   4. **断点续跑**：进程重启后把 RUNNING 的任务捡起来继续，已完成的不重发
 *   5. **只重试失败项**：100 条里废了 3 条，用户不该重跑 100 条
 *
 * ## 并发策略
 *
 * 单任务**串行**执行。理由：20-100 条这个量级下，串行的总耗时已经可接受
 * （十几分钟内），而串行带来的确定性——执行顺序、失败定位、限流水位可预测——
 * 远比并发省下的那点时间重要。真正的瓶颈是平台 QPM，不是本地并发度。
 */
@Injectable()
export class TaskService {
  private readonly logger = new Logger(TaskService.name);
  /** 正在执行的任务 ID，防止同一任务被重复拉起 */
  private readonly running = new Set<number>();
  /** 被请求暂停的任务 */
  private readonly pauseRequested = new Set<number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly planApi: PlanApi,
  ) {}

  /* ------------------------------------------------------------------
   * 任务创建
   * ---------------------------------------------------------------- */

  /**
   * 代投白名单（只读账户）拦截：白名单内账户只能看数据，
   * 上计划、重试失败项等一切写操作都在任务创建入口拒绝。
   */
  private async assertNotReadOnly(advertiserIds: string[]): Promise<void> {
    const locked = await this.prisma.oauthAccount.findMany({
      where: { advertiserId: { in: [...new Set(advertiserIds.filter(Boolean))] }, readOnly: true },
      select: { advertiserId: true, accountName: true },
    });
    if (locked.length === 0) return;
    const names = locked
      .map((a) => `${a.accountName ?? '未命名账户'}(${a.advertiserId})`)
      .join('、');
    throw new BadRequestException(
      `以下 ${locked.length} 个账户在「代投白名单」内，仅可查看数据，禁止上计划/调整：${names}`,
    );
  }

  /**
   * 提交一批行 → 展开成条目并落库。
   *
   * 展开规则：每行按「计划 → 组 → 创意」三层展开，
   * seq 排序保证执行时父级一定先于子级（100 行以内时这个顺序是天然的）。
   */
  async createTask(input: {
    name?: string;
    rows: PlanRow[];
    dryRun?: boolean;
    draftId?: number;
    initialStatus?: InitialStatus;
  }): Promise<BatchTaskSummary> {
    const rows = input.rows ?? [];
    if (rows.length === 0) throw new BadRequestException('没有可提交的行');

    const initialStatus: InitialStatus =
      input.initialStatus === 'RUNNING' ? 'RUNNING' : DEFAULT_INITIAL_STATUS;
    const putStatus = PUT_STATUS_CODE.RUNNING;
    // 组/创意创建时一律默认开启。「创建后暂停」只作用于计划层：
    // 计划创建成功后立即单独置暂停——计划暂停时其下组/创意不可能消耗。

    // 🚫 代投白名单（只读账户）：不允许对白名单内账户发起任何创编写操作。
    // 复制历史任务（duplicateTask）也走这里，所以一处拦截全覆盖。
    // 放在参数校验之前：权限问题应该第一个报出来，而不是被一堆参数错误淹没。
    await this.assertNotReadOnly(rows.map((r) => r.advertiserId));

    // 提交前必须过一遍校验：宁可在这里拦住，也不要让 300 次调用全报同一个参数错
    const issues = validateRows(rows);
    const blocking = issues.filter((i) => i.severity === 'ERROR');
    if (blocking.length > 0) {
      throw new BadRequestException({
        message: `有 ${blocking.length} 处错误需要先修正`,
        issues: blocking.slice(0, 50),
      });
    }

    // 🚫 红线（提交前检查）：把本次任务将要发出的全部请求体过一遍主页推送黑名单。
    // 网关层还有同样的守卫兜底，这里提前拦是为了在任务创建阶段就给出明确报错，
    // 而不是落库执行到一半才失败。
    for (const row of rows) {
      for (const payload of [
        buildCampaignPayload(row),
        buildUnitPayload(row, '', putStatus),
        ...this.creativeVideosOf(row).map((v) => buildCreativePayload(row, '', v)),
      ]) {
        const violation = findHomePushViolation('', payload);
        if (violation) throw new BadRequestException(`${HOME_PUSH_GUARD.reason} 触发点：${violation}`);
      }
    }

    await this.assertDailyQuota(rows);

    // 防呆：平台要求计划名在账户内唯一，提交前自动去重（撞名加 -2、-3 序号），
    // 用户不需要为了「计划名称重复」手动改名——尤其是复制历史任务重提的场景。
    await this.dedupeCampaignNames(rows);

    const name =
      input.name?.trim() ||
      `批量上计划 · ${rows.length} 行 · ${new Date().toLocaleString('zh-CN', { hour12: false })}`;

    const task = await this.prisma.batchTask.create({
      data: {
        name,
        draftId: input.draftId ?? null,
        dryRun: input.dryRun ?? false,
        initialStatus,
        status: TASK_STATUS.PENDING,
        rowsJson: JSON.stringify(rows),
      },
    });

    // 展开条目：seq 用「层内序号 × 10000 + 行号」保证计划全部排在组之前，组排在创意之前
    const pending = this.expandRows(rows);

    // 先建条目拿到自增 ID，再回填 parentId（自引用只能这么做）
    const idByIndex = new Map<number, number>();
    for (let i = 0; i < pending.length; i += 1) {
      const item = pending[i];
      const created = await this.prisma.batchTaskItem.create({
        data: {
          taskId: task.id,
          seq: item.seq,
          advertiserId: item.advertiserId,
          level: item.level,
          rowNo: item.rowNo,
          payloadJson: JSON.stringify(item.payload),
          displayName: item.displayName,
          // idemKey 带 seq：一个计划展开多组后，各组的创意名可以同名，靠 seq 保证键唯一
          idemKey: `${item.level}:${item.advertiserId}:${item.rowNo}:s${item.seq}:${item.displayName}`.slice(0, 180),
          status: TASK_ITEM_STATUS.PENDING,
        },
      });
      idByIndex.set(i, created.id);
    }

    for (let i = 0; i < pending.length; i += 1) {
      const parentIndex = pending[i].parentIndex;
      if (parentIndex === null) continue;
      await this.prisma.batchTaskItem.update({
        where: { id: idByIndex.get(i)! },
        data: { parentId: idByIndex.get(parentIndex)! },
      });
    }

    await this.prisma.batchTask.update({
      where: { id: task.id },
      data: { totalItems: pending.length },
    });

    this.logger.log(`任务 #${task.id} 已创建：${rows.length} 行 → ${pending.length} 个条目`);

    // 立即异步执行（不 await，接口马上返回任务号，前端靠轮询看进度）
    void this.runTask(task.id);

    return this.summarize(task.id);
  }

  /**
   * 把行快照展开为待创建条目（纯函数式，无副作用、不碰数据库）。
   *
   * 建任务与**重试**共用这一份逻辑：payloadJson 是建任务时冻结进库的，
   * 若 mapper 修了 bug，重试必须用**新** mapper 重新展开，否则等于把同一个错误再犯一次。
   */
  private expandRows(rows: PlanRow[]): PendingItem[] {
    const putStatus = PUT_STATUS_CODE.RUNNING;
    const pending: PendingItem[] = [];

    rows.forEach((row, index) => {
      // 每条计划的组数（防呆：非法值一律收敛到 1~50），仅旧模型回退时使用
      const unitsPer = Math.min(Math.max(Math.trunc(row.unitsPerCampaign ?? 1) || 1, 1), 50);

      const campaignIndex = pending.length;
      pending.push({
        seq: 1 * 10000 + index,
        advertiserId: row.advertiserId,
        level: TASK_LEVEL.CAMPAIGN,
        rowNo: row.rowNo,
        payload: buildCampaignPayload(row),
        displayName: row.campaignName,
        parentIndex: null,
      });

      const padCreative = (n: number) => String(n).padStart(2, '0');
      const padUnit = (n: number) => String(n).padStart(2, '0');
      // 「创意名与素材名一致」：直接用视频文件名作创意名（空名回落到命名模板）
      const sameAsMaterial = row.creativeNameSameAsMaterial === true;

      // 组定义（素材切分装填）：新模型 units —— 每组各有自己的视频，素材不重复；
      // 旧快照无 units 时回退旧模型：同一批视频在每个组下各建一轮（unitsPer 个组）。
      // 组名：单组保持原名；多组加 -01/-02 序号（创意名只要求组内唯一，各组可同名）
      const baseUnitName = (row.unitName || row.campaignName).trim();
      const unitDefs: Array<{
        unitName: string;
        videos: Array<{ photoId: string; description?: string | null; name?: string | null }>;
      }> =
        row.units && row.units.length > 0
          ? row.units.map((u, ui) => ({
              unitName:
                (u.unitName ?? '').trim() ||
                (row.units!.length > 1
                  ? `${baseUnitName.slice(0, 120)}-${padUnit(ui + 1)}`
                  : baseUnitName),
              videos: u.videos.map((v) => ({
                photoId: v.photoId || row.photoId || '',
                description: v.description ?? row.description ?? null,
                name: v.name ?? null,
              })),
            }))
          : Array.from({ length: unitsPer }, (_, ui) => ({
              unitName:
                unitsPer > 1 ? `${baseUnitName.slice(0, 120)}-${padUnit(ui + 1)}` : baseUnitName,
              videos: this.creativeVideosOf(row),
            }));

      for (const [ui, def] of unitDefs.entries()) {
        const unitIndex = pending.length;
        pending.push({
          seq: 2 * 10000 + index * 100 + ui,
          advertiserId: row.advertiserId,
          level: TASK_LEVEL.UNIT,
          rowNo: row.rowNo,
          payload: buildUnitPayload(row, '', putStatus, def.unitName),
          displayName: def.unitName,
          parentIndex: campaignIndex,
        });

        // 素材名一致模式下做组内去重：平台校验「该广告组下广告创意名重复」（401000）
        const nameCount = new Map<string, number>();
        def.videos.forEach((video, ci) => {
          let creativeName: string;
          if (sameAsMaterial) {
            const base = (video.name ?? '').trim() || row.creativeName;
            const seen = nameCount.get(base) ?? 0;
            nameCount.set(base, seen + 1);
            creativeName = seen === 0 ? base : `${base.slice(0, 118)}-${seen + 1}`;
          } else {
            // 模板模式：多视频时创意名必须组内唯一，带上 -创XX 后缀（与 displayName 一致）
            creativeName =
              def.videos.length > 1
                ? `${row.creativeName}-创${padCreative(ci + 1)}`
                : row.creativeName;
          }
          pending.push({
            seq: 3 * 10000 + index * 10000 + ui * 100 + ci,
            advertiserId: row.advertiserId,
            level: TASK_LEVEL.CREATIVE,
            rowNo: row.rowNo,
            payload: buildCreativePayload(row, '', video, creativeName),
            displayName: creativeName,
            parentIndex: unitIndex,
          });
        });
      }
    });

    return pending;
  }

  /**
   * 计划名自动去重。
   *
   * 平台校验「计划名在账户内唯一」。复制历史任务重提、同名批量提交都会撞名，
   * 与其让平台逐条打回让用户改名，不如提交前自动处理：
   *   1. 按账户拉取平台上已有的全部计划名
   *   2. 批内同名行互相排队，撞名的加 `-2`、`-3`… 序号
   * 平台名册拉取失败时降级为只做批内去重（执行层还有重名自动重试兜底）。
   */
  private async dedupeCampaignNames(rows: PlanRow[]): Promise<void> {
    const advertisers = [...new Set(rows.map((r) => r.advertiserId))];
    const platformNames = new Map<string, Set<string>>();
    await Promise.all(
      advertisers.map(async (id) => {
        try {
          platformNames.set(id, await this.planApi.listAllCampaignNames(id));
        } catch (err) {
          this.logger.warn(`拉取账户 ${id} 已有计划名失败，降级为批内去重：${(err as Error).message}`);
          platformNames.set(id, new Set());
        }
      }),
    );

    const used = new Map<string, Set<string>>();
    const take = (advertiserId: string, original: string): string => {
      const base = (original || '').trim() || '未命名计划';
      const seen = used.get(advertiserId) ?? new Set(platformNames.get(advertiserId) ?? []);
      used.set(advertiserId, seen);
      if (!seen.has(base)) {
        seen.add(base);
        return base;
      }
      // 撞名：加序号。先截断再拼序号，防止超出平台名称长度限制
      for (let i = 2; i < 1000; i += 1) {
        const suffix = `-${i}`;
        const candidate = base.slice(0, Math.max(1, 128 - suffix.length)) + suffix;
        if (!seen.has(candidate)) {
          seen.add(candidate);
          return candidate;
        }
      }
      const fallback = `${base.slice(0, 100)}-${Date.now()}`;
      seen.add(fallback);
      return fallback;
    };

    for (const row of rows) {
      const unique = take(row.advertiserId, row.campaignName);
      if (unique !== row.campaignName) {
        this.logger.log(`计划名「${row.campaignName}」重复，自动改为「${unique}」`);
        row.campaignName = unique;
      }
    }
  }

  /* ------------------------------------------------------------------
   * 执行
   * ---------------------------------------------------------------- */

  async runTask(taskId: number): Promise<void> {
    if (this.running.has(taskId)) return;
    this.running.add(taskId);
    try {
      const task = await this.prisma.batchTask.findUnique({ where: { id: taskId } });
      if (!task) return;
      if (task.dryRun) {
        // 干跑：只做校验，不真调平台
        await this.prisma.batchTask.update({
          where: { id: taskId },
          data: { status: TASK_STATUS.DONE, finishedAt: new Date(), skipped: task.totalItems },
        });
        return;
      }

      this.pauseRequested.delete(taskId);
      await this.prisma.batchTask.update({
        where: { id: taskId },
        data: { status: TASK_STATUS.RUNNING, startedAt: task.startedAt ?? new Date() },
      });

      const items = (await this.prisma.batchTaskItem.findMany({
        where: { taskId },
        orderBy: { seq: 'asc' },
      })) as RunItem[];

      const idToItem = new Map<number, RunItem>(items.map((i) => [i.id, i]));

      for (const item of items) {
        if (this.pauseRequested.has(taskId)) {
          await this.prisma.batchTask.update({
            where: { id: taskId },
            data: { status: TASK_STATUS.PAUSED },
          });
          this.logger.log(`任务 #${taskId} 已暂停`);
          return;
        }

        if (item.status === TASK_ITEM_STATUS.SUCCEEDED) continue;

        // 父级没成功 → 子级直接跳过（避免产生一串无意义的「组不存在」报错）
        const parent = item.parentId ? idToItem.get(item.parentId) : undefined;
        if (item.parentId && parent && parent.status !== TASK_ITEM_STATUS.SUCCEEDED) {
          await this.markItem(item.id, {
            status: TASK_ITEM_STATUS.SKIPPED,
            errorKind: 'DEPENDENCY',
            errorMessage: `父级「${parent.displayName ?? parent.id}」未创建成功，已跳过`,
          });
          await this.bumpCounters(taskId, { skipped: 1 });
          continue;
        }

        await this.executeItem(taskId, item, parent, task.initialStatus === 'PAUSED');
      }

      if (task.initialStatus === 'PAUSED') {
        await this.enforcePaused(taskId);
      }

      await this.finalize(taskId);
    } catch (err) {
      this.logger.error(`任务 #${taskId} 执行异常：${(err as Error).message}`);
      await this.prisma.batchTask
        .update({
          where: { id: taskId },
          data: { status: TASK_STATUS.FAILED, lastError: (err as Error).message, finishedAt: new Date() },
        })
        .catch(() => undefined);
    } finally {
      this.running.delete(taskId);
    }
  }

  private async executeItem(
    taskId: number,
    item: RunItem,
    parent: RunItem | undefined,
    /** 「创建后暂停」只作用计划层：计划创建成功后立即单独置暂停，组/创意保持开启 */
    pauseCampaigns = false,
  ): Promise<void> {
    const payload = JSON.parse(item.payloadJson) as Record<string, unknown>;

    // 搜索关键词挂在保留键上（v2/word_info/create 需要计划+组两个 ID，不能进 unit/create 请求体）
    const searchKeywordsMeta =
      item.level === TASK_LEVEL.UNIT
        ? (payload[SEARCH_KEYWORDS_META] as SearchKeywordsMeta | undefined)
        : undefined;
    if (searchKeywordsMeta) delete payload[SEARCH_KEYWORDS_META];

    // 回填父级平台 ID：组需要 campaign_id，创意需要 unit_id
    if (item.level === TASK_LEVEL.UNIT && parent?.platformId) {
      payload.campaign_id = this.numeric(parent.platformId);
    }
    if (item.level === TASK_LEVEL.CREATIVE && parent?.platformId) {
      payload.unit_id = this.numeric(parent.platformId);
    }

    await this.prisma.batchTaskItem.update({
      where: { id: item.id },
      data: { status: TASK_ITEM_STATUS.RUNNING, attempts: { increment: 1 } },
    });

    try {
      // 计划层撞名自动重试：提交前虽已按平台名册去重，但存在提交间隙被占名的可能。
      // 命中「计划名称重复」时自动加序号重试（最多 3 次），不让用户处理这种人工报错。
      let renameTried = 0;
      let result: CreateResult;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        try {
          result =
            item.level === TASK_LEVEL.CAMPAIGN
              ? await this.planApi.createCampaign(item.advertiserId, payload)
              : item.level === TASK_LEVEL.UNIT
                ? await this.planApi.createUnit(item.advertiserId, payload)
                : await this.planApi.createCreative(item.advertiserId, payload);
          break;
        } catch (renameErr) {
          const renameMsg = (renameErr as Error).message ?? '';
          if (
            item.level === TASK_LEVEL.CAMPAIGN &&
            renameMsg.includes('计划名称重复') &&
            renameTried < 3
          ) {
            renameTried += 1;
            const original = String(payload.campaign_name ?? item.displayName ?? '计划');
            const renamed = `${original.slice(0, 124)}-${renameTried + 1}`;
            payload.campaign_name = renamed;
            this.logger.warn(`条目 #${item.id} 计划名「${original}」重复，自动改为「${renamed}」重试`);
            continue;
          }
          throw renameErr;
        }
      }

      if (!result.platformId) {
        throw new MapiError(
          '平台未返回实体 ID，无法确认创建结果',
          MapiErrorKind.UNKNOWN,
          -1,
          item.level,
        );
      }

      // 搜索广告关键词：组创建成功后追加下发。关键词失败**不推翻**组创建结果
      // （组已在平台上存在），失败详情记日志 + 条目备注，由用户人工补词。
      let keywordNote: string | null = null;
      if (searchKeywordsMeta && parent?.platformId) {
        try {
          const kw = await this.planApi.createKeywords(
            item.advertiserId,
            parent.platformId,
            result.platformId,
            searchKeywordsMeta.words,
            searchKeywordsMeta.match_type,
          );
          if (kw.failed.length > 0) {
            keywordNote = `关键词 ${kw.succeeded.length} 成功 / ${kw.failed.length} 被拒：${kw.failed.slice(0, 10).join('、')}`;
            this.logger.warn(`条目 #${item.id}（${item.displayName}）${keywordNote}`);
          }
        } catch (err) {
          keywordNote = `关键词下发失败（组已创建成功，可人工补词）：${(err as Error).message}`;
          this.logger.warn(`条目 #${item.id} ${keywordNote}`);
        }
      }

      await this.markItem(item.id, {
        status: TASK_ITEM_STATUS.SUCCEEDED,
        platformId: result.platformId,
        // 计划层若触发过撞名重试，名称已变，同步显示名（核验按显示名比对）
        displayName:
          item.level === TASK_LEVEL.CAMPAIGN ? String(payload.campaign_name) : item.displayName,
        // 创建成功先挂「待核验」，由核验流程回读确认
        verifyStatus: VERIFY_STATUS.PENDING,
        errorCode: null,
        errorKind: null,
        errorMessage: null,
        verifyDiff: keywordNote,
      });
      // 内存里的父级也要更新，后续子级才能拿到 ID
      item.status = TASK_ITEM_STATUS.SUCCEEDED;
      item.platformId = result.platformId;
      if (item.level === TASK_LEVEL.CAMPAIGN) item.displayName = String(payload.campaign_name);
      await this.bumpCounters(taskId, { succeeded: 1 });

      // 「创建后暂停」：计划创建成功后**立即**置暂停，不等任务收尾——
      // 否则大任务执行期间计划是投放状态，其下已开启的组可能产生消耗。
      // 失败只记警告不翻状态：末尾 enforcePaused 会再兜底重试一次。
      if (item.level === TASK_LEVEL.CAMPAIGN && pauseCampaigns) {
        try {
          await this.planApi.updateCampaignStatus(
            item.advertiserId,
            [result.platformId],
            PUT_STATUS_CODE.PAUSED,
          );
        } catch (pauseErr) {
          this.logger.warn(
            `条目 #${item.id} 计划「${item.displayName}」置暂停失败（收尾时重试）：${(pauseErr as Error).message}`,
          );
        }
      }
    } catch (err) {
      const mapiErr = err as MapiError;
      const message = mapiErr?.message ?? (err as Error).message;
      await this.markItem(item.id, {
        status: TASK_ITEM_STATUS.FAILED,
        errorCode: typeof mapiErr?.code === 'number' ? mapiErr.code : null,
        errorKind: mapiErr?.kind ?? MapiErrorKind.UNKNOWN,
        errorMessage: message.slice(0, 500),
      });
      item.status = TASK_ITEM_STATUS.FAILED;
      await this.bumpCounters(taskId, { failed: 1 });
      this.logger.warn(`条目 #${item.id}（${item.level} ${item.displayName}）失败：${message}`);
    }
  }

  /**
   * 收尾兜底：把计划层置为暂停（创意层与组层不再处理——「创建后暂停」只作用计划层，
   * 组/创意创建时即开启）。计划层在创建成功后已在 executeItem 里立即置过暂停，
   * 这里主要覆盖两类漏网情况：置暂停当时失败、断点续跑时上一轮没置成功的计划。
   *
   * 为什么失败不算任务失败 —— 只要计划是暂停的，其下组/创意不可能产生消耗。
   * 这里只是把平台后台的显示状态对齐，属于「锦上添花」，失败降级为警告。
   *
   * 幂等：对已暂停的对象再置暂停是安全的，所以断点续跑、重试、恢复都可以重入。
   */
  private async enforcePaused(taskId: number): Promise<void> {
    const items = await this.prisma.batchTaskItem.findMany({
      where: {
        taskId,
        status: TASK_ITEM_STATUS.SUCCEEDED,
        platformId: { not: null },
        level: TASK_LEVEL.CAMPAIGN,
      },
      select: { advertiserId: true, level: true, platformId: true },
    });
    if (items.length === 0) return;

    // 按「账户」归组，让平台的批量能力承担大部分工作
    const groups = new Map<string, string[]>();
    for (const item of items) {
      groups.set(item.advertiserId, [...(groups.get(item.advertiserId) ?? []), item.platformId!]);
    }

    const failures: string[] = [];
    for (const [advertiserId, ids] of groups) {
      try {
        const result = await this.planApi.updateCampaignStatus(
          advertiserId,
          ids,
          PUT_STATUS_CODE.PAUSED,
        );
        // 平台可以只成功一部分，errors 非空时必须报出来，不能只看成功项
        if (result.errors.length > 0) {
          failures.push(
            `${advertiserId}(${result.errors.length}/${ids.length} 个失败)：${JSON.stringify(result.errors).slice(0, 200)}`,
          );
        }
      } catch (err) {
        failures.push(`${advertiserId}(${ids.length} 个)：${(err as Error).message}`);
        this.logger.warn(`任务 #${taskId} 置暂停失败 ${advertiserId}：${(err as Error).message}`);
      }
    }

    if (failures.length > 0) {
      await this.prisma.batchTask.update({
        where: { id: taskId },
        data: {
          lastError: `[警告] 计划层置暂停未全部成功，需人工确认：${failures.join('；')}`.slice(0, 1000),
        },
      });
    } else {
      // 上一轮失败留下的警告要清掉，否则重试成功后界面上还挂着一条过期警告，
      // 用户会以为问题仍在。只清自己写的警告，真正的失败原因不动。
      const current = await this.prisma.batchTask.findUnique({
        where: { id: taskId },
        select: { lastError: true },
      });
      if (current?.lastError?.startsWith('[警告]')) {
        await this.prisma.batchTask.update({
          where: { id: taskId },
          data: { lastError: null },
        });
      }
      this.logger.log(`任务 #${taskId} 已把所有计划置为暂停`);
    }
  }

  /** 收尾：按成功/失败分布定终态。这是「部分成功」这个状态存在的意义 */
  private async finalize(taskId: number): Promise<void> {
    const task = await this.prisma.batchTask.findUnique({ where: { id: taskId } });
    if (!task) return;

    const [succeeded, failed, skipped] = await Promise.all([
      this.prisma.batchTaskItem.count({ where: { taskId, status: TASK_ITEM_STATUS.SUCCEEDED } }),
      this.prisma.batchTaskItem.count({ where: { taskId, status: TASK_ITEM_STATUS.FAILED } }),
      this.prisma.batchTaskItem.count({ where: { taskId, status: TASK_ITEM_STATUS.SKIPPED } }),
    ]);

    const status =
      failed === 0 && skipped === 0
        ? TASK_STATUS.DONE
        : succeeded === 0
          ? TASK_STATUS.FAILED
          : TASK_STATUS.PARTIAL;

    await this.prisma.batchTask.update({
      where: { id: taskId },
      data: { status, succeeded, failed, skipped, finishedAt: new Date() },
    });
    this.logger.log(
      `任务 #${taskId} 结束：成功 ${succeeded} / 失败 ${failed} / 跳过 ${skipped} → ${status}`,
    );
  }

  /* ------------------------------------------------------------------
   * 暂停 / 恢复 / 重试失败项 / 取消
   * ---------------------------------------------------------------- */

  async requestPause(taskId: number): Promise<void> {
    this.pauseRequested.add(taskId);
    // 未在执行中的任务直接置为暂停
    if (!this.running.has(taskId)) {
      await this.prisma.batchTask.update({
        where: { id: taskId },
        data: { status: TASK_STATUS.PAUSED },
      });
    }
  }

  async resume(taskId: number): Promise<BatchTaskSummary> {
    const task = await this.prisma.batchTask.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException(`任务 #${taskId} 不存在`);
    if (task.status === TASK_STATUS.DONE) throw new BadRequestException('任务已全部成功，无需恢复');

    this.pauseRequested.delete(taskId);
    await this.prisma.batchTask.update({
      where: { id: taskId },
      data: { status: TASK_STATUS.RUNNING, finishedAt: null },
    });
    void this.runTask(taskId);
    return this.summarize(taskId);
  }

  /**
   * 只重试失败项。
   * 关键点 1：已成功的条目**绝不重发**——平台没有幂等保证，
   * 重发会真的再建一条一模一样的计划出来。
   * 关键点 2：重试前**用当前 mapper 重建失败项的请求体**（见 refreshFailedPayloads）。
   * payloadJson 是建任务时冻结的，历史任务里存的是当时的旧产物；
   * 若 mapper 修了 bug（如 UAX 必填 auto_build_name_rule），直接重放旧 payload
   * 等于把同一个错误再犯一次——用户会以为「修了没用」。
   */
  async retryFailed(taskId: number): Promise<BatchTaskSummary> {
    const task = await this.prisma.batchTask.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException(`任务 #${taskId} 不存在`);

    // 白名单可能是在任务创建后才设置的：重试同样不允许对只读账户发写操作
    const retryItems = await this.prisma.batchTaskItem.findMany({
      where: { taskId, status: { in: [TASK_ITEM_STATUS.FAILED, TASK_ITEM_STATUS.SKIPPED] } },
      select: { advertiserId: true },
      distinct: ['advertiserId'],
    });
    await this.assertNotReadOnly(retryItems.map((i) => i.advertiserId));

    const rebuilt = await this.refreshFailedPayloads(taskId, task.rowsJson);
    if (rebuilt.changed > 0) {
      this.logger.log(
        `任务 #${taskId} 重试前重建了 ${rebuilt.changed} 个条目的请求体（共 ${rebuilt.total} 个待重试）`,
      );
    }

    // 失败的组/创意，其父级若已成功，重试时能重新拿到 ID，直接复活即可
    const { count } = await this.prisma.batchTaskItem.updateMany({
      where: {
        taskId,
        status: { in: [TASK_ITEM_STATUS.FAILED, TASK_ITEM_STATUS.SKIPPED] },
      },
      data: {
        status: TASK_ITEM_STATUS.PENDING,
        errorCode: null,
        errorKind: null,
        errorMessage: null,
      },
    });
    if (count === 0) throw new BadRequestException('没有失败项需要重试');

    // 被跳过的父级如果本身失败了，它也会被上面一起重置，顺序由 seq 保证
    await this.prisma.batchTask.update({
      where: { id: taskId },
      data: { status: TASK_STATUS.RUNNING, finishedAt: null, failed: 0, skipped: 0 },
    });
    void this.runTask(taskId);
    this.logger.log(`任务 #${taskId} 重试 ${count} 个失败/跳过条目`);
    return this.summarize(taskId);
  }

  /**
   * 用当前 mapper 重建「失败/跳过」条目的 payloadJson 与 displayName。
   *
   * 行快照（task.rowsJson）是提交时定稿的（已过去重），重新展开得到的 seq 与名称
   * 与建任务时一致，因此可以用 seq 一一对上。任何一步不确定就**保留旧 payload**
   * 并告警——宁可报原来的错，也不要因为重建失败把任务彻底卡死。
   */
  private async refreshFailedPayloads(
    taskId: number,
    rowsJson: string | null,
  ): Promise<{ total: number; changed: number }> {
    if (!rowsJson) return { total: 0, changed: 0 };

    const items = await this.prisma.batchTaskItem.findMany({
      where: { taskId, status: { in: [TASK_ITEM_STATUS.FAILED, TASK_ITEM_STATUS.SKIPPED] } },
      select: { id: true, seq: true, payloadJson: true, displayName: true },
      orderBy: { seq: 'asc' },
    });
    if (items.length === 0) return { total: 0, changed: 0 };

    let rows: PlanRow[];
    try {
      const parsed = JSON.parse(rowsJson);
      if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('rowsJson 不是非空数组');
      rows = parsed as PlanRow[];
    } catch (err) {
      this.logger.warn(
        `任务 #${taskId} 的行快照无法解析，重试沿用旧请求体：${(err as Error).message}`,
      );
      return { total: items.length, changed: 0 };
    }

    const fresh = new Map<number, PendingItem>();
    for (const item of this.expandRows(rows)) fresh.set(item.seq, item);

    let changed = 0;
    let unmatched = 0;
    for (const item of items) {
      const next = fresh.get(item.seq);
      if (!next) {
        unmatched += 1;
        continue;
      }
      const nextPayloadJson = JSON.stringify(next.payload);
      if (nextPayloadJson === item.payloadJson) {
        // 请求体没变（本例之外的大多数情况）：不写库。
        // displayName 由同一份行快照派生，payload 没变它也不会变。
        continue;
      }
      await this.prisma.batchTaskItem.update({
        where: { id: item.id },
        data: { payloadJson: nextPayloadJson, displayName: next.displayName },
      });
      changed += 1;
    }
    if (unmatched > 0) {
      this.logger.warn(`任务 #${taskId} 有 ${unmatched} 个条目的 seq 未匹配上，沿用旧请求体`);
    }
    return { total: items.length, changed };
  }

  async cancel(taskId: number): Promise<void> {
    this.pauseRequested.add(taskId);
    await this.prisma.batchTask.update({
      where: { id: taskId },
      data: { status: TASK_STATUS.CANCELLED, finishedAt: new Date() },
    });
  }

  /* ------------------------------------------------------------------
   * 创建后回读核验
   * ---------------------------------------------------------------- */

  /**
   * 回读核验：拿平台返回的 ID 反查一次，确认实体真实存在且关键字段一致。
   *
   * 为什么必须做：创建接口返回成功只代表「平台收下了」，
   * 广告审核、账户状态、字段被平台静默改写都可能让结果与预期不符。
   * 盯盘的起点必须是一条真实存在的计划，而不是一个 ID 字符串。
   */
  async verifyTask(taskId: number): Promise<{ checked: number; ok: number; mismatch: number; missing: number }> {
    const items = await this.prisma.batchTaskItem.findMany({
      where: { taskId, status: TASK_ITEM_STATUS.SUCCEEDED, platformId: { not: null } },
      orderBy: { seq: 'asc' },
    });

    // 按「账户 + 层级」分组，用接口的批量查询能力（一次 200 个 ID），不要逐个查
    const groups = new Map<string, typeof items>();
    for (const item of items) {
      const key = `${item.advertiserId}|${item.level}`;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }

    let ok = 0;
    let mismatch = 0;
    let missing = 0;

    for (const [key, group] of groups) {
      const [advertiserId, level] = key.split('|');
      const ids = group.map((i) => i.platformId!).filter(Boolean);

      let found: Array<Record<string, unknown>> = [];
      try {
        found =
          level === TASK_LEVEL.CAMPAIGN
            ? await this.planApi.listCampaigns(advertiserId, ids)
            : level === TASK_LEVEL.UNIT
              ? await this.planApi.listUnits(advertiserId, ids)
              : await this.planApi.listCreatives(advertiserId, ids);
      } catch (err) {
        // 核验失败不影响创建结果，只记录，不把条目判成失败
        this.logger.warn(`核验 ${key} 查询失败：${(err as Error).message}`);
        continue;
      }

      const nameField =
        level === TASK_LEVEL.CAMPAIGN
          ? 'campaign_name'
          : level === TASK_LEVEL.UNIT
            ? 'unit_name'
            : 'creative_name';
      const idField =
        level === TASK_LEVEL.CAMPAIGN ? 'campaign_id' : level === TASK_LEVEL.UNIT ? 'unit_id' : 'creative_id';

      const foundById = new Map<string, Record<string, unknown>>();
      for (const record of found) {
        const id = record[idField];
        if (id != null) foundById.set(String(id), record);
      }

      for (const item of group) {
        const record = foundById.get(item.platformId!);
        if (!record) {
          missing += 1;
          await this.prisma.batchTaskItem.update({
            where: { id: item.id },
            data: {
              verifyStatus: VERIFY_STATUS.NOT_FOUND,
              verifyDiff: '平台查询不到该 ID',
              verifiedAt: new Date(),
            },
          });
          continue;
        }

        const platformName = String(record[nameField] ?? '');
        if (platformName && item.displayName && platformName !== item.displayName) {
          mismatch += 1;
          await this.prisma.batchTaskItem.update({
            where: { id: item.id },
            data: {
              verifyStatus: VERIFY_STATUS.MISMATCH,
              verifyDiff: JSON.stringify({ [nameField]: { 提交: item.displayName, 平台: platformName } }),
              verifiedAt: new Date(),
            },
          });
        } else {
          ok += 1;
          await this.prisma.batchTaskItem.update({
            where: { id: item.id },
            data: { verifyStatus: VERIFY_STATUS.OK, verifyDiff: null, verifiedAt: new Date() },
          });
        }
      }
    }

    return { checked: items.length, ok, mismatch, missing };
  }

  /** 找出最近创建成功但还没核验的任务（供定时核验用） */
  async tasksNeedingVerify(limit = 5): Promise<number[]> {
    const tasks = await this.prisma.batchTask.findMany({
      where: { status: { in: [TASK_STATUS.DONE, TASK_STATUS.PARTIAL] }, dryRun: false },
      orderBy: { finishedAt: 'desc' },
      take: limit,
      select: { id: true },
    });
    const out: number[] = [];
    for (const task of tasks) {
      const pending = await this.prisma.batchTaskItem.count({
        where: { taskId: task.id, verifyStatus: VERIFY_STATUS.PENDING },
      });
      if (pending > 0) out.push(task.id);
    }
    return out;
  }

  /* ------------------------------------------------------------------
   * 查询
   * ---------------------------------------------------------------- */

  async listTasks(limit = 50): Promise<BatchTaskSummary[]> {
    const tasks = await this.prisma.batchTask.findMany({
      where: { hidden: false },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    const accountCounts = await this.prisma.batchTaskItem.groupBy({
      by: ['taskId', 'advertiserId'],
      where: { taskId: { in: tasks.map((t) => t.id) } },
    });
    const accountMap = new Map<number, Set<string>>();
    for (const row of accountCounts) {
      const set = accountMap.get(row.taskId) ?? new Set<string>();
      set.add(row.advertiserId);
      accountMap.set(row.taskId, set);
    }

    // 计划级统计：列表页进度按「计划」展示，而不是把组/创意条目都摊给用户
    const statsByTask = new Map<number, { planTotal: number; planSucceeded: number; planFailed: number }>();
    if (tasks.length > 0) {
      const statItems = await this.prisma.batchTaskItem.findMany({
        where: { taskId: { in: tasks.map((t) => t.id) } },
        select: { id: true, taskId: true, parentId: true, level: true, status: true },
      });
      const byTask = new Map<number, typeof statItems>();
      for (const it of statItems) {
        const list = byTask.get(it.taskId) ?? [];
        list.push(it);
        byTask.set(it.taskId, list);
      }
      for (const [taskId, list] of byTask) statsByTask.set(taskId, this.computePlanStats(list));
    }

    return tasks.map((task) =>
      this.toSummary(
        task,
        accountMap.get(task.id)?.size ?? 0,
        statsByTask.get(task.id) ?? { planTotal: 0, planSucceeded: 0, planFailed: 0 },
      ),
    );
  }

  /**
   * 复制历史任务：用创建时的行快照重新发起一个新任务。
   * 新任务固定「创建后暂停」，默认名 `原名·副本`；校验不过会被拒（同手动提交）。
   */
  async duplicateTask(taskId: number): Promise<BatchTaskSummary> {
    const task = await this.prisma.batchTask.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException(`任务 #${taskId} 不存在`);

    let rowsJson = task.rowsJson;
    if (!rowsJson && task.draftId) {
      // 旧行快照缺失时回退到源草稿（草稿可能已被覆盖，尽力而为）
      const draft = await this.prisma.planDraft.findUnique({ where: { id: task.draftId } });
      rowsJson = draft?.rowsJson ?? null;
    }
    if (!rowsJson) {
      throw new BadRequestException('该任务没有行数据快照（旧任务），无法复制；请到上计划页重新生成');
    }
    let rows: PlanRow[] = [];
    try {
      const parsed = JSON.parse(rowsJson);
      if (Array.isArray(parsed)) rows = parsed as PlanRow[];
    } catch {
      throw new BadRequestException('行数据快照解析失败，无法复制');
    }
    if (rows.length === 0) throw new BadRequestException('行数据快照为空，无法复制');

    return this.createTask({
      name: `${task.name}·副本`,
      rows,
      // 干跑任务复制后仍是干跑（防止「复制一个测试任务」意外真实创建广告）
      dryRun: task.dryRun,
      initialStatus: 'PAUSED',
      draftId: task.draftId ?? undefined,
    });
  }

  /**
   * 任务行快照来源：给「批量任务 → 复制 → 跳转上计划回填」用。
   * 只读返回创建时的 PlanRow 快照，不发起任何提交。
   */
  async getTaskSource(taskId: number): Promise<{ rows: PlanRow[]; campaignType: number }> {
    const task = await this.prisma.batchTask.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException(`任务 #${taskId} 不存在`);

    let rowsJson = task.rowsJson;
    if (!rowsJson && task.draftId) {
      const draft = await this.prisma.planDraft.findUnique({ where: { id: task.draftId } });
      rowsJson = draft?.rowsJson ?? null;
    }
    let rows: PlanRow[] = [];
    try {
      const parsed = JSON.parse(rowsJson ?? '[]');
      if (Array.isArray(parsed)) rows = parsed as PlanRow[];
    } catch {
      rows = [];
    }
    if (rows.length === 0) {
      throw new BadRequestException('该任务没有行数据快照（旧任务），无法复制；请到上计划页重新生成');
    }
    return { rows, campaignType: rows[0]?.campaignType ?? 2 };
  }

  /** 删除历史任务：仅隐藏显示，平台实体与执行数据都不受影响 */
  async hideTask(taskId: number): Promise<void> {
    await this.prisma.batchTask.updateMany({
      where: { id: taskId },
      data: { hidden: true },
    });
  }

  async getTask(taskId: number): Promise<BatchTaskDetail> {
    const task = await this.prisma.batchTask.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException(`任务 #${taskId} 不存在`);

    const items = await this.prisma.batchTaskItem.findMany({
      where: { taskId },
      orderBy: { seq: 'asc' },
    });
    const accounts = new Set(items.map((i) => i.advertiserId));

    const detail: BatchTaskDetail = {
      ...this.toSummary(task, accounts.size, this.computePlanStats(items)),
      items: items.map(
        (item): BatchTaskItemView => ({
          id: item.id,
          seq: item.seq,
          advertiserId: item.advertiserId,
          level: item.level,
          status: item.status,
          verifyStatus: item.verifyStatus,
          displayName: item.displayName,
          platformId: item.platformId,
          attempts: item.attempts,
          errorCode: item.errorCode,
          errorKind: item.errorKind,
          errorMessage: item.errorMessage,
          verifiedAt: item.verifiedAt?.toISOString() ?? null,
          verifyDiff: item.verifyDiff,
          rowNo: item.rowNo,
        }),
      ),
    };
    return detail;
  }

  /* ------------------------------------------------------------------
   * 配额与内部工具
   * ---------------------------------------------------------------- */

  /**
   * 提交前核对平台日创建上限（计划 1000 / 组 600 / 创意 2000）。
   * 这是「平台能力边界」而不是「本地业务规则」，所以用的是历史任务的真实计数。
   */
  private async assertDailyQuota(rows: PlanRow[]): Promise<void> {
    const since = new Date();
    since.setHours(0, 0, 0, 0);

    const todayItems = await this.prisma.batchTaskItem.findMany({
      where: { createdAt: { gte: since }, status: TASK_ITEM_STATUS.SUCCEEDED },
      select: { advertiserId: true, level: true },
    });

    const perAccount = new Map<string, { campaign: number; unit: number; creative: number }>();
    for (const item of todayItems) {
      const entry = perAccount.get(item.advertiserId) ?? { campaign: 0, unit: 0, creative: 0 };
      if (item.level === TASK_LEVEL.CAMPAIGN) entry.campaign += 1;
      else if (item.level === TASK_LEVEL.UNIT) entry.unit += 1;
      else entry.creative += 1;
      perAccount.set(item.advertiserId, entry);
    }

    const willAdd = new Map<string, number>();
    const willAddUnit = new Map<string, number>();
    for (const row of rows) {
      // 创意组模型：一行 = 1 计划 + N 组 × M 创意
      const units = this.unitsPerRow(row);
      willAdd.set(row.advertiserId, (willAdd.get(row.advertiserId) ?? 0) + 1);
      willAddUnit.set(row.advertiserId, (willAddUnit.get(row.advertiserId) ?? 0) + units);
    }
    const willAddCreative = new Map<string, number>();
    for (const row of rows) {
      const units = this.unitsPerRow(row);
      // 素材切分装填（units 模型）：创意数 = 各组视频数之和（素材不重复）；
      // 旧模型回退：每组都建同一批创意 → 组数 × 每组创意数
      const creatives =
        row.units && row.units.length > 0
          ? row.units.reduce((n, u) => n + Math.max(u.videos.length, 0), 0)
          : units * this.creativeVideosOf(row).length;
      willAddCreative.set(
        row.advertiserId,
        (willAddCreative.get(row.advertiserId) ?? 0) + creatives,
      );
    }

    const problems: string[] = [];
    for (const [advertiserId, count] of willAdd) {
      const used = perAccount.get(advertiserId) ?? { campaign: 0, unit: 0, creative: 0 };
      if (used.campaign + count > CREATE_DAILY_LIMIT.CAMPAIGN) {
        problems.push(`账户 ${advertiserId} 今日计划创建数将超过 ${CREATE_DAILY_LIMIT.CAMPAIGN} 上限`);
      }
      const unitAdd = willAddUnit.get(advertiserId) ?? 0;
      if (used.unit + unitAdd > CREATE_DAILY_LIMIT.UNIT) {
        problems.push(`账户 ${advertiserId} 今日广告组创建数将超过 ${CREATE_DAILY_LIMIT.UNIT} 上限`);
      }
      if (used.creative + (willAddCreative.get(advertiserId) ?? 0) > CREATE_DAILY_LIMIT.CREATIVE) {
        problems.push(`账户 ${advertiserId} 今日创意创建数将超过 ${CREATE_DAILY_LIMIT.CREATIVE} 上限`);
      }
    }

    if (problems.length > 0) {
      throw new BadRequestException({ message: '超出平台日创建上限', issues: problems });
    }
  }

  private async markItem(id: number, data: Record<string, unknown>): Promise<void> {
    await this.prisma.batchTaskItem.update({ where: { id }, data });
  }

  /** 一行展开成几个广告组：units 模型 = units 数组长度；旧模型 = unitsPerCampaign（防呆收敛到 1~50） */
  private unitsPerRow(row: PlanRow): number {
    if (row.units && row.units.length > 0) return row.units.length;
    return Math.min(Math.max(Math.trunc(row.unitsPerCampaign ?? 1) || 1, 1), 50);
  }

  /**
   * 一行要展开成几个创意。创意组模型下 = 行上视频数；旧行为 = 1。
   * photoId 缺失时保留占位（校验器会拦），保证展开数量与用户预期一致。
   */
  private creativeVideosOf(
    row: PlanRow,
  ): Array<{ photoId: string; description?: string | null; name?: string | null }> {
    if (row.creativeVideos && row.creativeVideos.length > 0) {
      return row.creativeVideos.map((v) => ({
        photoId: v.photoId || row.photoId || '',
        description: v.description ?? row.description ?? null,
        name: v.name ?? null,
      }));
    }
    return [{ photoId: row.photoId ?? '', description: row.description ?? null }];
  }

  /**
   * 按「一次提交 = 一个任务」的口径统计计划数：
   * 计划层失败 → 该计划失败；整条链（计划+组+创意）全部成功 → 成功；
   * 其余（执行中/部分失败）不计入成功也不计入失败。
   */
  private computePlanStats(
    items: Array<{ id: number; parentId: number | null; level: string; status: string }>,
  ): { planTotal: number; planSucceeded: number; planFailed: number } {
    const statusById = new Map<number, string>();
    const childrenOf = new Map<number, number[]>();
    for (const it of items) {
      statusById.set(it.id, it.status);
      if (it.parentId != null) {
        const kids = childrenOf.get(it.parentId) ?? [];
        kids.push(it.id);
        childrenOf.set(it.parentId, kids);
      }
    }
    const subtreeAllOk = (id: number): boolean =>
      (childrenOf.get(id) ?? []).every(
        (k) => statusById.get(k) === TASK_ITEM_STATUS.SUCCEEDED && subtreeAllOk(k),
      );
    const subtreeUnfinished = (id: number): boolean =>
      (childrenOf.get(id) ?? []).some((k) => {
        const s = statusById.get(k);
        return s === TASK_ITEM_STATUS.PENDING || s === TASK_ITEM_STATUS.RUNNING || subtreeUnfinished(k);
      });

    let planTotal = 0;
    let planSucceeded = 0;
    let planFailed = 0;
    for (const it of items) {
      if (it.level !== TASK_LEVEL.CAMPAIGN) continue;
      planTotal += 1;
      if (it.status === TASK_ITEM_STATUS.SUCCEEDED && subtreeAllOk(it.id)) {
        planSucceeded += 1;
      } else if (
        it.status === TASK_ITEM_STATUS.PENDING ||
        it.status === TASK_ITEM_STATUS.RUNNING ||
        (it.status === TASK_ITEM_STATUS.SUCCEEDED && subtreeUnfinished(it.id))
      ) {
        // 还在跑：不计入成功也不计入失败
        continue;
      } else {
        // 计划层失败，或链路已跑完但有失败/跳过的子级 → 都算这条计划没成
        planFailed += 1;
      }
    }
    return { planTotal, planSucceeded, planFailed };
  }

  private async bumpCounters(taskId: number, delta: { succeeded?: number; failed?: number; skipped?: number }) {    if (!taskId) return;
    await this.prisma.batchTask.update({
      where: { id: taskId },
      data: {
        succeeded: delta.succeeded ? { increment: delta.succeeded } : undefined,
        failed: delta.failed ? { increment: delta.failed } : undefined,
        skipped: delta.skipped ? { increment: delta.skipped } : undefined,
      },
    });
  }

  private async summarize(taskId: number): Promise<BatchTaskSummary> {
    const task = await this.prisma.batchTask.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException(`任务 #${taskId} 不存在`);
    const accounts = await this.prisma.batchTaskItem.findMany({
      where: { taskId },
      select: { advertiserId: true },
      distinct: ['advertiserId'],
    });
    const statItems = await this.prisma.batchTaskItem.findMany({
      where: { taskId },
      select: { id: true, parentId: true, level: true, status: true },
    });
    return this.toSummary(task, accounts.length, this.computePlanStats(statItems));
  }

  private toSummary(
    task: {
      id: number;
      name: string;
      status: string;
      totalItems: number;
      succeeded: number;
      failed: number;
      skipped: number;
      createdAt: Date;
      startedAt: Date | null;
      finishedAt: Date | null;
      lastError: string | null;
      initialStatus: string;
    },
    accountCount: number,
    planStats: { planTotal: number; planSucceeded: number; planFailed: number },
  ): BatchTaskSummary {
    return {
      id: task.id,
      name: task.name,
      status: task.status,
      totalItems: task.totalItems,
      succeeded: task.succeeded,
      failed: task.failed,
      skipped: task.skipped,
      createdAt: task.createdAt.toISOString(),
      startedAt: task.startedAt?.toISOString() ?? null,
      finishedAt: task.finishedAt?.toISOString() ?? null,
      lastError: task.lastError ?? null,
      accountCount,
      planTotal: planStats.planTotal,
      planSucceeded: planStats.planSucceeded,
      planFailed: planStats.planFailed,
      initialStatus: task.initialStatus === 'RUNNING' ? 'RUNNING' : DEFAULT_INITIAL_STATUS,
    };
  }

  /** 进程重启后把未完成的任务捡回来续跑（断点续跑） */
  async resumeInterrupted(): Promise<void> {
    const tasks = await this.prisma.batchTask.findMany({
      where: { status: { in: [TASK_STATUS.RUNNING, TASK_STATUS.PENDING] }, dryRun: false },
      select: { id: true },
    });
    if (tasks.length === 0) return;
    this.logger.log(`发现 ${tasks.length} 个未完成任务，开始续跑`);
    for (const task of tasks) {
      void this.runTask(task.id);
    }
  }

  private numeric(value: string): number | string {
    const trimmed = String(value).trim();
    if (!/^\d+$/.test(trimmed)) return trimmed;
    const asNumber = Number(trimmed);
    return Number.isSafeInteger(asNumber) ? asNumber : trimmed;
  }
}
