import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { AccountService } from './account.service';

@Controller('api/accounts')
export class AccountController {
  constructor(private readonly accounts: AccountService) {}

  @Get(':advertiserId/info')
  info(@Param('advertiserId') advertiserId: string) {
    return this.accounts.fetchInfo(advertiserId);
  }

  @Get(':advertiserId/fund')
  fund(@Param('advertiserId') advertiserId: string) {
    return this.accounts.fetchFund(advertiserId);
  }

  @Get(':advertiserId/white-list')
  whiteList(@Param('advertiserId') advertiserId: string) {
    return this.accounts.getCachedWhiteList(advertiserId);
  }

  /** 重新拉取白名单快照 —— 创编前建议先跑一次，避免撞上「未加白」错误 */
  @Post(':advertiserId/white-list/sync')
  syncWhiteList(@Param('advertiserId') advertiserId: string) {
    return this.accounts.syncWhiteList(advertiserId);
  }

  @Get(':advertiserId/fund-flows')
  fundFlows(
    @Param('advertiserId') advertiserId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
  ) {
    return this.accounts.fetchFundFlows(advertiserId, startDate, endDate);
  }
}
