import { Injectable, Logger } from '@nestjs/common';
import dayjs from 'dayjs';
import {
  ACCOUNT_STATUS,
  MAPI_PATHS,
  type MaterialAccountRow,
  type MaterialBoardResult,
  type MaterialMetrics,
  type MaterialRow,
  type MaterialSyncResult,
} from '@wkbd/shared';
import { MapiGateway } from '../../mapi/mapi.gateway';
import { PrismaService } from '../../prisma/prisma.service';
import { PlanAssetsService } from '../plan/plan.assets';
import { num, pickArray, str } from '../../common/parse';

/**
 * 素材看板服务。
 *
 * 核心设计（每一条都对应一个硬约束，不是随手写的）：
 *
 * 1. **历史数据落本地永久库**。平台实时素材报表只能查「近 7 天」，
 *    超出窗口的数据再也取不回来。要长期回溯，唯一办法是每天同步并永久累积，
 *    所以本服务只 upsert、从不按时间清理。
 *
 * 2. **同步是「整段替换」而不是逐行 upsert**。同一天的数据在投放推进中
 *    会不断变大（消耗/展示持续累加），逐行 upsert 既慢又容易漏；
 *    先把这个账户该区间的行全部拉全，再一次性删旧插新，语义更干净。
 *    拉取中途失败则直接抛错、不碰库 —— 绝不能出现「删了旧的却没写进新的」。
 *
 * 3. **比率一律从原始计数重算**。平台的 play_3s_ratio / play_end_ratio
 *    是单日比率，跨天平均会失真；区间口径按「播放数（缺失时退回素材曝光数）」
 *    加权，等价于还原成总播放数再相除。
 *
 * 4. **曝光/点击三兄弟必须分清**（2026-09-29 实测 10 个账户后确定，曾把看板算成 473% 点击率）：
 *    - `aclick`      素材曝光数（与 played_num 恒等）→ **看板的「展示数」**，也是点击率与千展的分母
 *    - `bclick`      行为数 → **看板的「点击数」**
 *    - `show`        平台另一个曝光字段（封面曝光），**仅原样存档，不参与看板计算**。
 *      平台自带的 `impression_1k_cost` 是拿它算的（千次封面曝光成本，动辄上千元），
 *      与「消耗 ÷ 展示数 × 1000」对不上，所以不用它。
 *    - `photoClick`  封面点击数（小，如 43），同样仅存档
 *    判据：`bclick / show` 在抽样账户上得到 1.07 / 2.36 / 3.10 这种 >100% 的点击率（不可能），
 *    而 `bclick / aclick` 与平台 `action_ratio` 逐条吻合。
 *
 * 5. **素材名靠视频库回填**。素材报表只回 photo_id / photo_url / photo_caption，
 *    没有素材名；用账户视频库（10 分钟缓存）匹配后写进库里，
 *    这样即使素材后来被删，历史行的名字也还在。
 */

/** 报表类型：5 = 视频报表（必传，否则 401000「报表类型选择错误」） */
const VIEW_TYPE_VIDEO = 5;
/** 官方：page_size 最大 1000 */
const PAGE_SIZE = 1000;
/** 单账户单次最多翻页数（防跑飞；1000 行 × 20 页足够覆盖单账户素材量） */
const MAX_PAGES = 20;
/** 平台实时报表窗口：仅近 7 天可查 */
export const MATERIAL_WINDOW_DAYS = 7;
/** 单次同步最多覆盖的天数（窗口上限） */
const MAX_WINDOW_DAYS = MATERIAL_WINDOW_DAYS;
/** 并发账户数：多账户拉数必须限并发，否则一次打满配额 */
const SYNC_CONCURRENCY = 4;
/** 解析阶段的空名称表：先落数据、拿到实际 photo_id 集合后再精确取名（见 syncAccount） */
const EMPTY_NAMES = new Map<string, string>();

