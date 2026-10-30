import { Injectable, Logger } from '@nestjs/common';
import dayjs from 'dayjs';
import {
  MAPI_PATHS,
  MAX_PAGE_SIZE,
  REALTIME_REPORT_LOOKBACK_DAYS,
  ReportPage,
} from '@wkbd/shared';
import { MapiGateway } from '../../mapi/mapi.gateway';
import { PrismaService } from '../../prisma/prisma.service';
import { chunk, num, pickArray, pickTotal, str } from '../../common/parse';
import { toIdArray } from '../../common/id';

/** 报表层级 */
export type ReportLevel = 'account' | 'campaign' | 'unit' | 'creative' | 'material';

const REPORT_PATH: Record<ReportLevel, string> = {
  account: MAPI_PATHS.REPORT_ACCOUNT,
  campaign: MAPI_PATHS.REPORT_CAMPAIGN,
  unit: MAPI_PATHS.REPORT_UNIT,
  creative: MAPI_PATHS.REPORT_CREATIVE,
  // 素材维度报表：返回行带 photo_id，用于按素材聚合消耗
  material: MAPI_PATHS.REPORT_MATERIAL,
};

export interface ReportQuery {
  advertiserId: string;
  /** yyyy-MM-dd */
  startDate: string;
  endDate: string;
  granularity?: 'DAILY' | 'HOURLY';
  campaignIds?: string[];
  unitIds?: string[];
  creativeIds?: string[];
  page?: number;
  pageSize?: number;
  /** 素材报表专用：报表类型 5 视频报表 / 7 封面报表 / 8 便利贴报表，默认 5 */
  view_type?: number;
}

/** 标准化后的指标行 */
export interface MetricRow {
  advertiserId: string;
  statDate: string | null;
  statHour: number | null;
  campaignId: string | null;
  unitId: string | null;
  creativeId: string | null;
  /** 素材维度报表才有：视频 photo_id */
  photoId: string | null;
  /** 花费（元） */
  charge: number;
  /** 展示数（= 素材曝光数 aclick，不是平台字段 show） */
  show: number;
  /** 封面点击数（平台 photo_click） */
  photoClick: number;
  /** 素材曝光数（平台 aclick，与 show 同值，保留以便与平台字段对照） */
  aclick: number;
  /** 行为数（平台 bclick，即看板的「点击数」） */
  bclick: number;
  photoClickRatio: number;
  playedNum: number;
  play3sRatio: number;
  /** 行为率 = bclick / 展示数（与平台 action_ratio 口径一致） */
  actionRatio: number;
  /** 千展（元）= 消耗 / 展示数 × 1000 */
  impression1kCost: number;
  /** 平均点击单价（元） */
  photoClickCost: number;
  /** 平均行为单价（元） */
  actionCost: number;
  /* ——— 核心转化指标（盯盘看板）——— */
  /** 转化数（平台口径 conversion_num） */
  conversionNum: number;
  /** 转化率（平台字段 conversion_ratio） */
  conversionRatio: number;
  /** 激活数 */
  activation: number;
  /** 激活成本 = 消耗 / 激活数（平台无现成字段，自行计算） */
  activationCost: number;
  /** 注册数（event_register） */
  registerCount: number;
  /** 注册成本（event_register_cost，缺失时按消耗/注册数计算） */
  registerCost: number;
  /** 付费次数（event_pay） */
  payCount: number;
  /** 付费成本（event_pay_cost，缺失时按消耗/付费次数计算） */
  payCost: number;
  /** 首日付费次数（event_pay_first_day） */
  payFirstDayCount: number;
  /** 首日付费成本 = 消耗 / 首日付费次数（平台无现成字段，自行计算） */
  payFirstDayCost: number;
  raw: Record<string, unknown>;
}

