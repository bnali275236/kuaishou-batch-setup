import { Injectable, Logger } from '@nestjs/common';
import dayjs from 'dayjs';
import { ASYNC_BACKFILL_DAYS, DAILY_CREATE_LIMITS } from '@wkbd/shared';
import { MapiGateway } from '../../mapi/mapi.gateway';
import { PrismaService } from '../../prisma/prisma.service';

/* ------------------------------------------------------------------
 * 异步报表历史回补（2026-09-29）：
 *
 * 平台实时报表实测只开近 7 天 —— 第 8 天起报 401000「选取起始时间超过允许范围」，
 * 60 天 / 90 天前的数据实时接口根本拿不到。唯一正道是异步任务三件套：
 *   1. POST /v1/async_task/create   创建任务（view_type=1 账户维度，跨度最长 6 个月）
 *   2. POST /v1/async_task/list     轮询状态（0 新建 1 处理中 2 成功 3 失败）
 *   3. GET  /v1/async_task/download 下载 CSV（字段与实时报表同名，日行 stat_hour=0）
 *
 * 限额：异步任务创建 20 次/日（DAILY_CREATE_LIMITS.ASYNC_TASK），自留余量按 18 计。
 * 206 个账户全量补 6 个月约需 12 天滚完，之后每天只补「还不够老」的账户（正常为 0）。
 *
 * CSV 关键坑：
 *   - 「blank content」= 该账户整个区间无投放，此时也应写零行占位（否则每天重复补）；
 *   - 日行 stat_hour 是 0 而不是 -1，落库必须转成 DAILY_HOUR 标记；
 *   - ad_scene 可能出现按投放场景拆分的多行，同一天要先聚合再落库。
 * ------------------------------------------------------------------ */

const TASK_PATH = '/rest/openapi/v1/async_task/create';
const LIST_PATH = '/rest/openapi/v1/async_task/list';
const DOWNLOAD_PATH = '/rest/openapi/v1/async_task/download';

/** 每日创建配额：平台 20 次，自留 2 次余量给人工排障 */
const DAILY_TASK_QUOTA = DAILY_CREATE_LIMITS.ASYNC_TASK - 2;
/** 轮询节奏：3 秒一次，最多 40 次（2 分钟） */
const POLL_INTERVAL_MS = 3_000;
const POLL_MAX_TRIES = 40;

/** CSV 行（日粒度聚合后的原始计数） */
export interface AsyncDailyRow {
  statDate: string;
  charge: number;
  show: number;
  photoClick: number;
  aclick: number;
  bclick: number;
  conversionNum: number;
  activation: number;
  registerCount: number;
  payCount: number;
  payFirstDayCount: number;
}

export interface BackfillResult {
  advertiserId: string;
  ok: boolean;
  /** 覆盖的天数（含零行占位） */
  days?: number;
  /** 有数据的行数（>0 说明区间内有投放） */
  dataDays?: number;
  message?: string;
}

