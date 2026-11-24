import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { MAX_PAGE_SIZE, REALTIME_REPORT_LOOKBACK_DAYS } from '@wkbd/shared';
import { PlanAssetsService } from '../plan/plan.assets';
import { AsyncReportService } from './async-report.service';
import { AttrGroupBy, CreativeAttrsService } from './creative-attrs.service';
import { ReportLevel, ReportService } from './report.service';

class QueryReportDto {
  advertiserId!: string;
  startDate!: string;
  endDate!: string;
  granularity?: 'DAILY' | 'HOURLY';
  page?: number;
  pageSize?: number;
  campaignIds?: string[];
  unitIds?: string[];
  creativeIds?: string[];
}

class OverviewDto {
  advertiserIds!: string[];
  startDate!: string;
  endDate!: string;
  granularity?: 'DAILY' | 'HOURLY';
}

class TrendDto {
  advertiserIds!: string[];
  date!: string;
}

class BackfillDto {
  /** 不传 = 自动挑「历史还不够老」的账户 */
  advertiserIds?: string[];
  /** 单次最多补几个账户（受每日配额约束） */
  limit?: number;
}

@Controller('api/report')
export class ReportController {
  constructor(
    private readonly report: ReportService,
    private readonly asyncReport: AsyncReportService,
    private readonly creativeAttrs: CreativeAttrsService,
    private readonly planAssets: PlanAssetsService,
  ) {}

  /**
   * 平台数据边界说明，前端用来限制日期选择器范围。
   * 历史数据已本地留存（ReportDailyStat 永久累积），可回溯边界以本地库为准；
   * 实时接口只开近 7 天，更早的历史由异步任务每日回补（目标 6 个月）。
   */
  @Get('meta')
  async meta() {
    const [span, progress] = await Promise.all([this.report.storageSpan(), this.asyncReport.progress()]);
    return {
      realtimeLookbackDays: REALTIME_REPORT_LOOKBACK_DAYS,
      maxPageSize: MAX_PAGE_SIZE,
      maxIdsPerRequest: 5000,
      earliestDate: span.earliestDate,
      latestDate: span.latestDate,
      storedDays: span.storedDays,
      backfill: progress,
      note: '历史数据取自本地永久留存；今日数据实时查平台（T-1 数据次日 09:00 定稿）',
    };
  }

  @Post('overview')
  overview(@Body() body: OverviewDto) {
    return this.report.overview(
      body.advertiserIds ?? [],
      body.startDate,
      body.endDate,
      body.granularity ?? 'DAILY',
    );
  }

  @Post('trend')
  trend(@Body() body: TrendDto) {
    return this.report.hourlyTrend(body.advertiserIds ?? [], body.date);
  }

  @Post('level/:level')
  query(@Param('level') level: ReportLevel, @Body() body: QueryReportDto) {
    return this.report.query(level, body);
  }

  /**
   * 创意属性赛马（细则 1124）：把创意级报表按「广告语 / 标签组合 / 单标签 /
   * 创意分类 / 行动号召」聚合，回答「哪句文案 / 哪组标签跑得好」。
   * 支持多账户汇总：advertiserIds=逗号分隔（同名属性跨账户合计），不传则取单账户 advertiserId。
   * 首次调用会自动全量同步创意属性（1 小时缓存，sync=1 强制刷新）。
   */
  @Get('creative-attrs')
  async creativeAttrsRank(
    @Query('advertiserId') advertiserId?: string,
    @Query('advertiserIds') advertiserIdsRaw?: string,
    @Query('startDate') startDate: string = '',
    @Query('endDate') endDate: string = '',
    @Query('groupBy') groupByRaw?: string,
    @Query('sync') sync?: string,
  ) {
    const groupBy = (['description', 'plcDescription', 'category', 'tags', 'tag', 'actionBar'] as AttrGroupBy[]).includes(
      groupByRaw as AttrGroupBy,
    )
      ? (groupByRaw as AttrGroupBy)
      : 'tags';
    const ids = [
      ...new Set(
        [
          ...(advertiserIdsRaw ? advertiserIdsRaw.split(',').map((s) => s.trim()) : []),
          ...(advertiserId ? [String(advertiserId)] : []),
        ].filter(Boolean),
      ),
    ];
    // 多账户并发：逐户同步属性（1h 缓存）+ 拉创意实时报表，行合并后统一聚合
    const [syncResults, rowLists] = await Promise.all([
      Promise.all(ids.map((id) => this.creativeAttrs.sync(id, sync === '1').catch(() => ({ count: 0, skipped: true })))),
      Promise.all(
        ids.map((id) =>
          this.report
            .query('creative', {
              advertiserId: id,
              startDate,
              endDate,
              page: 1,
              pageSize: MAX_PAGE_SIZE,
            })
            .then((p) => (p.rows ?? []) as unknown as Record<string, unknown>[])
            .catch(() => [] as Record<string, unknown>[]),
        ),
      ),
    ]);
    const allRows = rowLists.flat();
    const ranked = await this.creativeAttrs.aggregate(ids, allRows, groupBy);
    return {
      groupBy,
      accounts: ids,
      synced:
        ids.length === 1
          ? syncResults[0]
          : {
              count: syncResults.reduce((s, r) => s + (r.count || 0), 0),
              skipped: syncResults.every((r) => r.skipped),
            },
      rows: ranked,
    };
  }

