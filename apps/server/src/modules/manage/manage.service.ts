import { BadRequestException, Injectable } from '@nestjs/common';
import { MAPI_PATHS, PLAN_PATHS, PUT_STATUS_CODE, yuanToLi } from '@wkbd/shared';
import { MapiGateway } from '../../mapi/mapi.gateway';
import { PrismaService } from '../../prisma/prisma.service';
import { PlanApi, StatusUpdateResult } from '../plan/plan.api';

/** 盯盘看板「进入账户」后的层级 */
export type ManageLevel = 'campaign' | 'unit' | 'creative';

export interface StructureItem {
  id: string;
  name: string | null;
  putStatus: number;
  /** 归属：组/创意带 campaignId，创意还带 unitId */
  campaignId: string | null;
  unitId: string | null;
  /** 单日预算（元）—— 计划/组；0 = 不限 */
  dayBudgetYuan: number;
  /** 出价（元）—— 仅组 */
  bidYuan: number;
  /** 出价类型（1 CPM / 2 CPC / 6 OCPC / 10 OCPM / 12 MCB）—— 仅组 */
  bidType: number | null;
  /** 投放时段（24*7 的 0/1 串）—— 仅组；null = 全时段 */
  scheduleTime: string | null;
  /** 投放版位 scene_ids —— 仅组；用于核验平台是否把优选(1)静默扩成 [1,10] 联盟 */
  sceneIds: number[] | null;
  putStatusText: string;
}

const PUT_STATUS_TEXT: Record<number, string> = {
  1: '投放中',
  2: '暂停',
  3: '已删除',
};

/**
 * 盯盘看板「进入账户」的结构查询与层级调整。
 *
 * 路径备忘（2026-09-29 按官方文档核对）：
 *   结构：gw/dsp/{campaign,unit,creative}/list
 *   状态：v1/…/update/status（复用 PlanApi —— 它已处理「只传复数主键 + 检查 errors」）
 *   计划预算：gw/dsp/campaign/update（day_budget，厘，0=不限）
 *   组预算：  v1/ad_unit/update/day_budget（单组）
 *   组出价：  v1/ad_unit/update/bid（支持 unit_ids 批量）
 *   组时段：  gw/dsp/unit/update —— ⚠️ unit_name / bid_type 必填，
 *             所以改时段前必须先回读该组拿到这两个字段。
 */