/** 归一化后的单条素材日报 */
interface ParsedRow {
  photoId: string;
  statDate: string;
  materialName: string | null;
  photoUrl: string | null;
  coverUrl: string | null;
  caption: string | null;
  materialType: number | null;
  charge: number;
  /** 封面曝光数（show）—— 千展分母 */
  show: number;
  /** 素材曝光数（aclick）—— 展示数 / 点击率分母 */
  aclick: number;
  photoClick: number;
  bclick: number;
  activation: number;
  registerCount: number;
  conversionNum: number;
  playedNum: number;
  play3sRatio: number;
  playEndRatio: number;
  raw: Record<string, unknown>;
}

@Injectable()
export class MaterialService {
  private readonly logger = new Logger(MaterialService.name);
  /** 同步互斥：定时任务与手动同步不会同时压平台 */
  private syncing = false;

  constructor(
    private readonly gateway: MapiGateway,
    private readonly prisma: PrismaService,
    private readonly assets: PlanAssetsService,
  ) {}

  /* ------------------------------------------------------------------
   * 对外查询
   * ---------------------------------------------------------------- */

  /**
   * 历史数据：读本地永久库，支持任意时间周期。
   * syncFirst=true 时先把「区间内落在平台 7 天窗口里的部分」同步一次，
   * 保证刚打开页面就能看到最新数据（同步失败不阻塞读取）。
   */
  async history(q: {
    advertiserIds: string[];
    startDate: string;
    endDate: string;
    granularity?: 'TOTAL' | 'DAILY';
    syncFirst?: boolean;
  }): Promise<MaterialBoardResult> {
    const ids = await this.resolveAccounts(q.advertiserIds);
    const failures: Array<{ advertiserId: string; message: string }> = [];

    if (q.syncFirst) {
      const window = this.clampToWindow(q.startDate, q.endDate);
      if (window) {
        const r = await this.syncRange(ids, window.start, window.end);
        failures.push(...r.failures);
      }
    }

    return this.readFromDb({
      ids,
      startDate: q.startDate,
      endDate: q.endDate,
      granularity: q.granularity ?? 'TOTAL',
      mode: 'history',
      failures,
    });
  }

  /**
   * 今日数据：取平台实时值。
   * 做法是「先同步当天 → 再读库」—— 读库保证口径与历史数据完全一致，
   * 同步则保证拿到的是实时值；某个账户实时拉取失败时，库里已有的当日数据照常展示。
   */
  async today(q: { advertiserIds: string[] }): Promise<MaterialBoardResult> {
    const ids = await this.resolveAccounts(q.advertiserIds);
    const today = dayjs().format('YYYY-MM-DD');

    const r = await this.syncRange(ids, today, today);
    return this.readFromDb({
      ids,
      startDate: today,
      endDate: today,
      granularity: 'TOTAL',
      mode: 'today',
      failures: r.failures,
    });
  }

  /** 本地库覆盖情况：已积累多少天、最早到哪天（用于提示可回溯范围） */
  async storageInfo(): Promise<{
    rows: number;
    materialCount: number;
    accountCount: number;
    earliestDate: string | null;
    latestDate: string | null;
    storedDays: number;
    windowDays: number;
  }> {
    const [rows, earliest, latest, materials, accounts] = await Promise.all([
      this.prisma.materialDailyStat.count(),
      this.prisma.materialDailyStat.findFirst({ orderBy: { statDate: 'asc' }, select: { statDate: true } }),
      this.prisma.materialDailyStat.findFirst({ orderBy: { statDate: 'desc' }, select: { statDate: true } }),
      this.prisma.materialDailyStat.findMany({ distinct: ['photoId'], select: { photoId: true } }),
      this.prisma.materialDailyStat.findMany({ distinct: ['advertiserId'], select: { advertiserId: true } }),
    ]);
    const earliestDate = earliest?.statDate ?? null;
    const latestDate = latest?.statDate ?? null;
    return {
      rows,
      materialCount: materials.length,
      accountCount: accounts.length,
      earliestDate,
      latestDate,
      storedDays: earliestDate && latestDate ? dayjs(latestDate).diff(dayjs(earliestDate), 'day') + 1 : 0,
      windowDays: MATERIAL_WINDOW_DAYS,
    };
  }

