import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import dayjs from 'dayjs';
import { DAILY_CREATE_LIMITS } from '@wkbd/shared';
import { AsyncReportService } from './async-report.service';
import { ReportService } from './report.service';

/**
 * 盯盘日报定时同步 —— 与素材日报同一个道理：
 * 平台实时报表只有近 7 天窗口，用户隔 10 天不看，中间的数据就永久取不回了。
 * 「取消 7 天限制」的本质是每天自动把账户日报落库并永久累积。
 *
 * 节奏（与素材同步错峰，避免同一分钟打满配额）：
 *   1. 启动 90 秒后：本地「昨天」没数据（新装 / 停机多日）→ 补一轮完整 7 天窗口；
 *   2. 每小时（第 40 分）：刷当天（小时行 + 日行；素材任务在 :20，错开 20 分钟）；
 *   3. 每天 09:20：刷完整 7 天窗口 —— T-1 数据 09:00 定稿，此时昨日数据才是最终值；
 *   4. 每天 10:40：异步任务回补 6 个月历史（实时接口第 8 天起就查不到，
 *      每日配额 18 个账户，206 账户约 12 天滚完一轮；素材任务在 :20/:40 也被盯盘占用，
 *      故放到 :40 并与每日窗口错开 80 分钟）。
 */
@Injectable()
export class ReportSyncScheduler implements OnModuleInit {
  private readonly logger = new Logger(ReportSyncScheduler.name);
  /** 异步回补是否正在跑（防重入：任务轮询最长 2 分钟/账户） */
  private backfillRunning = false;

  constructor(
    private readonly report: ReportService,
    private readonly asyncReport: AsyncReportService,
  ) {}

  onModuleInit(): void {
    setTimeout(() => void this.startupBackfill(), 90_000).unref?.();
  }

  /** 启动补数：看「最新日期」判断昨天有没有数据（最早日期只会越来越旧，不能作判据） */
  async startupBackfill(): Promise<void> {
    try {
      const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
      const span = await this.report.storageSpan();
      if (span.latestDate && !dayjs(span.latestDate).isBefore(dayjs(yesterday))) {
        this.logger.log(`盯盘日报：本地已有 ${span.latestDate} 的数据，跳过启动补数`);
        return;
      }
      this.logger.log('盯盘日报：启动补数（近 7 天窗口）');
      await this.syncWindow();
    } catch (err) {
      this.logger.error(`盯盘日报启动补数异常：${(err as Error).message}`);
    }
  }

  /** 每小时刷当天：小时行 + 日行 */
  @Cron('0 40 * * * *')
  async syncToday(): Promise<void> {
    try {
      const today = dayjs().format('YYYY-MM-DD');
      const r = await this.report.syncHistory([], today, today, 'HOURLY');
      if (r.failures.length > 0) {
        this.logger.warn(`盯盘日报（今日）：失败 ${r.failures.length} 个账户`);
      }
    } catch (err) {
      this.logger.error(`盯盘日报今日同步异常：${(err as Error).message}`);
    }
  }

  /** 每天 09:20 刷完整窗口（T-1 定稿 + 补齐停机缺失） */
  @Cron('0 20 9 * * *')
  async syncWindowDaily(): Promise<void> {
    try {
      await this.syncWindow();
    } catch (err) {
      this.logger.error(`盯盘日报每日同步异常：${(err as Error).message}`);
    }
  }

  /**
   * 每天 10:40：异步任务回补 6 个月历史。
   * 只挑「日报最早日期还没老到目标起点」的账户，按当日剩余配额执行。
   */
  @Cron('0 40 10 * * *')
  async backfillHistoryDaily(): Promise<void> {
    if (this.backfillRunning) return;
    this.backfillRunning = true;
    try {
      const budget = DAILY_CREATE_LIMITS.ASYNC_TASK - 2;
      const results = await this.asyncReport.backfillBatch([], budget);
      const ok = results.filter((r) => r.ok).length;
      const fail = results.filter((r) => !r.ok);
      this.logger.log(`异步历史回补：成功 ${ok} 个账户${fail.length > 0 ? `，失败 ${fail.length} 个（${fail[0]?.message ?? ''}）` : ''}`);
    } catch (err) {
      this.logger.error(`异步历史回补异常：${(err as Error).message}`);
    } finally {
      this.backfillRunning = false;
    }
  }

  private async syncWindow(): Promise<void> {
    const end = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
    const start = dayjs().subtract(7, 'day').format('YYYY-MM-DD');
    const r = await this.report.syncHistory([], start, end, 'DAILY');
    this.logger.log(
      `盯盘日报（${start} ~ ${end}）：${r.accounts} 个账户，失败 ${r.failures.length} 个`,
    );
  }
}