/** 引号感知的 CSV 行解析（"" 转义） */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function toNum(v: string | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

@Injectable()
export class AsyncReportService {
  private readonly logger = new Logger(AsyncReportService.name);
  /** 今日已用任务配额（进程内存计数；重启清零，超限平台会报错兜底） */
  private quotaUsed = 0;
  private quotaDate = '';

  constructor(
    private readonly gateway: MapiGateway,
    private readonly prisma: PrismaService,
  ) {}

  /* ---------------- 配额 ---------------- */

  private todayKey(): string {
    return dayjs().format('YYYY-MM-DD');
  }

  private used(): number {
    if (this.quotaDate !== this.todayKey()) {
      this.quotaDate = this.todayKey();
      this.quotaUsed = 0;
    }
    return this.quotaUsed;
  }

  quotaRemaining(): number {
    return Math.max(0, DAILY_TASK_QUOTA - this.used());
  }

  /* ---------------- 回补执行 ---------------- */

  /**
   * 给单个账户补 [today-days+1, yesterday] 的账户日报（异步任务全流程）。
   * 返回 ok=false 时 message 带原因；blank content（区间无投放）视为成功并写零行。
   */
  async backfillAccount(advertiserId: string, days = ASYNC_BACKFILL_DAYS): Promise<BackfillResult> {
    if (this.quotaRemaining() <= 0) {
      return { advertiserId, ok: false, message: `今日异步任务配额已用完（${DAILY_TASK_QUOTA} 次/日），明天继续` };
    }

    const endDate = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
    const startDate = dayjs().subtract(days - 1, 'day').format('YYYY-MM-DD');

    try {
      // 1. 创建任务（task_name 全账户唯一：带账户号与时间戳）
      const taskName = `wkbd-${advertiserId}-${dayjs().format('YYYYMMDDHHmmss')}`.slice(0, 50);
      const created = await this.gateway.call<{ task_id: number }>({
        advertiserId,
        path: TASK_PATH,
        category: 'query',
        action: 'async_task.create',
        body: {
          advertiser_id: Number(advertiserId) || advertiserId,
          task_name: taskName,
          task_params: {
            start_date: startDate,
            end_date: endDate,
            view_type: 1,
            temporal_granularity: 'DAILY',
          },
        },
      });
      this.quotaUsed = this.used() + 1;
      const taskId = created.task_id;

      // 2. 轮询状态
      let status = 0;
      for (let i = 0; i < POLL_MAX_TRIES; i += 1) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        const list = await this.gateway.call<{ details?: Array<{ task_id: number; task_status: number }> }>({
          advertiserId,
          path: LIST_PATH,
          category: 'query',
          action: 'async_task.list',
          body: { advertiser_id: Number(advertiserId) || advertiserId, task_ids: [taskId] },
        });
        const item = list.details?.find((d) => String(d.task_id) === String(taskId));
        status = item?.task_status ?? 0;
        if (status === 2 || status === 3) break;
      }
      if (status !== 2) {
        return { advertiserId, ok: false, message: status === 3 ? '平台处理任务失败' : '任务超时未完成' };
      }

      // 3. 下载 CSV（responseType=text，网关已处理 token 失效重试）
      const csv = await this.gateway.call<string>({
        advertiserId,
        path: DOWNLOAD_PATH,
        httpMethod: 'GET',
        responseType: 'text',
        category: 'query',
        action: 'async_task.download',
        retry: false,
        body: { advertiser_id: Number(advertiserId) || advertiserId, task_id: taskId },
      });

      // 4. 解析 + 落库
      const { rows, coveredDays } = parseAsyncCsv(csv, startDate, endDate);
      await this.persist(advertiserId, rows, coveredDays);
      this.logger.log(
        `异步回补 ${advertiserId}（${startDate} ~ ${endDate}）：${rows.length} 天有数据 / 共 ${coveredDays.length} 天`,
      );
      return { advertiserId, ok: true, days: coveredDays.length, dataDays: rows.length };
    } catch (err) {
      return { advertiserId, ok: false, message: (err as Error).message };
    }
  }

  /** 落库：ReportDailyStat 日行（statHour=-1），整段替换 + 零行占位 */
  private async persist(advertiserId: string, rows: AsyncDailyRow[], coveredDays: string[]): Promise<void> {
    if (coveredDays.length === 0) return;
    const byDate = new Map(rows.map((r) => [r.statDate, r]));
    const data = coveredDays.map((statDate) => {
      const r = byDate.get(statDate);
      return {
        advertiserId,
        statDate,
        statHour: -1,
        charge: r?.charge ?? 0,
        show: r?.show ?? 0,
        aclick: r?.aclick ?? 0,
        photoClick: r?.photoClick ?? 0,
        bclick: r?.bclick ?? 0,
        conversionNum: r?.conversionNum ?? 0,
        activation: r?.activation ?? 0,
        registerCount: r?.registerCount ?? 0,
        payCount: r?.payCount ?? 0,
        payFirstDayCount: r?.payFirstDayCount ?? 0,
      };
    });
    await this.prisma.$transaction([
      this.prisma.reportDailyStat.deleteMany({
        where: { advertiserId, statHour: -1, statDate: { in: coveredDays } },
      }),
      this.prisma.reportDailyStat.createMany({ data }),
    ]);
  }

  /* ---------------- 进度与批量 ---------------- */

  /** 哪些账户的历史还不够老（日报最早日期晚于目标起点，或一条日报都没有） */
  async pendingAccounts(limit?: number): Promise<Array<{ advertiserId: string; earliestDate: string | null }>> {
    const targetStart = dayjs().subtract(ASYNC_BACKFILL_DAYS - 1, 'day').format('YYYY-MM-DD');
    const accounts = await this.prisma.oauthAccount.findMany({
      where: { status: 'ACTIVE' },
      select: { advertiserId: true },
      orderBy: { advertiserId: 'asc' },
    });
    const stats = await this.prisma.reportDailyStat.groupBy({
      by: ['advertiserId'],
      where: { statHour: -1 },
      _min: { statDate: true },
    });
    const earliestMap = new Map(stats.map((s) => [s.advertiserId, s._min.statDate]));
    const pending = accounts
      .map((a) => ({ advertiserId: a.advertiserId, earliestDate: earliestMap.get(a.advertiserId) ?? null }))
      .filter((a) => !a.earliestDate || a.earliestDate > targetStart);
    return limit ? pending.slice(0, limit) : pending;
  }

  /** 回补进度（meta 接口用） */
  async progress(): Promise<{
    targetDays: number;
    targetStartDate: string;
    done: number;
    total: number;
    quotaUsed: number;
    quotaLimit: number;
  }> {
    const targetStart = dayjs().subtract(ASYNC_BACKFILL_DAYS - 1, 'day').format('YYYY-MM-DD');
    const total = await this.prisma.oauthAccount.count({ where: { status: 'ACTIVE' } });
    const doneRows = await this.prisma.reportDailyStat.groupBy({
      by: ['advertiserId'],
      where: { statHour: -1, statDate: { lte: targetStart } },
    });
    return {
      targetDays: ASYNC_BACKFILL_DAYS,
      targetStartDate: targetStart,
      done: doneRows.length,
      total,
      quotaUsed: this.used(),
      quotaLimit: DAILY_TASK_QUOTA,
    };
  }

  /** 批量补（手动触发 / 定时）：串行执行，逐个吃配额，返回逐账户结果 */
  async backfillBatch(advertiserIds: string[], limit: number): Promise<BackfillResult[]> {
    const ids = advertiserIds.length > 0 ? advertiserIds : (await this.pendingAccounts(limit)).map((a) => a.advertiserId);
    const results: BackfillResult[] = [];
    for (const id of ids.slice(0, limit)) {
      if (this.quotaRemaining() <= 0) {
        results.push({ advertiserId: id, ok: false, message: '今日异步任务配额已用完' });
        continue;
      }
      results.push(await this.backfillAccount(id));
    }
    return results;
  }
}

