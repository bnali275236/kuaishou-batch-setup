import { Module } from '@nestjs/common';
import { PlanModule } from '../plan/plan.module';
import { MaterialController } from './material.controller';
import { MaterialService } from './material.service';
import { MaterialSyncScheduler } from './material.scheduler';

@Module({
  // 素材名要从视频库回填，复用 PlanAssetsService（自带 10 分钟缓存，不重复造轮子）
  imports: [PlanModule],
  controllers: [MaterialController],
  providers: [MaterialService, MaterialSyncScheduler],
  exports: [MaterialService],
})
export class MaterialModule {}
