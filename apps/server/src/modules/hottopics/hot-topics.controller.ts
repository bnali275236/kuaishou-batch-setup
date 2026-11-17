import { Controller, Get, Post, Query } from '@nestjs/common';
import { HotTopicsService } from './hot-topics.service';

@Controller('api/hot-topics')
export class HotTopicsController {
  constructor(private readonly hot: HotTopicsService) {}

  /** 热榜快照（?refresh=1 强制重抓） */
  @Get()
  list(@Query('refresh') refresh?: string) {
    return this.hot.list(refresh === '1');
  }

  /** 手动刷新 */
  @Post('refresh')
  refresh() {
    return this.hot.refresh();
  }
}