export interface OverviewResult {
  totals: Omit<MetricRow, 'advertiserId' | 'statDate' | 'statHour' | 'campaignId' | 'unitId' | 'creativeId' | 'photoId' | 'raw'>;
  accounts: Array<{
    advertiserId: string;
    accountName: string | null;
    charge: number;
    show: number;
    impression1kCost: number;
    photoClickRatio: number;
    conversionRatio: number;
    activation: number;
    activationCost: number;
    registerCount: number;
    registerCost: number;
    payCount: number;
    payCost: number;
    payFirstDayCount: number;
    payFirstDayCost: number;
    /** 本地缺失的历史天数（超出平台 7 天窗口、工作台又没运行过的日期） */
    missingDays: number;
    error?: string;
  }>;
  /** 按天聚合的原始计数（多账户合计；比率/成本前端现算）—— 多天区间的走势图数据源 */
  daily: Array<{
    statDate: string;
    charge: number;
    show: number;
    bclick: number;
    conversionNum: number;
    activation: number;
    registerCount: number;
    payCount: number;
    payFirstDayCount: number;
  }>;
  fetchedAt: string;
  range: { startDate: string; endDate: string; granularity: 'DAILY' | 'HOURLY' };
}

/* ------------------------------------------------------------------
 * 历史留存（2026-09-29）：
 * 平台实时报表只能查近 7 天（T-1 数据次日 09:00 定稿），要「取消 7 天限制」
 * 唯一办法是每天把账户日报落到本地 ReportDailyStat 并永久累积。
 *
 * 读取策略（overview）：
 *   区间整体落在过去 → 全读本地；
 *   区间包含今天     → 过去部分读本地 + 今天部分实时查（并把实时结果顺手落库）；
 *   本地缺某天且该天还在平台 7 天窗口内 → 自动回补一次并落库。
 *   回补后仍无数据的日期写「零行」占位 —— 否则无投放的日期会每次都被当成缺失反复回补。
 * ------------------------------------------------------------------ */

/** 原始计数累加器：比率一律「分子/分母」现算 */
interface Acc {
  charge: number;
  show: number;
  aclick: number;
  photoClick: number;
  bclick: number;
  conversionNum: number;
  activation: number;
  registerCount: number;
  payCount: number;
  payFirstDayCount: number;
}

function emptyAcc(): Acc {
  return { charge: 0, show: 0, aclick: 0, photoClick: 0, bclick: 0, conversionNum: 0, activation: 0, registerCount: 0, payCount: 0, payFirstDayCount: 0 };
}

function addToAcc(acc: Acc, r: { charge: number; show: number; aclick: number; photoClick: number; bclick: number; conversionNum: number; activation: number; registerCount: number; payCount: number; payFirstDayCount: number }): void {
  acc.charge += r.charge;
  acc.show += r.show;
  acc.aclick += r.aclick;
  acc.photoClick += r.photoClick;
  acc.bclick += r.bclick;
  acc.conversionNum += r.conversionNum;
  acc.activation += r.activation;
  acc.registerCount += r.registerCount;
  acc.payCount += r.payCount;
  acc.payFirstDayCount += r.payFirstDayCount;
}

/** 列出 [start, end] 内所有日期（含端点） */
function eachDay(startDate: string, endDate: string): string[] {
  const out: string[] = [];
  let cur = dayjs(startDate);
  const end = dayjs(endDate);
  while (cur.isBefore(end) || cur.isSame(end, 'day')) {
    out.push(cur.format('YYYY-MM-DD'));
    cur = cur.add(1, 'day');
  }
  return out;
}

/** 日行在库里的 statHour 标记（-1 而不是 NULL：SQLite 唯一索引对 NULL 不去重） */
const DAILY_HOUR = -1;

@Injectable()
export class ReportService {
  private readonly logger = new Logger(ReportService.name);

  constructor(
    private readonly gateway: MapiGateway,
    private readonly prisma: PrismaService,
  ) {}

  /* ------------------------------------------------------------------
   * 单账户单层级查询
   * ---------------------------------------------------------------- */

