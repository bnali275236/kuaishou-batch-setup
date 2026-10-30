import { Body, Controller, Get, Post } from '@nestjs/common';
import { MaterialService } from './material.service';

class HistoryDto {
  advertiserIds?: string[];
  startDate!: string;
  endDate!: string;
  granularity?: 'TOTAL' | 'DAILY';
  /** 是否先把平台窗口内的数据同步一次再读（「刷新」时传 true） */
  syncFirst?: boolean;
}

class TodayDto {
  advertiserIds?: string[];
}

class SyncDto {
  advertiserIds?: string[];
  startDate?: string;
  endDate?: string;
}

@Controller('api/material')
export class MaterialController {
  constructor(private readonly material: MaterialService) {}

  /** 本地库覆盖情况：已积累多少天、最早可回溯到哪天 */
  @Get('meta')
  meta() {
    return this.material.storageInfo();
  }

  /** 历史数据：读本地永久库，支持任意时间周期（不受平台 7 天窗口限制） */
  @Post('history')
  history(@Body() body: HistoryDto) {
    return this.material.history({
      advertiserIds: body.advertiserIds ?? [],
      startDate: body.startDate,
      endDate: body.endDate,
      granularity: body.granularity ?? 'TOTAL',
      syncFirst: body.syncFirst === true,
    });
  }

  /** 今日数据：平台实时 */
  @Post('today')
  today(@Body() body: TodayDto) {
    return this.material.today({ advertiserIds: body.advertiserIds ?? [] });
  }

  /** 手动同步（补历史 / 立即刷新）。区间会被裁到平台允许的近 7 天 */
  @Post('sync')
  sync(@Body() body: SyncDto) {
    const end = body.endDate ?? new Date().toISOString().slice(0, 10);
    const start = body.startDate ?? new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
    return this.material.syncRange(body.advertiserIds ?? [], start, end);
  }
}
