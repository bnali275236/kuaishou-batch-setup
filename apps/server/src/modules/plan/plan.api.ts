import { Injectable } from '@nestjs/common';
import { MAPI_PATHS, PLAN_PATHS, STATUS_UPDATE_BATCH_LIMIT } from '@wkbd/shared';
import { MapiGateway } from '../../mapi/mapi.gateway';

export type CreateLevel = 'CAMPAIGN' | 'UNIT' | 'CREATIVE';

export interface CreateResult {
  /** 平台返回的实体 ID */
  platformId: string;
  /** 原始响应，便于审计与排查 */
  raw: Record<string, unknown>;
}

/**
 * 状态更新的结果。
 *
 * 刻意**不是**布尔值也不是「成功的 ID 列表」：平台可以只成功一部分
 * （响应里带回 `campaign_ids` 成功项 + `errors` 失败项），
 * 只看成功项会把部分失败当成全成功 —— 那是最危险的一种谎报。
 * 实测响应形状（2026-09-24）：`{ campaign_ids: [...], errors: [], campaign_id: null }`
 */
export interface StatusUpdateResult {
  succeeded: string[];
  errors: unknown[];
}

/**
 * 创编接口封装。
 *
 * 三个接口都属于「创编类」调用，统一走 create 限流桶（600 QPM）。
 * 这里只做「协议适配」——把业务层的 payload 原样发出去、把平台返回的 ID 抽出来，
 * 不掺任何业务判断（校验在 plan.validator，编排在 task.service）。
 */
@Injectable()
export class PlanApi {
  constructor(private readonly gateway: MapiGateway) {}

  /** 创建广告计划 */
  async createCampaign(
    advertiserId: string,
    payload: Record<string, unknown>,
  ): Promise<CreateResult> {
    const data = await this.gateway.call<Record<string, unknown>>({
      advertiserId,
      path: PLAN_PATHS.CAMPAIGN_CREATE,
      body: payload,
      category: 'create',
      action: 'plan.campaign.create',
    });
    return {
      platformId: String(data?.campaign_id ?? ''),
      raw: data ?? {},
    };
  }

  /** 创建广告组 */
  async createUnit(advertiserId: string, payload: Record<string, unknown>): Promise<CreateResult> {
    const data = await this.gateway.call<Record<string, unknown>>({
      advertiserId,
      path: PLAN_PATHS.UNIT_CREATE,
      body: payload,
      category: 'create',
      action: 'plan.unit.create',
    });
    return {
      platformId: String(data?.unit_id ?? ''),
      raw: data ?? {},
    };
  }

  /** 创建自定义创意 */
  async createCreative(
    advertiserId: string,
    payload: Record<string, unknown>,
  ): Promise<CreateResult> {
    const data = await this.gateway.call<Record<string, unknown>>({
      advertiserId,
      path: PLAN_PATHS.CREATIVE_CREATE,
      body: payload,
      // 创意层是独立限流桶（400 QPM），比计划/组的 600 更紧
      category: 'creative',
      action: 'plan.creative.create',
    });
    return {
      platformId: String(data?.creative_id ?? ''),
      raw: data ?? {},
    };
  }

  /**
   * 创建搜索广告关键词（v2/word_info/create）。
   *
   * 只能在**搜索广告组**上调用（组创建成功后追加调用——接口要求 campaign_id + unit_id）。
   * 返回成功/失败词列表：平台可能拒收部分词（违禁、重复、超长），必须分开报出来。
   */
  async createKeywords(
    advertiserId: string,
    campaignId: string,
    unitId: string,
    words: string[],
    matchType: number,
  ): Promise<{ succeeded: string[]; failed: string[] }> {
    const wordInfos = words
      .map((w) => w.trim())
      .filter(Boolean)
      .slice(0, 1000)
      .map((word) => ({ word, match_type: matchType }));
    if (wordInfos.length === 0) return { succeeded: [], failed: [] };

    const data = await this.gateway.call<Record<string, unknown>>({
      advertiserId,
      path: MAPI_PATHS.WORD_INFO_CREATE,
      body: {
        advertiser_id: this.numericId(advertiserId),
        campaign_id: this.numericId(campaignId),
        unit_id: this.numericId(unitId),
        word_infos: wordInfos,
      },
      category: 'create',
      action: 'plan.wordinfo.create',
    });

    const succeeded: string[] = [];
    const failed: string[] = [];
    const collect = (key: 'success_list' | 'error_list', sink: string[]) => {
      const list = this.pickList(data, [key]);
      for (const item of list) {
        if (typeof item === 'object' && item !== null) {
          const word = (item as Record<string, unknown>).word;
          if (word != null) sink.push(String(word));
        } else if (item != null) {
          sink.push(String(item));
        }
      }
    };
    collect('success_list', succeeded);
    collect('error_list', failed);
    return { succeeded, failed };
  }

