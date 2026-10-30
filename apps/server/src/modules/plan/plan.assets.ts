import { Injectable, Logger } from '@nestjs/common';
import dayjs from 'dayjs';
import { MAPI_PATHS } from '@wkbd/shared';
import { MapiGateway } from '../../mapi/mapi.gateway';

/**
 * 账户资产同步（视频 / 应用 / 建站落地页）。
 *
 * 设计决定：
 * - **不落库**。资产是低频读、可容忍延迟的数据，10 分钟内存缓存足够；
 *   落库反而引入「资产过期了谁负责刷」的一致性问题。前端要新鲜数据就带 force=1。
 * - **防御式取列表**。三个接口的响应外壳不完全一致（video/list 返回
 *   `{total_count, details}` 之类的形状），与 plan.api 的 pickList 同一策略：
 *   全部候选键试一遍，不猜字段名。
 * - 视频 photo_id 是 19 位数字，超出 JS 安全整数范围，统一转字符串。
 */

/** 缓存条目 */
interface CacheEntry {
  expiresAt: number;
  items: unknown;
}

export interface AssetItem {
  /** 平台 ID（视频 photo_id / 应用 app_id / 建站页 site_id），字符串透传 */
  id: string;
  /** 展示名（视频名 / 应用名 / 落地页名），可能为空 */
  name: string;
  /** 缩略图 / 封面地址，视频才有，可能为空 */
  cover?: string;
  /** 素材状态：视频 1=可用；其余接口无此字段 */
  status?: number;
  /** 上传时间（视频 create_time），yyyy-MM-dd HH:mm:ss */
  uploadTime?: string;
  /** 今日消耗（元），素材报表聚合；报表失败时缺省 */
  costToday?: number;
  /** 昨日消耗（元） */
  costYesterday?: number;
  /** 近 7 天消耗（元）——实时素材报表的日期边界是起始 ≥ T-7，
   *  30 天 / 历史累计要等异步报表接入，这里先不放假数据 */
  cost7d?: number;
  /** 原始条目，前端要用其他字段（时长、大小）时兜底 */
  raw: Record<string, unknown>;
}

/** 已授权的原生快手号（gw/dsp/v1/native/user/list） */
export interface NativeKwaiUser {
  /** 达人快手广告 id（user_id），可能超 JS 安全整数，统一字符串 */
  userId: string;
  userName: string;
  headUrl?: string;
  /** 1 普通快手号 / 2 服务号达人 / 3 聚星达人 */
  kolUserType: number;
}

/** 地域树节点（v1/region/list） */
export interface RegionNode {
  id: number;
  name: string;
  /** 1 省 / 2 市 / 3 区县（销售线索外最多到市级） */
  level: number;
  parent: number;
  children: RegionNode[];
}

/** 人群包条目（v2/dmp/population/list） */
export interface PopulationItem {
  /** 人群包 ID（orientation_id），字符串透传 */
  id: string;
  name: string;
  recordSize: number;
  /** 0 计算中 / 1 已生效 / 2 已删除 …（服务端只返回 1） */
  status: number;
}