  async query(level: ReportLevel, q: ReportQuery): Promise<ReportPage<MetricRow>> {
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(Math.max(1, q.pageSize ?? 200), MAX_PAGE_SIZE);

    this.assertRange(q.startDate, q.endDate, level);

    const body: Record<string, unknown> = {
      advertiser_id: Number(q.advertiserId) || q.advertiserId,
      start_date: q.startDate,
      end_date: q.endDate,
      temporal_granularity: q.granularity ?? 'DAILY',
      page,
      page_size: pageSize,
    };

    if (q.campaignIds?.length) body.campaign_ids = toIdArray(q.campaignIds);
    if (q.unitIds?.length) body.unit_ids = toIdArray(q.unitIds);
    if (q.creativeIds?.length) body.creative_ids = toIdArray(q.creativeIds);
    // 素材报表必填：不传会报 401000「报表类型选择错误」。5 = 快手视频报表
    if (level === 'material') body.view_type = q.view_type ?? 5;

    const data = await this.gateway.call<Record<string, unknown>>({
      advertiserId: q.advertiserId,
      path: REPORT_PATH[level],
      category: 'query',
      action: `report.${level}`,
      body,
    });

    const rows = pickArray(data).map((r) => this.normalizeRow(r, q.advertiserId));

    return {
      totalCount: pickTotal(data, rows.length),
      page,
      pageSize,
      rows,
    };
  }

  /** 大 ID 列表查询：自动按 5000 分片，规避平台单次查询上限 */
  async queryByIds(
    level: ReportLevel,
    q: ReportQuery & { ids: string[] },
  ): Promise<ReportPage<MetricRow>> {
    if (q.ids.length === 0) {
      return { totalCount: 0, page: 1, pageSize: 0, rows: [] };
    }

    const batches = chunk(q.ids, 5000);
    const all: MetricRow[] = [];

    for (const batch of batches) {
      const scoped: ReportQuery = { ...q };
      if (level === 'campaign') scoped.campaignIds = batch;
      else if (level === 'unit') scoped.unitIds = batch;
      else if (level === 'creative') scoped.creativeIds = batch;

      const pageResult = await this.query(level, { ...scoped, page: 1, pageSize: MAX_PAGE_SIZE });
      all.push(...pageResult.rows);
    }

    return { totalCount: all.length, page: 1, pageSize: all.length, rows: all };
  }

  /* ------------------------------------------------------------------
   * 多账户总览（盯盘首页）
   * ---------------------------------------------------------------- */

