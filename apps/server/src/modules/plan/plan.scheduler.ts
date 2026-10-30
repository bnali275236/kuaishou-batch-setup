import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TaskService } from './task.service';

/**
 * 创建后自动核验。
 *
 * 为什么要定时跑而不是创建完立刻跑：平台侧数据有写入延迟，
 * 刚创建完立刻回读，很容易查不到而误报「平台查不到」。
 * 所以任务跑完后留一段时间，由这个调度器统一核验。
 */
@Injectable()
export class PlanVerifyScheduler {
  private readonly logger = new Logger(PlanVerifyScheduler.name);

  constructor(private readonly tasks: TaskService) {}

  /** 每 10 分钟扫一次「已创建但未核验」的任务 */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async verifyRecentTasks(): Promise<void> {
    try {
      const taskIds = await this.tasks.tasksNeedingVerify(5);
      for (const taskId of taskIds) {
        const result = await this.tasks.verifyTask(taskId);
        if (result.checked > 0) {
          this.logger.log(
            `核验任务 #${taskId}：${result.checked} 项 → 通过 ${result.ok} / 不一致 ${result.mismatch} / 查不到 ${result.missing}`,
          );
        }
      }
    } catch (err) {
      this.logger.warn(`自动核验失败：${(err as Error).message}`);
    }
  }
}
