import { Injectable, Logger } from '@nestjs/common';
import { PLAN_PATHS } from '@wkbd/shared';
import { MapiGateway } from '../../mapi/mapi.gateway';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * 创意属性追踪（细则 1124：按「广告语 / 创意标签 / 分类 / 行动号召」赛马）。
 *
 * 平台报表没有文案维度 → 把每个创意的属性快照落本地（CreativeAttribute），
 * 再和创意级报表 join，按属性聚合出「哪句广告语 / 哪组标签跑得好」。
 *
 * 同步策略：调用方带 sync 时全量拉一次创意列表 upsert 入库；
 * 1 小时内存缓存，避免每次聚合都全量回读。
 */

export type AttrGroupBy = 'description' | 'plcDescription' | 'category' | 'tags' | 'tag' | 'actionBar';

const MATCH_FIELD: Record<Exclude<AttrGroupBy, 'tags' | 'tag'>, 'description' | 'plcDescription' | 'categoryName' | 'actionBarText'> = {
  description: 'description',
  plcDescription: 'plcDescription',
  category: 'categoryName',
  actionBar: 'actionBarText',
};

@Injectable()
export class CreativeAttrsService {
  private readonly logger = new Logger(CreativeAttrsService.name);
  /** advertiserId → 上次全量同步时间 */
  private readonly syncAt = new Map<string, number>();

