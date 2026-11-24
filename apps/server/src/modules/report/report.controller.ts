import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { MAX_PAGE_SIZE, REALTIME_REPORT_LOOKBACK_DAYS } from '@wkbd/shared';
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
   * 首次调用会自动全量同步创意属性（1 小时缓存，sync=1 强制刷新）。
   */
  @Get('creative-attrs')
  async creativeAttrsRank(
    @Query('advertiserId') advertiserId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('groupBy') groupByRaw?: string,
    @Query('sync') sync?: string,
  ) {
    const groupBy = (['description', 'plcDescription', 'category', 'tags', 'tag', 'actionBar'] as AttrGroupBy[]).includes(
      groupByRaw as AttrGroupBy,
    )
      ? (groupByRaw as AttrGroupBy)
      : 'tags';
    const syncRes = await this.creativeAttrs.sync(String(advertiserId ?? ''), sync === '1');
    const page = await this.report.query('creative', {
      advertiserId: String(advertiserId ?? ''),
      startDate,
      endDate,
      page: 1,
      pageSize: MAX_PAGE_SIZE,
    });
    const ranked = await this.creativeAttrs.aggregate(
      String(advertiserId ?? ''),
      (page.rows ?? []) as unknown as Record<string, unknown>[],
      groupBy,
    );
    return { groupBy, synced: syncRes, rows: ranked };
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
}
