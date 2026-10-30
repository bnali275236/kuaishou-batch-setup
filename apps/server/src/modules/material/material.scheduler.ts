import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import dayjs from 'dayjs';
import { MaterialService, MATERIAL_WINDOW_DAYS } from './material.service';

/**
 * 素材日报定时同步。
 *
 * 为什么这件事必须有定时任务而不能只在用户打开页面时拉：
 *   平台实时素材报表只有近 7 天窗口，用户隔了 10 天不看，那 3 天的数据就永久丢了。
 *   所以「必须」每天自动落库一次，把数据永久攒下来。
 *
 * 节奏（三个任务互补）：
 *   1. 启动 90 秒后：若本地还没有「昨天」的数据（全新安装 / 停机多日），补一轮完整 7 天窗口；
 *   2. 每小时（第 20 分）：刷当天数据（当天消耗持续增长，需要高频覆盖）；
 *   3. 每天 09:15：刷完整 7 天窗口 —— T-1 数据 09:00 定稿，此时拉到的昨日数据才是最终值，
 *      同时把停机期间漏掉的日期一并补齐。
 */
@Injectable()
export class MaterialSyncScheduler implements OnModuleInit {
  private readonly logger = new Logger(MaterialSyncScheduler.name);

  constructor(private readonly material: MaterialService) {}

  onModuleInit(): void {
    // 延后到启动稳定后再跑，避免和 token 刷新、任务续跑抢资源
    setTimeout(() => void this.startupBackfill(), 90_000).unref?.();
  }

  /** 启动补数：只在「最近的数据比昨天还旧」时才跑，避免每次重启都全量拉一遍 */
  async startupBackfill(): Promise<void> {
    try {
      const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
      const existing = await this.material.storageInfo();
      // 判据必须看「最新日期」，不能看「最早日期」——
      // 最早日期随着长期积累只会越来越旧，拿它判断会导致每次启动都白跑一轮全量同步。
      if (existing.latestDate && !dayjs(existing.latestDate).isBefore(dayjs(yesterday))) {
        this.logger.log(`素材日报：本地已有 ${existing.latestDate} 的数据，跳过启动补数`);
        return;
      }
      this.logger.log('素材日报：启动补数（近 7 天窗口）');
      await this.syncWindow();
    } catch (err) {
      this.logger.error(`素材日报启动补数异常：${(err as Error).message}`);
    }
  }

  /** 每小时刷当天数据 */
  @Cron('0 20 * * * *')
  async syncToday(): Promise<void> {
    try {
      const today = dayjs().format('YYYY-MM-DD');
      const r = await this.material.syncRange([], today, today);
      if (r.rows > 0 || r.failures.length > 0) {
        this.logger.log(
          `素材日报（今日）：写入 ${r.rows} 行，失败 ${r.failures.length} 个账户`,
        );
      }
    } catch (err) {
      this.logger.error(`素材日报今日同步异常：${(err as Error).message}`);
    }
  }

  /** 每天 09:15 刷完整窗口（T-1 定稿 + 补齐停机期间缺失的日期） */
  @Cron('0 15 9 * * *')
  async syncWindowDaily(): Promise<void> {
    try {
      await this.syncWindow();
    } catch (err) {
      this.logger.error(`素材日报每日同步异常：${(err as Error).message}`);
    }
  }

  private async syncWindow(): Promise<void> {
    const end = dayjs().format('YYYY-MM-DD');
    const start = dayjs().subtract(MATERIAL_WINDOW_DAYS - 1, 'day').format('YYYY-MM-DD');
    const r = await this.material.syncRange([], start, end);
    this.logger.log(
      `素材日报（${start} ~ ${end}）：${r.accounts} 个账户，写入 ${r.rows} 行，失败 ${r.failures.length} 个`,
    );
  }
}
