import { Body, Controller, Post } from '@nestjs/common';
import { IsIn, IsNotEmpty, IsString } from 'class-validator';
import { ManageLevel, ManageService } from './manage.service';

class StructureDto {
  advertiserId!: string;
  level!: ManageLevel;
  campaignId?: string;
  unitId?: string;
}

class StatusDto {
  advertiserId!: string;
  level!: ManageLevel;
  ids!: string[];
  // eslint-disable-next-line @typescript-eslint/no-misused-prop-types
  action!: 'RUN' | 'PAUSE' | 'DELETE';
}

class CampaignBudgetDto {
  advertiserId!: string;
  campaignId!: string;
  /** 单位：元（0 = 不限），服务端转厘 */
  budgetYuan!: number;
}

class UnitBudgetDto {
  advertiserId!: string;
  unitId!: string;
  budgetYuan!: number;
}

class UnitBidDto {
  advertiserId!: string;
  unitIds!: string[];
  bidYuan!: number;
}

class AdvertiserBudgetDto {
  advertiserId!: string;
  /** 单位：元（0 = 不限），服务端转厘 */
  budgetYuan!: number;
}

class UnitScheduleDto {
  advertiserId!: string;
  unitId!: string;
  /** 24*7 的 0/1 串，从周一零点开始 */
  scheduleTime!: string;
}

@Controller('api/manage')
export class ManageController {
  constructor(private readonly manage: ManageService) {}

  /** 拉层级结构（名称/状态/预算/出价/时段），配合报表指标在盯盘里逐层下钻 */
  @Post('structure')
  structure(@Body() body: StructureDto) {
    return this.manage.listStructure(body.advertiserId, body.level, {
      campaignId: body.campaignId,
      unitId: body.unitId,
    });
  }

  /** 批量改投放状态：RUN 投放 / PAUSE 暂停 / DELETE 删除（删除需前端二次确认） */
  @Post('status')
  status(@Body() body: StatusDto) {
    return this.manage.setStatus(body.advertiserId, body.level, body.ids ?? [], body.action);
  }

  /** 改计划日预算 */
  @Post('campaign-budget')
  campaignBudget(@Body() body: CampaignBudgetDto) {
    return this.manage.updateCampaignBudget(body.advertiserId, body.campaignId, body.budgetYuan);
  }

  /** 改组日预算 */
  @Post('unit-budget')
  unitBudget(@Body() body: UnitBudgetDto) {
    return this.manage.updateUnitBudget(body.advertiserId, body.unitId, body.budgetYuan);
  }

  /** 改账户日预算 */
  @Post('advertiser-budget')
  advertiserBudget(@Body() body: AdvertiserBudgetDto) {
    return this.manage.updateAdvertiserBudget(body.advertiserId, body.budgetYuan);
  }

  /** 查账户日预算 */
  @Post('advertiser-budget/get')
  advertiserBudgetGet(@Body() body: { advertiserId: string }) {
    return this.manage.getAdvertiserBudget(body.advertiserId);
  }

  /** 批量改组出价 */
  @Post('unit-bid')
  unitBid(@Body() body: UnitBidDto) {
    return this.manage.updateUnitBid(body.advertiserId, body.unitIds ?? [], body.bidYuan);
  }

  /** 改组投放时段（24*7 网格） */
  @Post('unit-schedule')
  unitSchedule(@Body() body: UnitScheduleDto) {
    return this.manage.updateUnitSchedule(body.advertiserId, body.unitId, body.scheduleTime);
  }
}