@Injectable()
export class ManageService {
  constructor(
    private readonly gateway: MapiGateway,
    private readonly planApi: PlanApi,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * 🚫 代投白名单（只读账户）拦截 —— 与上计划任务同一道闸：
   * 白名单内账户只能看数据，开关/删除/预算/出价/时段等一切调整都在入口拒绝。
   */
  private async assertWritable(advertiserId: string): Promise<void> {
    const locked = await this.prisma.oauthAccount.findFirst({
      where: { advertiserId, readOnly: true },
      select: { advertiserId: true, accountName: true },
    });
    if (locked) {
      throw new BadRequestException(
        `账户 ${locked.accountName ?? '未命名账户'}(${locked.advertiserId})在「代投白名单」内，仅可查看数据，禁止调整`,
      );
    }
  }

  /* ---------------- 结构查询 ---------------- */

  async listStructure(
    advertiserId: string,
    level: ManageLevel,
    parent?: { campaignId?: string; unitId?: string },
  ): Promise<StructureItem[]> {
    const items: Array<Record<string, unknown>> = [];
    if (level === 'campaign') {
      // 全量分页拉取（每页 200，上限 25 页 = 5000 个，足够）
      for (let page = 1; page <= 25; page += 1) {
        const body: Record<string, unknown> = {
          advertiser_id: this.numericId(advertiserId),
          page,
          page_size: 200,
        };
        const data = await this.gateway.call<Record<string, unknown>>({
          advertiserId,
          path: PLAN_PATHS.CAMPAIGN_LIST,
          body,
          category: 'query',
          action: 'manage.campaign.list',
          retry: true,
        });
        const list = this.pickList(data);
        items.push(...list);
        if (list.length < 200) break;
      }
      return items.map((r) => this.normalizeItem('campaign', r));
    }

    if (level === 'unit') {
      for (let page = 1; page <= 25; page += 1) {
        const body: Record<string, unknown> = {
          advertiser_id: this.numericId(advertiserId),
          page,
          page_size: 200,
        };
        if (parent?.campaignId) body.campaign_id = this.numericId(parent.campaignId);
        const data = await this.gateway.call<Record<string, unknown>>({
          advertiserId,
          path: PLAN_PATHS.UNIT_LIST,
          body,
          category: 'query',
          action: 'manage.unit.list',
          retry: true,
        });
        const list = this.pickList(data);
        items.push(...list);
        if (list.length < 200) break;
      }
      return items.map((r) => this.normalizeItem('unit', r));
    }

    // creative
    for (let page = 1; page <= 25; page += 1) {
      const body: Record<string, unknown> = {
        advertiser_id: this.numericId(advertiserId),
        page,
        page_size: 200,
      };
      if (parent?.unitId) body.unit_id = this.numericId(parent.unitId);
      else if (parent?.campaignId) body.campaign_id = this.numericId(parent.campaignId);
      const data = await this.gateway.call<Record<string, unknown>>({
        advertiserId,
        path: PLAN_PATHS.CREATIVE_LIST,
        body,
        category: 'query',
        action: 'manage.creative.list',
        retry: true,
      });
      const list = this.pickList(data);
      items.push(...list);
      if (list.length < 200) break;
    }
    return items.map((r) => this.normalizeItem('creative', r));
  }

  /** 按 ID 批量回读层级状态：全量 structure 列表在 UAX 账户下会漏掉常规计划（平台列表接口行为），
   *  一律用带 ids 的精确查询拿投放状态（put_status 1=投放 2=暂停 3=删除） */
  async listByIds(advertiserId: string, level: ManageLevel, ids: string[]): Promise<StructureItem[]> {
    if (!ids.length) return [];
    const take = ids.slice(0, 200);
    const found =
      level === 'campaign'
        ? await this.planApi.listCampaigns(advertiserId, take)
        : level === 'unit'
          ? await this.planApi.listUnits(advertiserId, take)
          : await this.planApi.listCreatives(advertiserId, take);
    return (found || []).map((r) => this.normalizeItem(level, r));
  }

  private normalizeItem(level: ManageLevel, r: Record<string, unknown>): StructureItem {
    const putStatus = Number(r.put_status ?? 0);
    const base = {
      id: String(
        level === 'campaign'
          ? r.campaign_id
          : level === 'unit'
            ? r.unit_id
            : r.creative_id,
      ),
      name: (level === 'campaign' ? r.campaign_name : level === 'unit' ? r.unit_name : r.creative_name) as string | null,
      putStatus,
      putStatusText: PUT_STATUS_TEXT[putStatus] ?? `未知(${putStatus})`,
      campaignId: r.campaign_id != null ? String(r.campaign_id) : null,
      unitId: r.unit_id != null ? String(r.unit_id) : null,
      dayBudgetYuan: this.liToYuan(this.num(r.day_budget)),
      // 出价：OCPM 存 bid，OCPC 存 cpa_bid；0 视为「未设出价」（UAX 自动出价的组就是 0）
      bidYuan: this.liToYuan(this.num(r.bid) > 0 ? this.num(r.bid) : this.num(r.cpa_bid)),
      bidType: r.bid_type != null ? Number(r.bid_type) : null,
      scheduleTime: (r.schedule_time as string | undefined) ?? null,
      // 注意：组创建入参是 scene_id（单数），列表返回也是 scene_id —— 两者都兼容
      sceneIds: (() => {
        if (level !== 'unit') return null;
        const raw = r.scene_id ?? r.scene_ids;
        return Array.isArray(raw) ? raw.map((x) => Number(x)) : raw != null ? [Number(raw)] : null;
      })(),
    };
    return base;
  }

  /* ---------------- 层级操作 ---------------- */

  /** 批量改投放状态（1 投放 / 2 暂停 / 3 删除），复用 PlanApi 的部分失败处理 */
  async setStatus(
    advertiserId: string,
    level: ManageLevel,
    ids: string[],
    action: 'RUN' | 'PAUSE' | 'DELETE',
  ): Promise<StatusUpdateResult> {
    await this.assertWritable(advertiserId);
    const putStatus =
      action === 'RUN'
        ? PUT_STATUS_CODE.RUNNING
        : action === 'PAUSE'
          ? PUT_STATUS_CODE.PAUSED
          : PUT_STATUS_CODE.DELETED;
    if (level === 'campaign') return this.planApi.updateCampaignStatus(advertiserId, ids, putStatus);
    if (level === 'unit') return this.planApi.updateUnitStatus(advertiserId, ids, putStatus);
    return this.planApi.updateCreativeStatus(advertiserId, ids, putStatus);
  }

  /** 改计划日预算（元 → 厘；0 = 不限） */
  async updateCampaignBudget(
    advertiserId: string,
    campaignId: string,
    budgetYuan: number,
  ): Promise<Record<string, unknown>> {
    await this.assertWritable(advertiserId);
    return this.gateway.call<Record<string, unknown>>({
      advertiserId,
      path: PLAN_PATHS.CAMPAIGN_UPDATE,
      body: {
        advertiser_id: this.numericId(advertiserId),
        campaign_id: this.numericId(campaignId),
        // 文档（2260）：单位厘；0 表示预算不限；不能低于当日花费 120% 与原预算较小者
        day_budget: yuanToLi(budgetYuan),
      },
      category: 'create',
      action: 'manage.campaign.update_budget',
    });
  }

  /** 改组日预算（元 → 厘；0 = 不限） */
  async updateUnitBudget(
    advertiserId: string,
    unitId: string,
    budgetYuan: number,
  ): Promise<Record<string, unknown>> {
    await this.assertWritable(advertiserId);
    return this.gateway.call<Record<string, unknown>>({
      advertiserId,
      path: PLAN_PATHS.UNIT_BUDGET_UPDATE,
      body: {
        advertiser_id: this.numericId(advertiserId),
        unit_id: this.numericId(unitId),
        day_budget: yuanToLi(budgetYuan),
      },
      category: 'create',
      action: 'manage.unit.update_budget',
    });
  }

  /** 改账户日预算（元 → 厘；0 = 不限）。文档 2072：500 元 ≤ 值 ≤ 1 亿 */
  async updateAdvertiserBudget(
    advertiserId: string,
    budgetYuan: number,
  ): Promise<Record<string, unknown>> {
    await this.assertWritable(advertiserId);
    return this.gateway.call<Record<string, unknown>>({
      advertiserId,
      path: MAPI_PATHS.ADVERTISER_BUDGET_UPDATE,
      body: {
        advertiser_id: this.numericId(advertiserId),
        day_budget: yuanToLi(budgetYuan),
      },
      category: 'create',
      action: 'manage.advertiser.update_budget',
    });
  }

  /** 查账户日预算（doc 1961） */
  async getAdvertiserBudget(advertiserId: string): Promise<Record<string, unknown>> {
    return this.gateway.call<Record<string, unknown>>({
      advertiserId,
      path: MAPI_PATHS.ADVERTISER_BUDGET_QUERY,
      body: { advertiser_id: this.numericId(advertiserId) },
      category: 'query',
      action: 'manage.advertiser.get_budget',
    });
  }

  /** 批量改组出价（元 → 厘） */
  async updateUnitBid(
    advertiserId: string,
    unitIds: string[],
    bidYuan: number,
  ): Promise<Record<string, unknown>> {
    await this.assertWritable(advertiserId);
    const ids = [...new Set(unitIds.filter(Boolean))];
    return this.gateway.call<Record<string, unknown>>({
      advertiserId,
      path: PLAN_PATHS.UNIT_BID_UPDATE,
      body: {
        advertiser_id: this.numericId(advertiserId),
        // 文档（1975）：unit_id 与 unit_ids 二选一；批量统一改成一个出价走 unit_ids
        ...(ids.length === 1
          ? { unit_id: this.numericId(ids[0]) }
          : { unit_ids: ids.map((id) => this.numericId(id)) }),
        bid: yuanToLi(bidYuan),
      },
      category: 'create',
      action: 'manage.unit.update_bid',
    });
  }

  /**
   * 改组投放时段（24*7 的 0/1 串）。
   * ⚠️ unit/update 的 unit_name 与 bid_type 是必填 —— 先回读该组再带上这两个字段，
   * 否则会被平台以「参数缺失」打回。
   */
  async updateUnitSchedule(
    advertiserId: string,
    unitId: string,
    scheduleTime: string,
  ): Promise<Record<string, unknown>> {
    await this.assertWritable(advertiserId);
    if (!/^[01]{168}$/.test(scheduleTime)) {
      throw new Error('投放时段格式不合法：应为 168 位（24小时×7天）的 0/1 字符串');
    }
    const units = await this.planApi.listUnits(advertiserId, [unitId]);
    const unit = units[0];
    if (!unit) throw new Error(`未找到广告组 ${unitId}（可能已被删除）`);
    const unitName = unit.unit_name;
    const bidType = unit.bid_type;
    if (unitName == null || bidType == null) {
      throw new Error('平台未返回组名称/出价类型，无法安全修改时段，请稍后重试');
    }
    return this.gateway.call<Record<string, unknown>>({
      advertiserId,
      path: PLAN_PATHS.UNIT_UPDATE,
      body: {
        advertiser_id: this.numericId(advertiserId),
        unit_id: this.numericId(unitId),
        unit_name: String(unitName),
        bid_type: Number(bidType),
        schedule_time: scheduleTime,
      },
      category: 'create',
      action: 'manage.unit.update_schedule',
    });
  }

  /* ---------------- 内部工具 ---------------- */

  /** 响应列表字段名不统一，防御式取值 */
  private pickList(data: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
    if (!data) return [];
    if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
    for (const key of ['campaign_list', 'unit_list', 'creative_list', 'list', 'records', 'details']) {
      const value = (data as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
    }
    return [];
  }

  private num(v: unknown): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  private liToYuan(li: number): number {
    return Math.round(li) / 1000;
  }

  /** 平台 ID 是 long，本地按 string 存，发请求时还原为数字 */
  private numericId(value: string): number | string {
    const trimmed = String(value).trim();
    return /^\d+$/.test(trimmed) && trimmed.length <= 15 ? Number(trimmed) : trimmed;
  }
}