  async overview(
    advertiserIds: string[],
    startDate: string,
    endDate: string,
    granularity: 'DAILY' | 'HOURLY' = 'DAILY',
    concurrency = 4,
  ): Promise<OverviewResult> {
    const acctRows = await this.prisma.oauthAccount.findMany({
      where: { advertiserId: { in: advertiserIds } },
      select: { advertiserId: true, accountName: true },
    });
    const nameMap = new Map(acctRows.map((a) => [a.advertiserId, a.accountName]));

    // 拆区间：过去部分读本地库，今天部分实时查
    const today = dayjs().format('YYYY-MM-DD');
    const yesterday = dayjs(today).subtract(1, 'day').format('YYYY-MM-DD');
    const histEnd = dayjs(endDate).isBefore(dayjs(today)) ? endDate : yesterday;
    const hasHist = dayjs(startDate).isBefore(dayjs(histEnd)) || startDate === histEnd;
    const liveStart = dayjs(startDate).isAfter(dayjs(today)) ? startDate : today;
    const hasLive = dayjs(liveStart).isBefore(dayjs(endDate)) || liveStart === endDate;
    // 平台实时报表可查的最早日期（回补只在这个窗口内尝试）
    const minLiveDate = dayjs()
      .subtract(REALTIME_REPORT_LOOKBACK_DAYS - 1, 'day')
      .startOf('day')
      .format('YYYY-MM-DD');

    const results = await this.mapWithConcurrency(
      advertiserIds,
      concurrency,
      async (advertiserId) => {
        const base = { advertiserId, accountName: nameMap.get(advertiserId) ?? null };
        try {
          const acc = emptyAcc();
          let missingDays = 0;
          /** 按天聚合的日行（本账户），供外层汇总出 daily 走势 */
          const dayAcc = new Map<string, Acc>();
          const bumpDay = (statDate: string | null | undefined, row: Parameters<typeof addToAcc>[1]) => {
            if (!statDate) return;
            const b = dayAcc.get(statDate) ?? emptyAcc();
            addToAcc(b, row);
            dayAcc.set(statDate, b);
          };

          // —— 过去部分：本地日报（缺失自动回补）——
          if (hasHist) {
            let local = await this.localDaily(advertiserId, startDate, histEnd);
            const have = new Set(local.map((r) => r.statDate));
            const allDays = eachDay(startDate, histEnd);
            const missing = allDays.filter((d) => !have.has(d));
            if (missing.length > 0 && missing[0] >= minLiveDate) {
              // 回补一次：从最早的缺失日到区间末尾，整段查平台并落库
              // （整段替换，已同步过的日期也会被刷新，顺带覆盖 T-1 次日定稿的修正）
              const page = await this.query('account', {
                advertiserId,
                startDate: missing[0],
                endDate: histEnd,
                granularity: 'DAILY',
                page: 1,
                pageSize: MAX_PAGE_SIZE,
              });
              await this.persistAccountDaily(advertiserId, page.rows, eachDay(missing[0], histEnd));
              local = await this.localDaily(advertiserId, startDate, histEnd);
            }
            for (const r of local) {
              addToAcc(acc, r);
              bumpDay(r.statDate, r);
            }
            missingDays = allDays.length - local.length;
          }

          // —— 今天部分：实时查，并把结果落库（今日数据随时在涨，每次都现查）——
          if (hasLive) {
            const page = await this.query('account', {
              advertiserId,
              startDate: liveStart,
              endDate,
              granularity,
              page: 1,
              pageSize: MAX_PAGE_SIZE,
            });
            if (granularity === 'DAILY') {
              await this.persistAccountDaily(advertiserId, page.rows, eachDay(liveStart, endDate));
            } else {
              await this.persistAccountHourly(advertiserId, liveStart, page.rows);
            }
            for (const r of page.rows) {
              addToAcc(acc, r);
              bumpDay(r.statDate ?? liveStart, r);
            }
          }

          return { ...base, acc, missingDays, dayAcc };
        } catch (err) {
          this.logger.warn(`账户 ${advertiserId} 报表拉取失败：${(err as Error).message}`);
          return {
            ...base,
            acc: null as Acc | null,
            missingDays: 0,
            dayAcc: null as Map<string, Acc> | null,
            error: (err as Error).message,
          };
        }
      },
    );

    // 账户行只暴露核心指标；总合计用原始计数重新计算，避免对比率做算术平均
    const accounts = results.map((r) => {
      const base = {
        advertiserId: r.advertiserId,
        accountName: r.accountName,
      };
      if (!r.acc) {
        return { ...base, charge: 0, show: 0, impression1kCost: 0, photoClickRatio: 0, actionRatio: 0, conversionRatio: 0, activation: 0, activationCost: 0, registerCount: 0, registerCost: 0, payCount: 0, payCost: 0, payFirstDayCount: 0, payFirstDayCost: 0, missingDays: 0, error: (r as { error?: string }).error };
      }
      const s = this.deriveSummary(r.acc);
      return {
        ...base,
        charge: s.charge,
        show: s.show,
        impression1kCost: s.impression1kCost,
        photoClickRatio: s.photoClickRatio,
        actionRatio: s.actionRatio,
        conversionRatio: s.conversionRatio,
        activation: s.activation,
        activationCost: s.activationCost,
        registerCount: s.registerCount,
        registerCost: s.registerCost,
        payCount: s.payCount,
        payCost: s.payCost,
        payFirstDayCount: s.payFirstDayCount,
        payFirstDayCost: s.payFirstDayCost,
        missingDays: r.missingDays,
      };
    });

    const totals = results.reduce(
      (acc, r) => {
        if (r.acc) addToAcc(acc, r.acc);
        return acc;
      },
      emptyAcc(),
    );

    const t = this.deriveSummary(totals);

    // 多账户按天汇总走势（过去=本地日行 + 今天=实时行），按日期升序
    const dailyMap = new Map<string, Acc>();
    for (const r of results) {
      if (!r.dayAcc) continue;
      for (const [d, b] of r.dayAcc) {
        const agg = dailyMap.get(d) ?? emptyAcc();
        addToAcc(agg, b);
        dailyMap.set(d, agg);
      }
    }
    const daily = [...dailyMap.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([statDate, b]) => ({
        statDate,
        charge: round2(b.charge),
        show: b.aclick,
        bclick: b.bclick,
        conversionNum: b.conversionNum,
        activation: b.activation,
        registerCount: b.registerCount,
        payCount: b.payCount,
        payFirstDayCount: b.payFirstDayCount,
      }));

    return {
      totals: {
        charge: t.charge,
        show: t.show,
        photoClick: t.photoClick,
        aclick: t.aclick,
        bclick: t.bclick,
        photoClickRatio: t.photoClickRatio,
        playedNum: 0,
        play3sRatio: 0,
        actionRatio: t.actionRatio,
        impression1kCost: t.impression1kCost,
        photoClickCost: t.photoClickCost,
        actionCost: t.actionCost,
        conversionNum: t.conversionNum,
        conversionRatio: t.conversionRatio,
        activation: t.activation,
        activationCost: t.activationCost,
        registerCount: t.registerCount,
        registerCost: t.registerCost,
        payCount: t.payCount,
        payCost: t.payCost,
        payFirstDayCount: t.payFirstDayCount,
        payFirstDayCost: t.payFirstDayCost,
      },
      accounts,
      daily,
      fetchedAt: new Date().toISOString(),
      range: { startDate, endDate, granularity },
    };
  }

