import { Module } from '@nestjs/common';
import { HotTopicsController } from './hot-topics.controller';
import { HotTopicsService } from './hot-topics.service';

@Module({
  controllers: [HotTopicsController],
  providers: [HotTopicsService],
})
export class HotTopicsModule {}