  constructor(
    private readonly gateway: MapiGateway,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * 创建创意成功后直接落属性（推荐路径）：平台 list 接口不返回广告语/分类名，
   * 但这些参数本来就是创建时传的 —— 创建即入库，比回读更可靠。
   */
  async upsertFromCreate(
    advertiserId: string,
    creativeId: string,
    fields: {
      creativeName?: string;
      unitId?: string;
      campaignId?: string;
      description?: string;
      plcDescription?: string;
      tags?: string[];
      categoryId?: number;
      actionBarText?: string;
    },
  ): Promise<void> {
    if (!creativeId) return;
    const row = {
      advertiserId,
      creativeId,
      creativeName: fields.creativeName ?? null,
      campaignId: fields.campaignId ?? null,
      unitId: fields.unitId ?? null,
      description: fields.description ?? null,
      plcDescription: fields.plcDescription ?? null,
      categoryName: fields.categoryId != null ? String(fields.categoryId) : null,
      tagsJson: fields.tags?.length ? JSON.stringify(fields.tags) : null,
      actionBarText: fields.actionBarText ?? null,
    };
    await this.prisma.creativeAttribute.upsert({
      where: { advertiserId_creativeId: { advertiserId, creativeId } },
      create: row,
      update: row,
    });
  }

  /**
   * 全量同步账户创意属性（分页拉 creative/list，upsert 入库）。
   * cachedWithinMs 内已同步过则跳过（force=1 强制）。
   */
  async sync(advertiserId: string, force = false): Promise<{ count: number; skipped: boolean }> {
    const last = this.syncAt.get(advertiserId) || 0;
    if (!force && Date.now() - last < 3600_000) return { count: 0, skipped: true };
    const items = await this.fetchAllCreatives(advertiserId);
    let count = 0;
    for (const raw of items) {
      const creativeId = raw.creative_id != null ? String(raw.creative_id) : '';
      if (!creativeId) continue;
      const tags = Array.isArray(raw.creative_tag) ? (raw.creative_tag as unknown[]).map(String) : [];
      // list 接口的 description 不在顶层，藏在 display_info.description / recommendation 里
      // （recommendation = 创建时传的广告语，display_info.description = 实际展示文案）
      const di = (raw.display_info ?? {}) as Record<string, unknown>;
      const desc =
        raw.description != null
          ? String(raw.description)
          : di.description != null
            ? String(di.description)
            : raw.recommendation != null
              ? String(raw.recommendation)
              : null;
      const row = {
        advertiserId,
        creativeId,
        creativeName: raw.creative_name != null ? String(raw.creative_name) : null,
        campaignId: raw.campaign_id != null ? String(raw.campaign_id) : null,
        unitId: raw.unit_id != null ? String(raw.unit_id) : null,
        description: desc,
        plcDescription: raw.native_plc_description != null ? String(raw.native_plc_description) : null,
        categoryName: raw.creative_category_name != null ? String(raw.creative_category_name) : null,
        tagsJson: tags.length ? JSON.stringify(tags) : null,
        actionBarText:
          raw.action_bar_text != null
            ? String(raw.action_bar_text)
            : di.action_bar_text != null
              ? String(di.action_bar_text)
              : null,
      };
      await this.prisma.creativeAttribute.upsert({
        where: { advertiserId_creativeId: { advertiserId, creativeId } },
        create: row,
        // 平台 list 接口拿不到的字段（广告语/分类名等）是 null —— 不覆盖本地已有值，
        // 否则一次同步就会把「创建即入库」或人工回填的属性抹掉
        update: Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null)),
      });
      count += 1;
    }
    this.syncAt.set(advertiserId, Date.now());
    this.logger.log(`创意属性同步 账户 ${advertiserId}：${count} 条`);
    return { count, skipped: false };
  }

  /** 全量分页拉取（无 parent 过滤） */
  private async fetchAllCreatives(advertiserId: string): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    for (let page = 1; page <= 25; page += 1) {
      const data = await this.gateway.call<Record<string, unknown>>({
        advertiserId,
        path: PLAN_PATHS.CREATIVE_LIST,
        body: { advertiser_id: Number(advertiserId), page, page_size: 200 },
        category: 'query',
        action: 'report.creativeAttrs.list',
        retry: true,
      });
      const list = this.pickList(data);
      items.push(...list);
      if (list.length < 200) break;
    }
    return items;
  }

  private pickList(data: Record<string, unknown> | undefined): Record<string, unknown>[] {
    for (const key of ['creative_list', 'list', 'records', 'details']) {
      const v = data?.[key];
      if (Array.isArray(v)) return v as Record<string, unknown>[];
    }
    return [];
  }

  /**
   * 组 → 人群包定向映射（gw/dsp/unit/list 的 population / exclude_population 字段）。
   * 用于把创意报表按组归因到人群包：人群包效果追溯的数据底座。
   * 平台组列表会把 DMP 定向回传在 population 字段（文档 2264），
   * 但本地 payload 冻结值只是创建时快照 —— 以平台实时回读为准。
   */
  async unitPopulationMap(advertiserId: string): Promise<{ popMap: Map<string, string[]>; unitCount: number }> {
    const items: Record<string, unknown>[] = [];
    for (let page = 1; page <= 25; page += 1) {
      const data = await this.gateway.call<Record<string, unknown>>({
        advertiserId,
        path: PLAN_PATHS.UNIT_LIST,
        body: { advertiser_id: Number(advertiserId), page, page_size: 200 },
        category: 'query',
        action: 'report.creativeAttrs.unitList',
        retry: true,
      });
      const list = this.pickList(data);
      items.push(...list);
      if (list.length < 200) break;
    }
    const popMap = new Map<string, string[]>();
    for (const raw of items) {
      const unitId = raw.unit_id != null ? String(raw.unit_id) : '';
      if (!unitId) continue;
      const pops = Array.isArray(raw.population) ? (raw.population as unknown[]).map((v) => String(v)) : [];
      if (pops.length) popMap.set(unitId, pops);
    }
    return { popMap, unitCount: items.length };
  }

  /**
   * 按属性维度聚合创意报表。
   * @param advertiserIds 单个账户或多个账户（汇总赛马：同名广告语/标签跨账户合计）
   * @param rows 创意级报表行（controller 先查好再传进来）
   * @param groupBy 聚合维度；tags=标签组合（全组合），tag=单标签展开（一个标签一行）
   */
  async aggregate(
    advertiserIds: string | string[],
    rows: Record<string, unknown>[],
    groupBy: AttrGroupBy,
  ): Promise<Array<Record<string, unknown>>> {
    const ids = Array.isArray(advertiserIds) ? advertiserIds : [advertiserIds];
    const creativeIds = [...new Set(rows.map((r) => String(r.creativeId || '')))].filter(Boolean);
    const attrs = await this.prisma.creativeAttribute.findMany({
      where: { advertiserId: { in: ids }, creativeId: { in: creativeIds } },
    });
    const attrMap = new Map(attrs.map((a) => [a.creativeId, a]));

    // 聚合桶
    const buckets = new Map<
      string,
      { key: string; charge: number; activation: number; payCount: number; payCost: number; creativeCount: Set<string> }
    >();
    const touch = (key: string, creativeId: string) => {
      if (!buckets.has(key)) {
        buckets.set(key, { key, charge: 0, activation: 0, payCount: 0, payCost: 0, creativeCount: new Set() });
      }
      return buckets.get(key)!;
    };
    const groupKeysOf = (attr: (typeof attrs)[number] | undefined): string[] => {
      if (groupBy === 'tags') {
        if (!attr?.tagsJson) return ['（无标签）'];
        return [JSON.parse(attr.tagsJson).join('+')];
      }
      if (groupBy === 'tag') {
        if (!attr?.tagsJson) return ['（无标签）'];
        return JSON.parse(attr.tagsJson) as string[];
      }
      const field = MATCH_FIELD[groupBy];
      const v = attr?.[field];
      return [v ? String(v) : '（未填写）'];
    };

    for (const r of rows) {
      const creativeId = String(r.creativeId || '');
      const attr = attrMap.get(creativeId);
      for (const key of groupKeysOf(attr)) {
        const b = touch(key, creativeId);
        b.charge += Number(r.charge || 0);
        b.activation += Number(r.activation || 0);
        b.payCount += Number(r.payCount || 0);
        b.payCost += Number(r.payCost || 0);
        b.creativeCount.add(creativeId);
      }
    }
    return [...buckets.values()]
      .map((b) => ({
        key: b.key,
        creatives: b.creativeCount.size,
        charge: Number(b.charge.toFixed(2)),
        activation: b.activation,
        actCost: b.activation > 0 ? Number((b.charge / b.activation).toFixed(2)) : null,
        payCount: b.payCount,
        payCost: b.payCount > 0 ? Number((b.charge / b.payCount).toFixed(2)) : null,
      }))
      .sort((a, b) => b.charge - a.charge);
  }
}
