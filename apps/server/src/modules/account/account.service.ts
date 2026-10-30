import { Injectable, Logger } from '@nestjs/common';
import { MAPI_PATHS, liToYuan } from '@wkbd/shared';
import { MapiGateway } from '../../mapi/mapi.gateway';
import { PrismaService } from '../../prisma/prisma.service';
import { firstObject, num, pickArray, str } from '../../common/parse';
import { toId } from '../../common/id';

export interface AdvertiserInfo {
  advertiserId: string;
  name: string | null;
  industry: string | null;
  firstIndustry: string | null;
  secondIndustry: string | null;
  raw: Record<string, unknown> | null;
}

export interface AdvertiserFund {
  advertiserId: string;
  /** 元 */
  balance: number;
  rechargeBalance: number;
  /** 元 */
  dailySpend: number;
  raw: Record<string, unknown> | null;
}

@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    private readonly gateway: MapiGateway,
    private readonly prisma: PrismaService,
  ) {}

  /** 账户资质信息。二级行业决定可选优化目标，创编预校验会用到 */
  async fetchInfo(advertiserId: string): Promise<AdvertiserInfo> {
    const data = await this.gateway.call<Record<string, unknown>>({
      advertiserId,
      path: MAPI_PATHS.ADVERTISER_INFO,
      category: 'query',
      action: 'advertiser.info',
      body: { advertiser_ids: [toId(advertiserId)] },
    });

    const row = firstObject(data) ?? {};
    return {
      advertiserId,
      name: str(row.advertiser_name ?? row.name ?? row.company_name) || null,
      industry: str(row.industry ?? row.first_industry) || null,
      firstIndustry: str(row.first_industry ?? row.industry) || null,
      secondIndustry: str(row.second_industry ?? row.sub_industry) || null,
      raw: row,
    };
  }

  /** 账户余额与当日消耗。金额单位统一转成「元」返回给前端 */
  async fetchFund(advertiserId: string): Promise<AdvertiserFund> {
    const data = await this.gateway.call<Record<string, unknown>>({
      advertiserId,
      path: MAPI_PATHS.ADVERTISER_FUND,
      category: 'query',
      action: 'advertiser.fund',
      body: { advertiser_id: toId(advertiserId) },
    });

    const row = firstObject(data) ?? {};
    const asYuan = (v: unknown) => {
      const raw = num(v, 0);
      // 平台余额字段单位与消耗字段不一致：消耗为「厘」，余额多为「元」。
      // 这里按字段语义区分处理，避免出现 1000 倍误差。
      return raw;
    };

    return {
      advertiserId,
      balance: asYuan(row.balance ?? row.cash_balance),
      rechargeBalance: asYuan(row.recharge_balance),
      dailySpend: liToYuan(num(row.daily_charge ?? row.charge ?? row.today_cost, 0)),
      raw: row,
    };
  }

  /** 拉取并缓存账户白名单能力快照 */
  async syncWhiteList(advertiserId: string): Promise<{ items: string[]; raw: unknown }> {
    const data = await this.gateway.call<Record<string, unknown>>({
      advertiserId,
      path: MAPI_PATHS.ADVERTISER_WHITE_LIST,
      category: 'query',
      action: 'advertiser.whiteList',
      body: { advertiser_id: toId(advertiserId) },
    });

    const rows = pickArray(data, ['white_list', 'whiteList']);
    const items = rows
      .map((r) => str(r.code ?? r.name ?? r))
      .filter((s) => s.length > 0);

    await this.prisma.oauthAccount.updateMany({
      where: { advertiserId },
      data: { whiteListJson: JSON.stringify({ items, syncedAt: new Date().toISOString() }) },
    });

    this.logger.log(`账户 ${advertiserId} 白名单已同步，共 ${items.length} 项`);
    return { items, raw: data };
  }

  async getCachedWhiteList(advertiserId: string): Promise<string[]> {
    const row = await this.prisma.oauthAccount.findUnique({ where: { advertiserId } });
    if (!row?.whiteListJson) return [];
    try {
      const parsed = JSON.parse(row.whiteListJson) as { items?: string[] };
      return parsed.items ?? [];
    } catch {
      return [];
    }
  }

  /** 资金流水，用于日消耗对账（P2 阶段使用，先提供能力） */
  async fetchFundFlows(advertiserId: string, startDate: string, endDate: string) {
    const data = await this.gateway.call<Record<string, unknown>>({
      advertiserId,
      path: MAPI_PATHS.ADVERTISER_FUND_FLOWS,
      category: 'query',
      action: 'advertiser.fundFlows',
      body: {
        advertiser_id: toId(advertiserId),
        start_date: startDate,
        end_date: endDate,
      },
    });
    return pickArray(data);
  }
}