/** 创意分类树节点（v1/creative/creative_category/list） */
export interface CreativeCategoryNode {
  id: number;
  name: string;
  /** 父分类 ID，根节点为 0 */
  parentId: number;
  /** 层级，从上到下最多三层 */
  level: number;
  children: CreativeCategoryNode[];
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const PAGE_SIZE = 100;
const MAX_ITEMS = 500;
/** 素材取名的单次 id 批量（官方 photo_ids 上限 100） */
const VIDEO_NAME_BATCH = 100;
/** 素材名缓存时长：名称基本不变，缓存一天足够 */
const VIDEO_NAME_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class PlanAssetsService {
  private readonly logger = new Logger(PlanAssetsService.name);
  /** key = `${kind}:${advertiserId}` */
  private readonly cache = new Map<string, CacheEntry>();
  /** 素材报表聚合缓存，key = `videoMetrics:${advertiserId}` */
  private readonly metricCache = new Map<
    string,
    { expiresAt: number; items: Map<string, { today: number; yesterday: number; d7: number }> }
  >();
  /** 素材名缓存，key = `${advertiserId}:${photoId}`（按 id 精确取名用，避免重复请求） */
  private readonly videoNameCache = new Map<string, { name: string; expiresAt: number }>();

  constructor(private readonly gateway: MapiGateway) {}


  async listVideos(advertiserId: string, force = false): Promise<AssetItem[]> {
    const videos = await this.load('video', advertiserId, force, () =>
      this.fetchPaged(advertiserId, MAPI_PATHS.VIDEO_LIST, ['details', 'list', 'videos', 'data']),
    );
    // 消耗指标是增强项：报表挂了不能把整个素材列表拖死，降级为无指标返回
    try {
      const metrics = await this.loadVideoMetrics(advertiserId, force);
      return videos.map((v) => {
        const m = metrics.get(v.id);
        return m ? { ...v, costToday: m.today, costYesterday: m.yesterday, cost7d: m.d7 } : v;
      });
    } catch (err) {
      this.logger.warn(
        `素材报表聚合失败（账户 ${advertiserId}），按无消耗指标返回：${(err as Error).message}`,
      );
      return videos;
    }
  }

  /**
   * 按 photo_id 精确取素材名（素材看板专用）。
   *
   * 为什么不复用 listVideos：那是「挑素材」用的界面列表，被截断在 500 条（MAX_ITEMS），
   * 而**有消耗的素材完全可能排在第 501 条之后** —— 实测某账户 36 个投放中素材里
   * 16 个取不到名，正是因为它们不在前 500 条里。
   * 官方 video/list 支持 photo_ids 过滤（单次 ≤100 个），按需精确查既完整又省配额。
   */
  async listVideoNamesByIds(
    advertiserId: string,
    photoIds: string[],
  ): Promise<Map<string, string>> {
    const unique = [...new Set(photoIds.filter(Boolean))];
    const out = new Map<string, string>();
    if (unique.length === 0) return out;

    // 名称基本不变，命中缓存就不再请求（同一次同步里反复查同一批 id 很常见）
    const missing: string[] = [];
    for (const id of unique) {
      const hit = this.videoNameCache.get(`${advertiserId}:${id}`);
      if (hit && hit.expiresAt > Date.now()) out.set(id, hit.name);
      else missing.push(id);
    }

    for (let i = 0; i < missing.length; i += VIDEO_NAME_BATCH) {
      const batch = missing.slice(i, i + VIDEO_NAME_BATCH);
      try {
        const data = await this.gateway.call<Record<string, unknown>>({
          advertiserId,
          path: MAPI_PATHS.VIDEO_LIST,
          category: 'query',
          body: {
            advertiser_id: Number(advertiserId),
            photo_ids: batch,
            page: 1,
            page_size: batch.length,
          },
          action: 'plan.assets.video_names',
        });
        for (const raw of this.pickList(data, ['details', 'list', 'videos', 'data'])) {
          if (typeof raw !== 'object' || raw === null) continue;
          const item = raw as Record<string, unknown>;
          const id = pickString(item, ['photo_id']);
          const name = pickString(item, ['photo_name', 'name']);
          if (!id || !name) continue;
          out.set(id, name);
          this.videoNameCache.set(`${advertiserId}:${id}`, {
            name,
            expiresAt: Date.now() + VIDEO_NAME_TTL_MS,
          });
        }
      } catch (err) {
        this.logger.warn(
          `账户 ${advertiserId} 素材取名失败（${batch.length} 个 id）：${(err as Error).message}`,
        );
      }
    }
    return out;
  }

  /**
   * 应用列表（含共享应用）。
   * 2026-09-26 实测切换：旧 /v2/file/ad/app/list 只返回账户自有应用，
   * 账户被共享应用时列表为空；改用「获取新版应用发布列表【单元创编】」
   * （gw/dsp/appcenter/app/release/list），list_type 不传 = 全部（自有 + 共享），
   * 条目带 app_id / package_id / real_app_name / source_type(2=共享给我的)。
   */
  async listApps(advertiserId: string, force = false): Promise<AssetItem[]> {
    return this.load('app', advertiserId, force, () =>
      this.fetchPaged(advertiserId, MAPI_PATHS.APP_RELEASE_LIST, ['list', 'details', 'apps', 'data']),
    );
  }

  async listLpPages(advertiserId: string, force = false): Promise<AssetItem[]> {
    return this.load('lp', advertiserId, force, () =>
      this.fetchPaged(advertiserId, MAPI_PATHS.LP_PAGE_LIST, [
        'list',
        'details',
        'pages',
        'data',
      ]),
    );
  }

  /**
   * 账户已授权的原生快手号列表（原生广告投放的「选择快手号」数据源）。
   *
   * 一次拉全三种类型（普通快手号 / 服务号达人 / 聚星达人），前端按授权类型过滤：
   *   服务号授权(1)→kol_user_type 2，达人视频授权(2)→3，普通快手号(3)→1。
   * 注意：普通快手号要求账户在「普通快手号原生白名单」，不在白名单时平台可能返回
   * 空列表或权限错误——错误按原样抛给前端提示，空列表由前端展示「暂无已授权快手号」。
   */
  async listNativeUsers(advertiserId: string, force = false): Promise<NativeKwaiUser[]> {
    return this.loadNativeUsers(advertiserId, force, async () => {
      const data = await this.gateway.call<Record<string, unknown>>({
        advertiserId,
        path: MAPI_PATHS.NATIVE_USER_LIST,
        body: { advertiser_id: Number(advertiserId), kol_user_type: [1, 2, 3] },
        action: 'plan.assets.native_user_list',
      });
      const list = this.pickList(data, ['user_list', 'list', 'users', 'details', 'data']);
      const users: NativeKwaiUser[] = [];
      for (const item of list) {
        if (typeof item !== 'object' || item === null) continue;
        const row = item as Record<string, unknown>;
        const userId = pickString(row, ['user_id', 'userId', 'id']);
        if (!userId) continue;
        users.push({
          userId,
          userName: pickString(row, ['user_name', 'userName', 'name']) || userId,
          headUrl: pickString(row, ['head_url', 'headurl', 'avatar']) || undefined,
          kolUserType:
            typeof row.kol_user_type === 'number'
              ? row.kol_user_type
              : Number(row.kol_user_type) || 0,
        });
      }
      this.logger.log(`原生快手号同步 账户 ${advertiserId}：${users.length} 个`);
      return users;
    });
  }

  /**
   * 地域定向树（v1/region/list，GET）。
   * 平台返回 id → {id,level,name,parent,children} 的映射，这里整理成带 children 的树，
   * 并按 name 排序保证省份顺序稳定；供定向抽屉 TreeSelect 使用。
   */
  async listRegions(advertiserId: string, force = false): Promise<RegionNode[]> {
    return this.loadTree('regionTree', advertiserId, force, async () => {
      const data = await this.gateway.call<Record<string, unknown>>({
        advertiserId,
        path: MAPI_PATHS.REGION_LIST,
        httpMethod: 'GET',
        body: {},
        action: 'plan.assets.region_list',
      });
      const map = (data.data ?? data) as Record<string, { id?: number; name?: string; level?: number; parent?: number }>;
      const nodes = new Map<number, RegionNode>();
      for (const raw of Object.values(map ?? {})) {
        if (!raw || typeof raw !== 'object') continue;
        nodes.set(Number(raw.id), {
          id: Number(raw.id),
          name: String(raw.name ?? ''),
          level: Number(raw.level ?? 0),
          parent: Number(raw.parent ?? 0),
          children: [],
        });
      }
      const roots: RegionNode[] = [];
      for (const node of nodes.values()) {
        const parent = nodes.get(node.parent);
        if (parent && node.parent !== node.id) parent.children.push(node);
        else roots.push(node);
      }
      const sortTree = (list: RegionNode[]) => {
        list.sort((a, b) => a.id - b.id);
        for (const n of list) if (n.children.length) sortTree(n.children);
      };
      sortTree(roots);
      this.logger.log(`地域树同步：${nodes.size} 个节点，根 ${roots.length} 个`);
      return roots;
    });
  }

  /**
   * 人群包列表（v2/dmp/population/list）。
   * 只取「已生效(1)」的包；orientation_id 超出 JS 安全整数，统一字符串化。
   */
  async listPopulations(advertiserId: string, force = false): Promise<PopulationItem[]> {
    const kind = `population:${advertiserId}`;
    if (!force) {
      const hit = this.cache.get(kind);
      if (hit && hit.expiresAt > Date.now()) return hit.items as PopulationItem[];
    }
    const data = await this.gateway.call<Record<string, unknown>>({
      advertiserId,
      path: MAPI_PATHS.POPULATION_LIST,
      body: { advertiser_id: Number(advertiserId), page: 1, page_size: 100 },
      action: 'plan.assets.population_list',
    });
    const list = this.pickList(data, ['list', 'details', 'populations', 'data']);
    const items: PopulationItem[] = [];
    for (const item of list) {
      if (typeof item !== 'object' || item === null) continue;
      const row = item as Record<string, unknown>;
      const id = pickString(row, ['orientation_id', 'id']);
      const name = pickString(row, ['orientation_name', 'name']);
      if (!id) continue;
      items.push({
        id,
        name: name || id,
        recordSize: typeof row.record_size === 'number' ? row.record_size : Number(row.record_size) || 0,
        status: typeof row.status === 'number' ? row.status : Number(row.status) || 0,
      });
    }
    const active = items.filter((i) => i.status === 1);
    this.cache.set(kind, { expiresAt: Date.now() + CACHE_TTL_MS, items: active as unknown });
    this.logger.log(`人群包同步 账户 ${advertiserId}：${active.length} 个已生效`);
    return active;
  }

  /**
   * 创意分类树（v1/creative/creative_category/list，POST）。
   *
   * 官方返回「倒着的树」：details 里每个节点带 category_id / parent_id / category_name / level，
   * parent_id 指向父节点，根节点 parent_id 为 0；没有子节点引用它的即叶子 ——
   * 创建创意时 creative_category 只能传叶子类目。树基本不变，缓存 24 小时。
   */
  async listCreativeCategories(advertiserId: string, force = false): Promise<CreativeCategoryNode[]> {
    return this.loadTree('creativeCategoryTree', advertiserId, force, async () => {
      const data = await this.gateway.call<Record<string, unknown>>({
        advertiserId,
        path: MAPI_PATHS.CREATIVE_CATEGORY_LIST,
        body: { advertiser_id: Number(advertiserId) },
        action: 'plan.assets.creative_category_list',
      });
      const list = this.pickList(data, ['details', 'list', 'data']);
      const nodes = new Map<number, CreativeCategoryNode>();
      for (const item of list) {
        if (typeof item !== 'object' || item === null) continue;
        const row = item as Record<string, unknown>;
        const id = Number(row.category_id);
        if (!Number.isFinite(id) || id <= 0) continue;
        nodes.set(id, {
          id,
          name: pickString(row, ['category_name', 'name']) || String(id),
          parentId: Number(row.parent_id) || 0,
          level: Number(row.level) || 1,
          children: [],
        });
      }
      const roots: CreativeCategoryNode[] = [];
      for (const node of nodes.values()) {
        const parent = nodes.get(node.parentId);
        if (parent && node.parentId !== node.id) parent.children.push(node);
        else roots.push(node);
      }
      const sortTree = (listNodes: CreativeCategoryNode[]) => {
        listNodes.sort((a, b) => a.id - b.id);
        for (const n of listNodes) if (n.children.length) sortTree(n.children);
      };
      sortTree(roots);
      this.logger.log(`创意分类同步 账户 ${advertiserId}：${nodes.size} 个节点，根 ${roots.length} 个`);
      return roots;
    });
  }

  /* ---------------- 内部 ---------------- */

  /**
   * 素材维度报表聚合：按 photo_id 汇总今日 / 昨日 / 近 7 天消耗。
   *
   * 实测约束（2026-09 探测）：
   * - /v1/report/material_report 必须带 view_type=5（视频报表），否则 401000；
   * - 响应无 code 外壳，直接回 {total_count, details}（网关已兼容）；
   * - 起始日期不得早于 T-7，否则 401003「选取起始时间超过允许范围」；
   *   因此只有近 7 天口径，30 天 / 历史累计需异步报表（未接入）。
   */
  private async loadVideoMetrics(
    advertiserId: string,
    force: boolean,
  ): Promise<Map<string, { today: number; yesterday: number; d7: number }>> {
    return this.loadMetrics(advertiserId, force, async () => {
      const today = dayjs().format('YYYY-MM-DD');
      const start = dayjs().subtract(7, 'day').format('YYYY-MM-DD'); // 边界内取 8 天窗口，聚合口径见字段注释
      const byPhoto = new Map<string, { today: number; yesterday: number; d7: number }>();
      const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');

      for (let page = 1; page <= 5; page += 1) {
        const data = await this.gateway.call<Record<string, unknown>>({
          advertiserId,
          path: MAPI_PATHS.REPORT_MATERIAL,
          category: 'query',
          body: {
            advertiser_id: Number(advertiserId),
            start_date: start,
            end_date: today,
            temporal_granularity: 'DAILY',
            view_type: 5,
            page,
            page_size: 1000,
          },
          action: 'plan.assets.material_report',
        });
        const list = this.pickList(data, ['details', 'list', 'rows', 'data']);
        for (const item of list) {
          if (typeof item !== 'object' || item === null) continue;
          const row = item as Record<string, unknown>;
          const photoId = pickString(row, ['photo_id']);
          if (!photoId) continue;
          const charge = typeof row.charge === 'number' ? row.charge : Number(row.charge) || 0;
          const statDate = typeof row.stat_date === 'string' ? row.stat_date : '';
          const acc = byPhoto.get(photoId) ?? { today: 0, yesterday: 0, d7: 0 };
          acc.d7 = round2(acc.d7 + charge);
          if (statDate === today) acc.today = round2(acc.today + charge);
          if (statDate === yesterday) acc.yesterday = round2(acc.yesterday + charge);
          byPhoto.set(photoId, acc);
        }
        if (list.length < 1000) break;
      }
      this.logger.log(`素材报表聚合 账户 ${advertiserId}：${byPhoto.size} 个素材`);
      return byPhoto;
    });
  }

  private async load<T = AssetItem>(
    kind: string,
    advertiserId: string,
    force: boolean,
    fetcher: () => Promise<T>,
  ): Promise<T> {
    const key = `${kind}:${advertiserId}`;
    if (!force) {
      const hit = this.cache.get(key);
      if (hit && hit.expiresAt > Date.now()) return hit.items as T;
    }
    const items = await fetcher();
    this.cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, items: items as unknown });
    return items;
  }

  /** 长期树形缓存的通用加载（地域树 / 创意分类树共用，按 kind 区分 key，缓存 24h） */
  private async loadTree<T>(
    kind: string,
    advertiserId: string,
    force: boolean,
    fetcher: () => Promise<T>,
  ): Promise<T> {
    const key = `tree:${kind}`;
    if (!force) {
      const hit = this.cache.get(key);
      if (hit && hit.expiresAt > Date.now()) return hit.items as T;
    }
    const items = await fetcher();
    this.logger.log(`${kind} 同步 账户 ${advertiserId} 完成`);
    // 树形字典基本不变，缓存 24 小时
    this.cache.set(key, { expiresAt: Date.now() + 24 * 60 * 60 * 1000, items: items as unknown });
    return items;
  }

  /** 原生快手号列表的独立缓存（值类型与资产列表不同） */
  private async loadNativeUsers(
    advertiserId: string,
    force: boolean,
    fetcher: () => Promise<NativeKwaiUser[]>,
  ): Promise<NativeKwaiUser[]> {
    const key = `nativeUsers:${advertiserId}`;
    if (!force) {
      const hit = this.cache.get(key);
      if (hit && hit.expiresAt > Date.now()) return hit.items as NativeKwaiUser[];
    }
    const items = await fetcher();
    this.cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, items: items as unknown });
    return items;
  }

  /** 素材报表聚合的独立缓存（值类型与资产列表不同，不与 load 混用） */
  private async loadMetrics(
    advertiserId: string,
    force: boolean,
    fetcher: () => Promise<Map<string, { today: number; yesterday: number; d7: number }>>,
  ): Promise<Map<string, { today: number; yesterday: number; d7: number }>> {
    const key = `videoMetrics:${advertiserId}`;
    if (!force) {
      const hit = this.metricCache.get(key);
      if (hit && hit.expiresAt > Date.now()) return hit.items;
    }
    const items = await fetcher();
    this.metricCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, items });
    return items;
  }

  /** 通用翻页拉取：拿到 MAX_ITEMS 或不足一页为止；单页失败不重试（网关已带重试） */
  private async fetchPaged(
    advertiserId: string,
    path: string,
    listKeys: string[],
  ): Promise<AssetItem[]> {
    const all: AssetItem[] = [];
    for (let page = 1; page <= Math.ceil(MAX_ITEMS / PAGE_SIZE); page += 1) {
      const data = await this.gateway.call<Record<string, unknown>>({
        advertiserId,
        path,
        body: { advertiser_id: Number(advertiserId), page, page_size: PAGE_SIZE },
        action: `plan.assets.${path.split('/').pop()}`,
      });
      const list = this.pickList(data, listKeys);
      for (const item of list) {
        if (typeof item !== 'object' || item === null) continue;
        all.push(this.toAssetItem(item as Record<string, unknown>));
        if (all.length >= MAX_ITEMS) return all;
      }
      if (list.length < PAGE_SIZE) break;
    }
    this.logger.log(`资产同步 ${path} 账户 ${advertiserId}：${all.length} 条`);
    return all;
  }

  private pickList(
    data: Record<string, unknown> | undefined,
    keys: string[],
  ): unknown[] {
    if (!data) return [];
    const inner = (data.data ?? data) as Record<string, unknown>;
    for (const key of keys) {
      const value = inner[key] ?? data[key];
      if (Array.isArray(value)) return value;
    }
    return [];
  }

  private toAssetItem(item: Record<string, unknown>): AssetItem {
    const id = pickString(item, ['photo_id', 'app_id', 'site_id', 'page_id', 'id']);
    const name = pickString(item, [
      'photo_name',
      'app_name',
      'real_app_name',
      'site_name',
      'page_name',
      'name',
      'title',
    ]);
    const cover = pickString(item, ['photo_url', 'cover_url', 'image_url', 'poster_url', 'app_icon_url', 'url']);
    const status = typeof item.new_status === 'number' ? item.new_status : undefined;
    const uploadTime = pickString(item, ['create_time', 'upload_time', 'created_time']);
    return { id, name, cover, status, uploadTime: uploadTime || undefined, raw: item };
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function pickString(item: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === 'string' && value.length > 0) return value;
    // 19 位 photo_id 会以 number 出现，必须字符串化而不是直接用
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}