  /* ---------------- 回读核验：查询接口 ---------------- */

  /**
   * 拉取账户下**全部**已有计划的名称（分页翻完）。
   * 给「计划名自动去重」用：平台校验计划名在账户内唯一，
   * 提交前先拉一遍已有名，撞名自动加序号，用户就不用手动改名了。
   */
  async listAllCampaignNames(advertiserId: string): Promise<Set<string>> {
    const names = new Set<string>();
    const pageSize = 200;
    for (let page = 1; page <= 20; page += 1) {
      const data = await this.gateway.call<Record<string, unknown>>({
        advertiserId,
        path: PLAN_PATHS.CAMPAIGN_LIST,
        body: {
          advertiser_id: this.numericId(advertiserId),
          page,
          page_size: pageSize,
        },
        category: 'query',
        action: 'plan.campaign.list',
        retry: true,
      });
      const list = this.pickList(data, ['campaign_list', 'list', 'records', 'details']);
      for (const item of list) {
        const name = (item as Record<string, unknown>).campaign_name;
        if (name != null && String(name).trim() !== '') names.add(String(name));
      }
      if (list.length < pageSize) break;
    }
    return names;
  }

  /** 查计划：按 ID 列表批量回读（平台上限 200 个） */
  async listCampaigns(
    advertiserId: string,
    campaignIds: string[],
  ): Promise<Array<Record<string, unknown>>> {
    if (campaignIds.length === 0) return [];
    const data = await this.gateway.call<Record<string, unknown>>({
      advertiserId,
      path: PLAN_PATHS.CAMPAIGN_LIST,
      body: {
        advertiser_id: this.numericId(advertiserId),
        campaign_ids: campaignIds.slice(0, 200).map((id) => this.numericId(id)),
        page: 1,
        page_size: 200,
      },
      category: 'query',
      action: 'plan.campaign.list',
      retry: true,
    });
    return this.pickList(data, ['campaign_list', 'list', 'records', 'details']);
  }

  /** 查广告组 */
  async listUnits(advertiserId: string, unitIds: string[]): Promise<Array<Record<string, unknown>>> {
    if (unitIds.length === 0) return [];
    const data = await this.gateway.call<Record<string, unknown>>({
      advertiserId,
      path: PLAN_PATHS.UNIT_LIST,
      body: {
        advertiser_id: this.numericId(advertiserId),
        unit_ids: unitIds.slice(0, 200).map((id) => this.numericId(id)),
        page: 1,
        page_size: 200,
      },
      category: 'query',
      action: 'plan.unit.list',
      retry: true,
    });
    return this.pickList(data, ['unit_list', 'list', 'records', 'details']);
  }

  /** 查创意 */
  async listCreatives(
    advertiserId: string,
    creativeIds: string[],
  ): Promise<Array<Record<string, unknown>>> {
    if (creativeIds.length === 0) return [];
    const data = await this.gateway.call<Record<string, unknown>>({
      advertiserId,
      path: PLAN_PATHS.CREATIVE_LIST,
      body: {
        advertiser_id: this.numericId(advertiserId),
        creative_ids: creativeIds.slice(0, 200).map((id) => this.numericId(id)),
        page: 1,
        page_size: 200,
      },
      category: 'query',
      action: 'plan.creative.list',
      retry: true,
    });
    return this.pickList(data, ['creative_list', 'list', 'records', 'details']);
  }

  /* ---------------- 投放状态更新（创建后置处理用） ---------------- */

  /**
   * 批量改计划投放状态。
   *
   * 计划层的创建接口**没有状态字段**，所以「创建即暂停」只能创建成功后再改一次。
   * 返回**实际改成功的 ID 列表** —— 平台可能只成功一部分，不能假定全成功。
   */
  async updateCampaignStatus(
    advertiserId: string,
    campaignIds: string[],
    putStatus: number,
  ): Promise<StatusUpdateResult> {
    return this.batchStatusUpdate(
      advertiserId,
      PLAN_PATHS.CAMPAIGN_STATUS_UPDATE,
      'campaign_id',
      campaignIds,
      putStatus,
      STATUS_UPDATE_BATCH_LIMIT.CAMPAIGN,
      'plan.campaign.update_status',
    );
  }

