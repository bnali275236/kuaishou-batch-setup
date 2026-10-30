import { Module } from '@nestjs/common';
import { TokenScheduler } from './token.scheduler';

@Module({
  providers: [TokenScheduler],
  exports: [TokenScheduler],
})
export class SchedulerModule {}
