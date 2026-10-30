import { Module, OnModuleInit } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { MapiModule } from '../../mapi/mapi.module';
import { PlanApi } from './plan.api';
import { PlanAssetsService } from './plan.assets';
import { PlanPackagesService } from './plan.packages';
import { PlanController } from './plan.controller';
import { DraftService } from './draft.service';
import { TaskService } from './task.service';
import { PlanVerifyScheduler } from './plan.scheduler';

@Module({
  imports: [PrismaModule, MapiModule],
  controllers: [PlanController],
  providers: [PlanApi, PlanAssetsService, PlanPackagesService, DraftService, TaskService, PlanVerifyScheduler],
  // PlanAssetsService 对外导出：素材看板要用它把素材名/封面从视频库回填
  exports: [TaskService, PlanApi, PlanAssetsService],
})
export class PlanModule implements OnModuleInit {
  constructor(private readonly tasks: TaskService) {}

  /**
   * 启动时把中断的任务捡起来续跑。
   * 这是「断点续跑」的最后一环：进程崩了或用户重启了服务，
   * 已经跑了一半的任务不该停在半路——已经成功的条目不会被重发。
   */
  async onModuleInit(): Promise<void> {
    // 稍等片刻，避免与其它模块的启动初始化抢数据库
    setTimeout(() => {
      void this.tasks.resumeInterrupted();
    }, 3000);
  }
}
