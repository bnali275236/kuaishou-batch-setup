import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { MAX_PAGE_SIZE, REALTIME_REPORT_LOOKBACK_DAYS } from '@wkbd/shared';
import { AsyncReportService } from './async-report.service';
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