/** 解析异步任务 CSV → 按日聚合的行 + 覆盖的全部日期（含无投放日，供零行占位） */
export function parseAsyncCsv(
  csv: string,
  startDate: string,
  endDate: string,
): { rows: AsyncDailyRow[]; coveredDays: string[] } {
  const text = (csv ?? '').trim();
  const coveredDays: string[] = [];
  let cur = dayjs(startDate);
  const end = dayjs(endDate);
  while (cur.isBefore(end) || cur.isSame(end, 'day')) {
    coveredDays.push(cur.format('YYYY-MM-DD'));
    cur = cur.add(1, 'day');
  }

  // blank content / 空文件 = 整个区间无投放
  if (!text || !text.startsWith('"')) return { rows: [], coveredDays };

  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return { rows: [], coveredDays };

  const header = parseCsvLine(lines[0]).map((s) => s.trim());
  const col = (name: string) => header.indexOf(name);
  const iDate = col('stat_date');
  const iHour = col('stat_hour');
  if (iDate < 0) return { rows: [], coveredDays };

  const i = {
    charge: col('charge'),
    show: col('show'),
    aclick: col('aclick'),
    photoClick: col('photo_click'),
    bclick: col('bclick'),
    conversionNum: col('conversion_num'),
    activation: col('activation'),
    registerCount: col('event_register'),
    payCount: col('event_pay'),
    payFirstDayCount: col('event_pay_first_day'),
  };

  const byDate = new Map<string, AsyncDailyRow>();
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    const statDate = (cells[iDate] ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(statDate)) continue;
    const hour = iHour >= 0 ? toNum(cells[iHour]) : 0;
    // 只处理日行（DAILY 粒度任务 stat_hour=0；HOURLY 任务会有 0-23 行，按天聚合不会走到这里）
    if (hour !== 0) continue;
    const prev = byDate.get(statDate) ?? {
      statDate,
      charge: 0,
      show: 0,
      photoClick: 0,
      aclick: 0,
      bclick: 0,
      conversionNum: 0,
      activation: 0,
      registerCount: 0,
      payCount: 0,
      payFirstDayCount: 0,
    };
    // ⚠️ 展示数字段口径与实时报表一致：show 用 aclick（素材曝光），show 列是封面曝光仅存档
    prev.charge += toNum(cells[i.charge]);
    prev.show += toNum(cells[i.aclick] ?? cells[i.show]);
    prev.aclick += toNum(cells[i.aclick]);
    prev.photoClick += toNum(cells[i.photoClick]);
    prev.bclick += toNum(cells[i.bclick]);
    prev.conversionNum += toNum(cells[i.conversionNum]);
    prev.activation += toNum(cells[i.activation]);
    prev.registerCount += toNum(cells[i.registerCount]);
    prev.payCount += toNum(cells[i.payCount]);
    prev.payFirstDayCount += toNum(cells[i.payFirstDayCount]);
    byDate.set(statDate, prev);
  }

  // charge 元保留两位
  const rows = [...byDate.values()].map((r) => ({ ...r, charge: Math.round(r.charge * 100) / 100 }));
  return { rows, coveredDays };
}