  /* ------------------------------------------------------------------
   * 同步
   * ---------------------------------------------------------------- */

  /**
   * 把指定账户在区间内的素材日报同步到本地（区间会被裁到平台允许的近 7 天）。
   * 供定时任务与手动同步共用。
   */
  async syncRange(
    advertiserIds: string[],
    startDate: string,
    endDate: string,
  ): Promise<MaterialSyncResult> {
    const startedAt = new Date().toISOString();
    const ids = await this.resolveAccounts(advertiserIds);
    const window = this.clampToWindow(startDate, endDate);

    if (!window) {
      return {
        accounts: 0,
        rows: 0,
        failures: [
          {
            advertiserId: '-',
            message: `所选区间不在平台可查范围内（实时素材报表仅支持近 ${MATERIAL_WINDOW_DAYS} 天）`,
          },
        ],
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    }
    if (ids.length === 0) {
      return { accounts: 0, rows: 0, failures: [], startedAt, finishedAt: new Date().toISOString() };
    }
    if (this.syncing) {
      this.logger.warn('已有素材同步在进行中，本次跳过（避免并发压平台）');
      return {
        accounts: 0,
        rows: 0,
        failures: [{ advertiserId: '-', message: '已有同步任务在进行中，请稍后再试' }],
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    }

    this.syncing = true;
    const failures: Array<{ advertiserId: string; message: string }> = [];
    let rowsWritten = 0;
    let done = 0;

    try {
      this.logger.log(
        `素材日报同步开始：${ids.length} 个账户，区间 ${window.start} ~ ${window.end}`,
      );

      const results = await this.mapWithConcurrency(ids, SYNC_CONCURRENCY, async (advertiserId) => {
        try {
          const count = await this.syncAccount(advertiserId, window.start, window.end);
          done += 1;
          return { advertiserId, count };
        } catch (err) {
          failures.push({ advertiserId, message: (err as Error).message });
          return { advertiserId, count: 0 };
        }
      });

      rowsWritten = results.reduce((acc, r) => acc + r.count, 0);
      this.logger.log(
        `素材日报同步完成：${done}/${ids.length} 个账户成功，写入 ${rowsWritten} 行${
          failures.length ? `，失败 ${failures.length} 个` : ''
        }`,
      );
    } finally {
      this.syncing = false;
    }

    return {
      accounts: ids.length,
      rows: rowsWritten,
      failures,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  /** 同步单个账户的区间数据：先拉全，再补充素材名，最后整段替换（中途失败不碰库） */
  private async syncAccount(advertiserId: string, startDate: string, endDate: string): Promise<number> {
    const parsed: ParsedRow[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const data = await this.gateway.call<Record<string, unknown>>({
        advertiserId,
        path: MAPI_PATHS.REPORT_MATERIAL,
        category: 'query',
        body: {
          advertiser_id: Number(advertiserId) || advertiserId,
          start_date: startDate,
          end_date: endDate,
          temporal_granularity: 'DAILY',
          view_type: VIEW_TYPE_VIDEO,
          page,
          page_size: PAGE_SIZE,
        },
        action: 'material.report.sync',
        timeoutMs: 60_000,
      });

      const list = pickArray(data);
      for (const item of list) {
        const row = this.parseRow(item, EMPTY_NAMES);
        if (row) parsed.push(row);
      }
      if (list.length < PAGE_SIZE) break;
    }

    // 素材名：按「本次实际涉及的 photo_id」精确查视频库。
    // 不能用整库列表（那被截断在 500 条，排在后面的素材会大面积取不到名）。
    if (parsed.length > 0) {
      try {
        const nameMap = await this.assets.listVideoNamesByIds(
          advertiserId,
          parsed.map((r) => r.photoId),
        );
        for (const r of parsed) {
          const name = nameMap.get(r.photoId);
          if (name) r.materialName = name;
        }
      } catch (err) {
        this.logger.warn(`账户 ${advertiserId} 素材取名失败，名称留空：${(err as Error).message}`);
      }
    }

    // 整段替换：区间内的旧行全部删掉再写新值（同一天数据会持续增长，必须覆盖）
    await this.prisma.$transaction([
      this.prisma.materialDailyStat.deleteMany({
        where: { advertiserId, statDate: { gte: startDate, lte: endDate } },
      }),
      this.prisma.materialDailyStat.createMany({
        data: parsed.map((r) => ({
          advertiserId,
          photoId: r.photoId,
          statDate: r.statDate,
          materialName: r.materialName,
          photoUrl: r.photoUrl,
          coverUrl: r.coverUrl,
          caption: r.caption,
          materialType: r.materialType,
          charge: r.charge,
          show: r.show,
          aclick: r.aclick,
          photoClick: r.photoClick,
          bclick: r.bclick,
          activation: r.activation,
          registerCount: r.registerCount,
          conversionNum: r.conversionNum,
          playedNum: r.playedNum,
          play3sRatio: r.play3sRatio,
          playEndRatio: r.playEndRatio,
          rawJson: JSON.stringify(r.raw).slice(0, 4000),
        })),
      }),
    ]);

    return parsed.length;
  }

  /* ------------------------------------------------------------------
   * 读库与聚合
   * ---------------------------------------------------------------- */

  private async readFromDb(q: {
    ids: string[];
    startDate: string;
    endDate: string;
    granularity: 'TOTAL' | 'DAILY';
    mode: 'history' | 'today';
    failures: Array<{ advertiserId: string; message: string }>;
  }): Promise<MaterialBoardResult> {
    const nameRows = await this.prisma.oauthAccount.findMany({
      where: { advertiserId: { in: q.ids } },
      select: { advertiserId: true, accountName: true },
    });
    const accountNames = new Map(nameRows.map((a) => [a.advertiserId, a.accountName]));

    const rows =
      q.ids.length === 0
        ? []
        : await this.prisma.materialDailyStat.findMany({
            where: {
              advertiserId: { in: q.ids },
              statDate: { gte: q.startDate, lte: q.endDate },
            },
            orderBy: [{ statDate: 'asc' }],
          });

    // 维度：TOTAL = 素材；DAILY = 素材 × 日期
    const groups = new Map<string, { meta: MaterialRowMeta; byAccount: Map<string, Agg>; agg: Agg }>();

    for (const r of rows) {
      const key = q.granularity === 'DAILY' ? `${r.statDate}|${r.photoId}` : r.photoId;
      let group = groups.get(key);
      if (!group) {
        group = {
          meta: {
            photoId: r.photoId,
            statDate: q.granularity === 'DAILY' ? r.statDate : null,
            materialName: r.materialName,
            photoUrl: r.photoUrl,
            coverUrl: r.coverUrl,
            caption: r.caption,
          },
          byAccount: new Map(),
          agg: emptyAgg(),
        };
        groups.set(key, group);
      }
      // 名称/封面/视频地址以「最近一次有值的行」为准（素材删除后仍保留历史值）
      if (r.materialName) group.meta.materialName = r.materialName;
      if (r.photoUrl) group.meta.photoUrl = r.photoUrl;
      if (r.coverUrl) group.meta.coverUrl = r.coverUrl;
      if (r.caption) group.meta.caption = r.caption;

      accumulate(group.agg, r);
      const accAgg = group.byAccount.get(r.advertiserId) ?? emptyAgg();
      accumulate(accAgg, r);
      group.byAccount.set(r.advertiserId, accAgg);
    }

    const list: MaterialRow[] = [...groups.values()].map((g) => {
      const accounts: MaterialAccountRow[] = [...g.byAccount.entries()]
        .map(([advertiserId, agg]) => ({
          advertiserId,
          accountName: accountNames.get(advertiserId) ?? null,
          ...toMetrics(agg),
        }))
        .sort((a, b) => b.charge - a.charge);

      return {
        photoId: g.meta.photoId,
        statDate: g.meta.statDate,
        materialName: g.meta.materialName,
        photoUrl: g.meta.photoUrl,
        coverUrl: g.meta.coverUrl,
        caption: g.meta.caption,
        accountCount: accounts.length,
        accounts,
        ...toMetrics(g.agg),
      };
    });

    // 默认按消耗从高到低（素材看板第一眼要看的就是「谁在花钱」）
    list.sort((a, b) => b.charge - a.charge);

    const totalAgg = emptyAgg();
    for (const r of rows) accumulate(totalAgg, r);

    const span = await this.storageSpan();

    return {
      mode: q.mode,
      granularity: q.granularity,
      startDate: q.startDate,
      endDate: q.endDate,
      totals: toMetrics(totalAgg),
      rows: list,
      storedDays: span.storedDays,
      earliestDate: span.earliestDate,
      accountCount: q.ids.length,
      failures: q.failures,
      fetchedAt: new Date().toISOString(),
    };
  }

  private async storageSpan(): Promise<{ storedDays: number; earliestDate: string | null }> {
    const [earliest, latest] = await Promise.all([
      this.prisma.materialDailyStat.findFirst({ orderBy: { statDate: 'asc' }, select: { statDate: true } }),
      this.prisma.materialDailyStat.findFirst({ orderBy: { statDate: 'desc' }, select: { statDate: true } }),
    ]);
    const earliestDate = earliest?.statDate ?? null;
    const latestDate = latest?.statDate ?? null;
    return {
      earliestDate,
      storedDays:
        earliestDate && latestDate ? dayjs(latestDate).diff(dayjs(earliestDate), 'day') + 1 : 0,
    };
  }

  /* ------------------------------------------------------------------
   * 内部工具
   * ---------------------------------------------------------------- */

  /** 只同步 ACTIVE 账户；未指定则取全部启用账户 */
  private async resolveAccounts(advertiserIds: string[]): Promise<string[]> {
    if (advertiserIds.length > 0) return [...new Set(advertiserIds)];
    const rows = await this.prisma.oauthAccount.findMany({
      where: { status: ACCOUNT_STATUS.ACTIVE },
      select: { advertiserId: true },
    });
    return rows.map((r) => r.advertiserId);
  }

  /** 把区间裁到平台允许的近 7 天窗口；完全落在窗口外则返回 null */
  private clampToWindow(startDate: string, endDate: string): { start: string; end: string } | null {
    const today = dayjs().startOf('day');
    const minDate = today.subtract(MAX_WINDOW_DAYS - 1, 'day');
    const start = dayjs(startDate).isAfter(minDate) ? dayjs(startDate) : minDate;
    const end = dayjs(endDate).isBefore(today) ? dayjs(endDate) : today;
    if (end.isBefore(start)) return null;
    return { start: start.format('YYYY-MM-DD'), end: end.format('YYYY-MM-DD') };
  }

  private parseRow(item: Record<string, unknown>, nameMap: Map<string, string>): ParsedRow | null {
    const photoId = str(item.photo_id);
    if (!photoId) return null;
    const statDate = str(item.stat_date) || str(item.statDate);
    if (!statDate) return null;

    // 素材名优先取视频库（报表本身不返回名称），报表若带名称则兜底
    const nameFromLibrary = nameMap.get(photoId);
    const nameFromReport = str(item.photo_name);

    return {
      photoId,
      statDate,
      materialName: nameFromLibrary || nameFromReport || null,
      photoUrl: str(item.photo_url) || null,
      coverUrl: str(item.cover_url) || null,
      caption: str(item.photo_caption) || null,
      materialType:
        item.creative_material_type === undefined || item.creative_material_type === null
          ? null
          : num(item.creative_material_type),
      charge: num(item.charge),
      show: num(item.show),
      aclick: num(item.aclick),
      photoClick: num(item.photo_click),
      bclick: num(item.bclick),
      activation: num(item.activation),
      registerCount: num(item.event_register),
      conversionNum: num(item.conversion_num),
      playedNum: num(item.played_num),
      play3sRatio: num(item.play_3s_ratio),
      playEndRatio: num(item.play_end_ratio),
      raw: item,
    };
  }

  private async mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<R>,
  ): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        out[index] = await fn(items[index]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
    return out;
  }
}

interface MaterialRowMeta {
  photoId: string;
  statDate: string | null;
  materialName: string | null;
  photoUrl: string | null;
  coverUrl: string | null;
  caption: string | null;
}

/** 聚合桶：计数直接相加；播放率用加权分子/分母（见文件头说明 3） */
interface Agg {
  charge: number;
  /** 素材曝光数（aclick）—— 输出为「展示数」 */
  impression: number;
  /** 平台 show（封面曝光）—— 仅存档，不参与看板计算 */
  coverShow: number;
  /** 点击数（平台行为数 bclick —— 见 shared/types.ts 里的口径说明） */
  click: number;
  activation: number;
  registerCount: number;
  conversionNum: number;
  /** 播放率权重分母（播放数，缺失时退回素材曝光数） */
  weight: number;
  /** 加权 3s 播放分子 */
  w3: number;
  /** 加权完播分子 */
  wEnd: number;
}

function emptyAgg(): Agg {
  return {
    charge: 0,
    impression: 0,
    coverShow: 0,
    click: 0,
    activation: 0,
    registerCount: 0,
    conversionNum: 0,
    weight: 0,
    w3: 0,
    wEnd: 0,
  };
}

function accumulate(
  agg: Agg,
  r: {
    charge: number;
    show: number;
    aclick: number;
    bclick: number;
    activation: number;
    registerCount: number;
    conversionNum: number;
    playedNum: number;
    play3sRatio: number;
    playEndRatio: number;
  },
): void {
  agg.charge += r.charge;
  agg.impression += r.aclick;
  agg.coverShow += r.show;
  agg.click += r.bclick;
  agg.activation += r.activation;
  agg.registerCount += r.registerCount;
  agg.conversionNum += r.conversionNum;
  const w = r.playedNum > 0 ? r.playedNum : r.aclick;
  agg.weight += w;
  agg.w3 += r.play3sRatio * w;
  agg.wEnd += r.playEndRatio * w;
}

/**
 * 从聚合桶算出最终指标：比率一律用「分子/分母」现算，不做比率平均。
 *
 * 口径（2026-09-29 用 10 个账户的真实数据比对后确定）：
 *   展示数     = aclick（素材曝光数，恒等于 played_num）
 *   点击数     = bclick（行为数）
 *   点击率     = bclick / aclick   ← 与平台 action_ratio 完全一致
 *   千展       = charge / aclick × 1000
 *   激活/注册/转化率分母 = bclick
 *
 * ⚠️ 为什么不用平台自带的 impression_1k_cost / 用 show 当分母：
 *   `bclick / show` 在抽样账户上算出 1.07 / 2.36 / 3.10 这种 >100% 的点击率，
 *   显然不可能；而 `bclick / aclick` 与平台 action_ratio 逐一吻合。
 *   平台自带的 impression_1k_cost 是按 show（封面曝光）算的，数值高达 2310 元/千次，
 *   与「消耗 ÷ 展示数 × 1000」对不上 —— 本看板要求四列能互相验算，故统一走 aclick。
 */
function toMetrics(agg: Agg): MaterialMetrics {
  const charge = round2(agg.charge);
  return {
    charge,
    show: agg.impression,
    click: agg.click,
    activation: agg.activation,
    registerCount: agg.registerCount,
    conversionNum: agg.conversionNum,
    impression1kCost: agg.impression > 0 ? round2((agg.charge / agg.impression) * 1000) : 0,
    clickRatio: ratio(agg.click, agg.impression),
    // 激活率 / 注册率 / 转化率：统一以「点击数（行为数）」为分母
    activationRatio: ratio(agg.activation, agg.click),
    registerRatio: ratio(agg.registerCount, agg.click),
    conversionRatio: ratio(agg.conversionNum, agg.click),
    play3sRatio: agg.weight > 0 ? round4(agg.w3 / agg.weight) : 0,
    playEndRatio: agg.weight > 0 ? round4(agg.wEnd / agg.weight) : 0,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return round4(numerator / denominator);
}
