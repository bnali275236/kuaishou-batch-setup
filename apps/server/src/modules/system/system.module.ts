import { Module } from '@nestjs/common';
import { SchedulerModule } from '../../scheduler/scheduler.module';
import { ShareService } from './share.service';
import { SystemController } from './system.controller';

@Module({
  imports: [SchedulerModule],
  controllers: [SystemController],
  providers: [ShareService],
  // AppModule 需要用 ShareService 装配全局 AccessGuard
  exports: [ShareService],
})
export class SystemModule {}