  /**
   * 小时趋势：多账户按小时聚合，用于看板折线图（返回原始计数，比率/成本由前端现算）。
   *
   * 今天     → 实时查（顺手把小时行落库）；
   * 过去某天 → 读本地小时行。小时行只有「工作台当天在运行」时才会被收集
   *            （实时看板访问 / 每小时定时任务），没收集到的日期返回全 0，前端自动隐藏图。
   */
  async hourlyTrend(advertiserIds: string[], date: string) {
    const today = dayjs().format('YYYY-MM-DD');

    interface Bucket {
      charge: number;
      show: number;
      aclick: number;
      photoClick: number;
      bclick: number;
      conversionNum: number;
      activation: number;
      registerCount: number;
      payCount: number;
      payFirstDayCount: number;
    }
    const emptyBucket = (): Bucket => ({
      charge: 0,
      show: 0,
      aclick: 0,
      photoClick: 0,
      bclick: 0,
      conversionNum: 0,
      activation: 0,
      registerCount: 0,
      payCount: 0,
      payFirstDayCount: 0,
    });
    const buckets = new Map<number, Bucket>();

    if (dayjs(date).isBefore(dayjs(today))) {
      // —— 过去：本地小时行 ——
      const rows = await this.prisma.reportDailyStat.findMany({
        where: { advertiserId: { in: advertiserIds }, statDate: date, statHour: { gte: 0 } },
      });
      for (const r of rows) {
        const bucket = buckets.get(r.statHour) ?? emptyBucket();
        bucket.charge += r.charge;
        bucket.show += r.show;
        bucket.aclick += r.aclick;
        bucket.photoClick += r.photoClick;
        bucket.bclick += r.bclick;
        bucket.conversionNum += r.conversionNum;
        bucket.activation += r.activation;
        bucket.registerCount += r.registerCount;
        bucket.payCount += r.payCount;
        bucket.payFirstDayCount += r.payFirstDayCount;
        buckets.set(r.statHour, bucket);
      }
    } else {
      // —— 今天：实时查 + 落库 ——
      const results = await this.mapWithConcurrency(advertiserIds, 4, async (advertiserId) => {
        try {
          const page = await this.query('account', {
            advertiserId,
            startDate: date,
            endDate: date,
            granularity: 'HOURLY',
            page: 1,
            pageSize: MAX_PAGE_SIZE,
          });
          await this.persistAccountHourly(advertiserId, date, page.rows);
          return page.rows;
        } catch {
          return [] as MetricRow[];
        }
      });

      for (const rows of results) {
        for (const row of rows) {
          const hour = row.statHour ?? 0;
          const bucket = buckets.get(hour) ?? emptyBucket();
          bucket.charge += row.charge;
          bucket.show += row.show;
          bucket.aclick += row.aclick;
          bucket.photoClick += row.photoClick;
          bucket.bclick += row.bclick;
          bucket.conversionNum += row.conversionNum;
          bucket.activation += row.activation;
          bucket.registerCount += row.registerCount;
          bucket.payCount += row.payCount;
          bucket.payFirstDayCount += row.payFirstDayCount;
          buckets.set(hour, bucket);
        }
      }
    }

    return Array.from({ length: 24 }, (_, hour) => {
      const b = buckets.get(hour) ?? emptyBucket();
      return {
        hour,
        charge: round2(b.charge),
        show: b.aclick,
        photoClick: b.photoClick,
        bclick: b.bclick,
        conversionNum: b.conversionNum,
        activation: b.activation,
        registerCount: b.registerCount,
        payCount: b.payCount,
        payFirstDayCount: b.payFirstDayCount,
        photoClickCost: b.photoClick > 0 ? round2(b.charge / b.photoClick) : 0,
      };
    });
  }