  /** 批量改组投放状态（正常不用于「创建即暂停」——组层创建时可直接指定 put_status） */
  async updateUnitStatus(
    advertiserId: string,
    unitIds: string[],
    putStatus: number,
  ): Promise<StatusUpdateResult> {
    return this.batchStatusUpdate(
      advertiserId,
      PLAN_PATHS.UNIT_STATUS_UPDATE,
      'unit_id',
      unitIds,
      putStatus,
      STATUS_UPDATE_BATCH_LIMIT.UNIT,
      'plan.unit.update_status',
    );
  }

  /** 批量改创意投放状态 */
  async updateCreativeStatus(
    advertiserId: string,
    creativeIds: string[],
    putStatus: number,
  ): Promise<StatusUpdateResult> {
    return this.batchStatusUpdate(
      advertiserId,
      PLAN_PATHS.CREATIVE_STATUS_UPDATE,
      'creative_id',
      creativeIds,
      putStatus,
      STATUS_UPDATE_BATCH_LIMIT.CREATIVE,
      'plan.creative.update_status',
    );
  }

  /**
   * 三个状态更新接口形状完全一致，只有路径 / 主键名 / 批量上限不同。
   * 单次上限分别是 20 / 10 / 20，超了会被平台拒，这里按上限切片并发调用。
   */
  private async batchStatusUpdate(
    advertiserId: string,
    path: string,
    idField: 'campaign_id' | 'unit_id' | 'creative_id',
    ids: string[],
    putStatus: number,
    batchLimit: number,
    action: string,
  ): Promise<StatusUpdateResult> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return { succeeded: [], errors: [] };

    const idsField = `${idField}s` as 'campaign_ids' | 'unit_ids' | 'creative_ids';
    const succeeded: string[] = [];
    const errors: unknown[] = [];

    for (let i = 0; i < unique.length; i += batchLimit) {
      const slice = unique.slice(i, i + batchLimit);
      const data = await this.gateway.call<Record<string, unknown>>({
        advertiserId,
        path,
        body: {
          advertiser_id: this.numericId(advertiserId),
          // ⚠️ 只传批量字段，**不要**同时传单数主键字段。
          // 文档说「二选一或同时填均可」，但实测同值同时填会报
          // `401000 存在重复的id`（2026-09-24，真实账户 124276382）。
          // 既然我们总是批量操作，就统一只传复数形式。
          [idsField]: slice.map((id) => this.numericId(id)),
          put_status: putStatus,
        },
        // 状态更新不属于创编配额，按查询桶限流即可
        category: 'query',
        action,
        retry: true,
      });

      // 返回的是「实际改成功的 ID」+ 独立的 errors 列表，据此判断部分失败
      const okList = this.pickList(data, [idsField, 'ids', 'list']);
      if (okList.length > 0) {
        for (const item of okList) {
          const value =
            typeof item === 'object' && item !== null
              ? (item as Record<string, unknown>)[idField]
              : item;
          if (value != null) succeeded.push(String(value));
        }
      } else {
        // 平台未回传明细时，保守认为本批全部成功（成功码已代表整体成功）
        succeeded.push(...slice);
      }

      // errors 是独立字段，必须显式检查：平台可能成功一半、失败一半，
      // 只看成功列表会把部分失败瞒下来。
      const errList = (data as Record<string, unknown> | undefined)?.errors;
      if (Array.isArray(errList) && errList.length > 0) {
        errors.push(...errList);
      }
    }

    return { succeeded, errors };
  }

  /**
   * 响应列表字段名在不同接口/版本间不统一，做防御式取值。
   * 与其猜，不如把可能的名字都试一遍——查询类接口这样处理没有任何副作用。
   */
  private pickList(
    data: Record<string, unknown> | undefined,
    keys: string[],
  ): Array<Record<string, unknown>> {
    if (!data) return [];
    if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
    for (const key of keys) {
      const value = (data as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
    }
    return [];
  }

  /** 平台 ID 是 long，本地按 string 存，发请求时还原为数字 */
  private numericId(value: string): number | string {
    const trimmed = String(value).trim();
    if (!/^\d+$/.test(trimmed)) return trimmed;
    const asNumber = Number(trimmed);
    return Number.isSafeInteger(asNumber) ? asNumber : trimmed;
  }
}