  /** 手动触发历史回补（异步任务，每日配额 18 个账户） */
  @Post('backfill')
  backfill(@Body() body: BackfillDto) {
    return this.asyncReport.backfillBatch(body.advertiserIds ?? [], Math.min(body.limit ?? 8, 20));
  }

  /** 回补进度 */
  @Get('backfill/progress')
  backfillProgress() {
    return this.asyncReport.progress();
  }

  /**
   * 人群包效果追溯：把创意级报表按「所属组的人群包定向」归因聚合。
   * 链路 = 创意报表(带 unitId) × 组列表 population 字段(文档 2264) × dmp/population/list 包名。
   * 同组挂多个包 → 各包分别计入（包维度赛马口径）；组未挂包 → 「未定向（通投）」桶。
   * 未投放的包也返回（0 消耗），方便看到「哪些包还没用上」。
   */
  @Get('population-effects')
  async populationEffects(
    @Query('advertiserId') advertiserId?: string,
    @Query('advertiserIds') advertiserIdsRaw?: string,
    @Query('startDate') startDate: string = '',
    @Query('endDate') endDate: string = '',
  ) {
    const ids = [
      ...new Set(
        [
          ...(advertiserIdsRaw ? advertiserIdsRaw.split(',').map((s) => s.trim()) : []),
          ...(advertiserId ? [String(advertiserId)] : []),
        ].filter(Boolean),
      ),
    ];
    interface Bucket {
      id: string;
      name: string;
      coverWan: number;
      usable: boolean;
      owners: Set<string>;
      units: Set<string>;
      charge: number;
      show: number;
      bclick: number;
      activation: number;
      payCount: number;
    }
    const buckets = new Map<string, Bucket>();
    const touch = (id: string, name: string, coverWan: number, usable: boolean, owner: string) => {
      if (!buckets.has(id)) {
        buckets.set(id, { id, name, coverWan, usable, owners: new Set(), units: new Set(), charge: 0, show: 0, bclick: 0, activation: 0, payCount: 0 });
      }
      const b = buckets.get(id)!;
      b.owners.add(owner);
      if (coverWan > 0 && b.coverWan === 0) b.coverWan = coverWan;
      return b;
    };
    const NONE_KEY = '__none__';

    const results = await Promise.all(
      ids.map(async (id) => {
        try {
          const [pops, unitPop, page] = await Promise.all([
            this.planAssets.listPopulations(id).catch(() => []),
            this.creativeAttrs.unitPopulationMap(id).catch(() => ({ popMap: new Map<string, string[]>(), unitCount: 0 })),
            this.report
              .query('creative', { advertiserId: id, startDate, endDate, page: 1, pageSize: MAX_PAGE_SIZE })
              .then((p) => (p.rows ?? []) as unknown as Record<string, unknown>[]),
          ]);
          return { id, pops, unitPop: unitPop.popMap, rows: page };
        } catch {
          return { id, pops: [], unitPop: new Map<string, string[]>(), rows: [] as Record<string, unknown>[] };
        }
      }),
    );

    for (const res of results) {
      const popName = new Map(res.pops.map((p) => [p.id, p] as const));
      // 先把所有包挂上（0 消耗的包也要展示）
      for (const p of res.pops) touch(p.id, p.name, p.coverWan, p.usable, res.id);
      // 未定向桶
      touch(NONE_KEY, '未定向（通投）', 0, true, res.id);

      for (const r of res.rows) {
        const unitId = String(r.unitId || '');
        const popIds = res.unitPop.get(unitId);
        const keys = popIds && popIds.length ? popIds : [NONE_KEY];
        const owner = res.id;
        for (const k of keys) {
          const known = popName.get(k);
          const b = touch(k, known?.name ?? k, known?.coverWan ?? 0, known?.usable ?? true, owner);
          b.units.add(unitId);
          b.charge += Number(r.charge || 0);
          b.show += Number(r.show || 0);
          b.bclick += Number(r.bclick || 0);
          b.activation += Number(r.activation || 0);
          b.payCount += Number(r.payCount || 0);
        }
      }
    }

    const rows = [...buckets.values()]
      .map((b) => ({
        id: b.id,
        key: b.id,
        name: b.name,
        coverWan: b.coverWan,
        usable: b.usable,
        owners: [...b.owners],
        units: b.units.size,
        charge: Number(b.charge.toFixed(2)),
        show: b.show,
        bclick: b.bclick,
        activation: b.activation,
        actCost: b.activation > 0 ? Number((b.charge / b.activation).toFixed(2)) : null,
        payCount: b.payCount,
        payCost: b.payCount > 0 ? Number((b.charge / b.payCount).toFixed(2)) : null,
      }))
      .sort((a, b) => b.charge - a.charge);
    return { accounts: ids, startDate, endDate, rows };
  }
}