  /* ------------------------------------------------------------------
   * 本地历史库读写
   * ---------------------------------------------------------------- */

  /** 读某账户区间的日行（statHour = -1） */
  private async localDaily(advertiserId: string, startDate: string, endDate: string) {
    return this.prisma.reportDailyStat.findMany({
      where: { advertiserId, statDate: { gte: startDate, lte: endDate }, statHour: DAILY_HOUR },
      orderBy: { statDate: 'asc' },
    });
  }

  /**
   * 把账户日报落库：先删后建（整段替换），中途中败不碰库。
   * rangeDates 给出「这次查询覆盖了哪些日期」—— 平台对无投放的日期不返回行，
   * 这些日期写零行占位，避免每次查询都把它们当成缺失反复回补。
   */
  private async persistAccountDaily(
    advertiserId: string,
    rows: MetricRow[],
    rangeDates?: string[],
  ): Promise<void> {
    const byDate = new Map<string, MetricRow>();
    for (const r of rows) {
      if (!r.statDate) continue;
      const prev = byDate.get(r.statDate);
      if (prev) addToAcc(prev as unknown as Acc, r);
      else byDate.set(r.statDate, r);
    }
    const dates = rangeDates ?? [...byDate.keys()];
    if (dates.length === 0) return;
    const data = dates.map((statDate) => {
      const r = byDate.get(statDate);
      return {
        advertiserId,
        statDate,
        statHour: DAILY_HOUR,
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
        where: { advertiserId, statHour: DAILY_HOUR, statDate: { in: dates } },
      }),
      this.prisma.reportDailyStat.createMany({ data }),
    ]);
  }

  /** 把某天的小时行落库（删旧建新） */
  private async persistAccountHourly(
    advertiserId: string,
    date: string,
    rows: MetricRow[],
  ): Promise<void> {
    const data = rows
      .filter((r) => r.statHour !== null && r.statHour >= 0)
      .map((r) => ({
        advertiserId,
        statDate: date,
        statHour: r.statHour as number,
        charge: r.charge,
        show: r.show,
        aclick: r.aclick,
        photoClick: r.photoClick,
        bclick: r.bclick,
        conversionNum: r.conversionNum,
        activation: r.activation,
        registerCount: r.registerCount,
        payCount: r.payCount,
        payFirstDayCount: r.payFirstDayCount,
      }));
    await this.prisma.$transaction([
      this.prisma.reportDailyStat.deleteMany({
        where: { advertiserId, statDate: date, statHour: { gte: 0 } },
      }),
      this.prisma.reportDailyStat.createMany({ data }),
    ]);
  }

  /* ------------------------------------------------------------------
   * 定时同步（ReportSyncScheduler 调用）
   * ---------------------------------------------------------------- */

  /**
   * 把区间内的账户日报拉平到本地库。
   * advertiserIds 为空 = 全部 ACTIVE 账户；granularity=HOURLY 时只同步单日，
   * 并把小时行汇总成当天的日行（免得同一份数据打两次平台接口）。
   */
  async syncHistory(
    advertiserIds: string[],
    startDate: string,
    endDate: string,
    granularity: 'DAILY' | 'HOURLY' = 'DAILY',
  ): Promise<{ accounts: number; failures: string[] }> {
    const ids =
      advertiserIds.length > 0
        ? [...new Set(advertiserIds)]
        : await this.prisma.oauthAccount
            .findMany({ where: { status: 'ACTIVE' }, select: { advertiserId: true } })
            .then((rows) => rows.map((r) => r.advertiserId));
    const failures: string[] = [];

    await this.mapWithConcurrency(ids, 4, async (advertiserId) => {
      try {
        const page = await this.query('account', {
          advertiserId,
          startDate,
          endDate,
          granularity,
          page: 1,
          pageSize: MAX_PAGE_SIZE,
        });
        if (granularity === 'DAILY') {
          await this.persistAccountDaily(advertiserId, page.rows, eachDay(startDate, endDate));
        } else {
          await this.persistAccountHourly(advertiserId, startDate, page.rows);
          // 小时行汇总 → 当天日行（实时报表的小时行合计 = 日报，省一次接口调用）
          const day = emptyAcc();
          for (const r of page.rows) addToAcc(day, r);
          const synthetic = { ...day, statDate: startDate } as unknown as MetricRow;
          await this.persistAccountDaily(advertiserId, [synthetic], [startDate]);
        }
      } catch (err) {
        failures.push(`${advertiserId}：${(err as Error).message}`);
      }
    });
    return { accounts: ids.length, failures };
  }

  /** 本地历史覆盖范围（meta 接口用：前端日期选择器的可回溯边界） */
  async storageSpan(): Promise<{
    earliestDate: string | null;
    latestDate: string | null;
    storedDays: number;
    rows: number;
  }> {
    const rows = await this.prisma.reportDailyStat.findMany({
      where: { statHour: DAILY_HOUR },
      distinct: ['statDate'],
      select: { statDate: true },
      orderBy: { statDate: 'asc' },
    });
    const dates = rows.map((r) => r.statDate);
    const earliestDate = dates[0] ?? null;
    const latestDate = dates[dates.length - 1] ?? null;
    return {
      earliestDate,
      latestDate,
      storedDays:
        earliestDate && latestDate
          ? dayjs(latestDate).diff(dayjs(earliestDate), 'day') + 1
          : 0,
      rows: dates.length,
    };
  }

  /* ------------------------------------------------------------------
   * 内部工具
   * ---------------------------------------------------------------- */

  /** 实时报表只能查近 7 日，越界直接拦掉，避免无意义的接口调用 */
  private assertRange(startDate: string, endDate: string, level?: ReportLevel): void {
    if (dayjs(endDate).isBefore(dayjs(startDate))) {
      throw new Error('结束日期不能早于开始日期');
    }
    // 素材报表的日期边界与实时报表族不同，交由平台裁决，本地不拦（失败会带平台错误信息返回）
    if (level === 'material') return;
    const minDate = dayjs().subtract(REALTIME_REPORT_LOOKBACK_DAYS - 1, 'day').startOf('day');
    if (dayjs(startDate).isBefore(minDate)) {
      throw new Error(
        `实时报表仅支持查询近 ${REALTIME_REPORT_LOOKBACK_DAYS} 天（最早 ${minDate.format('YYYY-MM-DD')}）。更早数据需使用异步报表。`,
      );
    }
  }

  private normalizeRow(raw: Record<string, unknown>, advertiserId: string): MetricRow {
    const row: MetricRow = {
      advertiserId,
      statDate: raw.stat_date ? str(raw.stat_date) : null,
      statHour: raw.stat_hour === undefined || raw.stat_hour === null ? null : num(raw.stat_hour),
      campaignId: raw.campaign_id ? str(raw.campaign_id) : null,
      unitId: raw.unit_id ? str(raw.unit_id) : null,
      creativeId: raw.creative_id ? str(raw.creative_id) : null,
      photoId: raw.photo_id ? str(raw.photo_id) : null,
      charge: num(raw.charge),
      // ⚠️ 展示数取「素材曝光数 aclick」，不是平台字段 show（show 是封面曝光数）。
      // 依据官方字段字典（2026-09-29 核实）：
      //   show = 封面曝光数、aclick = 素材曝光数、bclick = 行为数、
      //   action_ratio(行为率) = bclick / aclick、impression_1k_cost = 平均千次【封面】曝光花费。
      // 实测同一账户 show=891 而 aclick=160398，拿 show 当分母会算出 135% 的点击率。
      show: num(raw.aclick),
      photoClick: num(raw.photo_click),
      aclick: num(raw.aclick),
      bclick: num(raw.bclick),
      photoClickRatio: num(raw.photo_click_ratio),
      playedNum: num(raw.played_num),
      play3sRatio: num(raw.play_3s_ratio),
      actionRatio: 0,
      impression1kCost: 0,
      photoClickCost: num(raw.photo_click_cost),
      actionCost: num(raw.action_cost),
      conversionNum: num(raw.conversion_num),
      conversionRatio: num(raw.conversion_ratio),
      activation: num(raw.activation),
      activationCost: 0,
      registerCount: num(raw.event_register),
      registerCost: num(raw.event_register_cost),
      payCount: num(raw.event_pay),
      payCost: num(raw.event_pay_cost),
      payFirstDayCount: num(raw.event_pay_first_day),
      payFirstDayCost: 0,
      raw,
    };
    // 平台没有现成的激活成本 / 首日付费成本字段，按 消耗/次数 计算；
    // 注册成本 / 付费成本平台字段为 0 时同样兜底现算
    row.activationCost = divCost(row.charge, row.activation);
    if (row.registerCost <= 0) row.registerCost = divCost(row.charge, row.registerCount);
    if (row.payCost <= 0) row.payCost = divCost(row.charge, row.payCount);
    row.payFirstDayCost = divCost(row.charge, row.payFirstDayCount);
    // 行为率 / 千展：都以「展示数（素材曝光）」为分母，保证与本行的消耗、展示数能互相验算。
    // 不直接取平台的 action_ratio / impression_1k_cost —— 前者口径一致但后者基于封面曝光，
    // 取进来会出现「消耗/展示数×1000 ≠ 千展」的自相矛盾。
    row.actionRatio = ratio(row.bclick, row.show);
    row.impression1kCost = row.show > 0 ? round2((row.charge / row.show) * 1000) : 0;
    return row;
  }

  /**
   * 从原始计数算出所有派生指标。
   * 展示数统一用「素材曝光数 aclick」：它才恒等于播放数，
   * 是「消耗/展示数×1000=千展」「bclick/展示数=点击率」的共同分母。
   * show（封面曝光）只用于封面点击率，两者差一两个数量级，混用会算出 135% 的点击率。
   */
  private deriveSummary(acc: Acc) {
    const exposure = acc.aclick;
    return {
      charge: round2(acc.charge),
      show: exposure,
      photoClick: acc.photoClick,
      aclick: exposure,
      bclick: acc.bclick,
      photoClickRatio: ratio(acc.photoClick, acc.show),
      playedNum: 0,
      play3sRatio: 0,
      actionRatio: ratio(acc.bclick, exposure),
      impression1kCost: exposure > 0 ? round2((acc.charge / exposure) * 1000) : 0,
      photoClickCost: acc.photoClick > 0 ? round2(acc.charge / acc.photoClick) : 0,
      actionCost: acc.bclick > 0 ? round2(acc.charge / acc.bclick) : 0,
      conversionNum: acc.conversionNum,
      conversionRatio: ratio(acc.conversionNum, acc.bclick),
      activation: acc.activation,
      activationCost: divCost(acc.charge, acc.activation),
      registerCount: acc.registerCount,
      registerCost: divCost(acc.charge, acc.registerCount),
      payCount: acc.payCount,
      payCost: divCost(acc.charge, acc.payCount),
      payFirstDayCount: acc.payFirstDayCount,
      payFirstDayCost: divCost(acc.charge, acc.payFirstDayCount),
    };
  }

  /** 固定并发的 map。多账户拉数必须限并发，否则一次性打满配额 */
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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 10000) / 10000;
}

/** 成本 = 消耗 / 次数；次数为 0 时返回 0（前端显示为 —） */
function divCost(charge: number, count: number): number {
  if (count <= 0) return 0;
  return round2(charge / count);
}
