import { PlanRow, yuanToLi } from '@wkbd/shared';
import { toId, toIdArray } from '../../common/id';

/**
 * 表格行 → 平台请求体。
 *
 * 三个设计决定（每个都是踩过或会踩的坑）：
 * 1. **金额换算只在这里发生**。表格里填的是「元」，平台要「厘」，
 *    换算点越少越不容易出错，所以收敛到本文件。
 * 2. **只下发有值的字段**。平台对「传了空值」和「不传」的处理不一致
 *    （例如 schedule_time 传全 0 会被视为全时段），因此 null/undefined 一律剔除。
 * 3. **必填的容器字段给默认值**（如 target 下的 behavior_type），
 *    否则平台会报「字段缺失」，而这些字段业务上其实是「不限」的意思。
 */
export function buildCampaignPayload(row: PlanRow): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    advertiser_id: toId(row.advertiserId),
    campaign_name: row.campaignName.trim(),
    type: row.campaignType,
  };

  if (row.adType != null) payload.ad_type = row.adType;
  if (row.campaignBidType != null && row.campaignBidType !== 0) {
    payload.bid_type = row.campaignBidType;
  }
  // 全自动投放（UAX）：官方要求开启时必须同时开启自动调控与自动基建，白名单功能。
  // ⚠️ 官方硬约束（2026-09-29 实测踩坑）：auto_build=1 时必填 auto_build_name_rule，
  // 且组/创意命名规则必须同时包含 [日期] 和 [序号] 宏变量，缺任一即报
  // 401000「开启自动起量后各项目参数不符合规范」→ 整条任务全失败。
  if (row.autoManage === 1) {
    payload.auto_manage = 1;
    payload.auto_adjust = 1;
    payload.auto_build = 1;
    payload.auto_build_name_rule = {
      unit_name_rule: autoNameRule(row.unitName || row.campaignName),
      creative_name_rule: autoNameRule(row.creativeName || row.campaignName),
    };
  }
  // ⚠️ 计划层没有 feed_deliver_search（搜索快投）：官方创建计划接口无此字段，
  // 搜索快投的真实下发位置是组层 quick_search —— 见 buildUnitPayload 的搜索段。
  // 周期稳投（白名单）：仅展示广告支持——创量实测搜索广告（含全自动投放态）无此区块，
  // 因此 ad_type=1 的行即使误带 periodic 字段也一律剥离（双保险，前端已同步门控）。
  if (row.adType !== 1 && row.periodicDeliveryType === 1) {
    payload.periodic_delivery_type = 1;
    if (row.periodicDays) payload.periodic_days = row.periodicDays;
    if (row.continuePeriodType != null) payload.continue_period_type = row.continuePeriodType;
    if (row.rangeBudgetYuan != null && row.rangeBudgetYuan > 0) {
      payload.range_budget = yuanToLi(row.rangeBudgetYuan);
    }
  }
  if (row.campaignDayBudgetYuan != null && row.campaignDayBudgetYuan > 0) {
    payload.day_budget = yuanToLi(row.campaignDayBudgetYuan);
  }

  return dropEmpty(payload);
}

/**
 * UAX 自动基建命名规则。
 * 行上的名称是宏展开后的实际值（[序号] 已变成数字），无法还原模板；
 * 以基础名为前缀，剥离残留的括号宏，再补齐官方强制的 [日期]/[序号] 宏变量。
 */
function autoNameRule(base: string): string {
  const clean =
    base
      .replace(/[【[][^】\]]*[】\]]/g, '') // 剥离残留宏，避免把 [账户ID] 之类当字面量
      .replace(/[-_\s]+$/g, '')
      .trim() || '自动搭建';
  return `${clean}-[日期][序号]`.slice(0, 100);
}

/** 保留键：搜索关键词元数据，任务引擎在调平台前剥离（见 task.service.executeItem) */
export const SEARCH_KEYWORDS_META = '__search_keywords';

export interface SearchKeywordsMeta {
  match_type: number;
  words: string[];
}

/** 组层：字段最多，也是营销目标差异集中体现的地方 */
export function buildUnitPayload(
  row: PlanRow,
  campaignId: string,
  putStatus: number,
  /** 一个计划展开多个组时逐组覆盖名称（不带序号时用行上的基础组名） */
  nameOverride?: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    advertiser_id: toId(row.advertiserId),
    campaign_id: toId(campaignId),
    unit_name: (nameOverride ?? row.unitName).trim(),
    bid_type: row.bidType,
    scene_id: row.sceneIds,
    unit_type: row.unitType,
    begin_time: row.beginTime,
    target: buildTarget(row),
    // 组层是**唯一**能在创建时指定投放状态的一层：计划层与创意层的创建接口都没有状态字段。
    // 官方明确「不传或为 null 时默认填充 1（投放中）」，所以想暂停必须显式传 2。
    put_status: putStatus,
  };

  // 出价：CPC 走 bid，OCPM/MCB 走 cpa_bid（平台按 bid_type 二选一）
  if (row.bidType === 2 && row.bidYuan != null) payload.bid = yuanToLi(row.bidYuan);
  if (row.bidType !== 2 && row.cpaBidYuan != null) payload.cpa_bid = yuanToLi(row.cpaBidYuan);
  if (row.bidType !== 2 && row.ocpxActionType) payload.ocpx_action_type = row.ocpxActionType;

  if (row.endTime) payload.end_time = row.endTime;
  if (row.scheduleTime && /^[01]{168}$/.test(row.scheduleTime) && !/^0{168}$/.test(row.scheduleTime)) {
    payload.schedule_time = row.scheduleTime;
  }
  if (row.unitDayBudgetYuan != null && row.unitDayBudgetYuan > 0) {
    payload.day_budget = yuanToLi(row.unitDayBudgetYuan);
  }
  // 创意展现方式：1 轮播 / 2 优选（平台默认，不传即优选）
  if (row.showMode != null && row.showMode !== 2) payload.show_mode = row.showMode;
  // 深度转化目标（双出价）：类型 + 出价（需大于浅层出价，白名单）
  if (row.deepConversionType) {
    payload.deep_conversion_type = row.deepConversionType;
    if (row.deepConversionBidYuan != null && row.deepConversionBidYuan > 0) {
      payload.deep_conversion_bid = yuanToLi(row.deepConversionBidYuan);
    }
  }
  // 付费 ROI 系数：优化目标为首日/7日 ROI 时官方必填
  if (row.roiRatio != null && row.roiRatio > 0) payload.roi_ratio = row.roiRatio;
  // 应用下载方式 / 应用商店（仅应用类营销目标，白名单生效）
  if (row.appDownloadType != null) payload.app_download_type = row.appDownloadType;
  if (row.useAppMarket != null) payload.use_app_market = row.useAppMarket;
  if (row.useAppMarket === 1 && row.appStores?.length) payload.app_store = row.appStores;

  // 链路参数（按营销目标透传，未填的不下发）
  Object.assign(payload, pickLinkFields(row));

  // 原生投放（outer_loop_native）：**组层与创意层必须同时开启**，否则创意创建会被平台
  // 拒绝（实测 401000「创意对应的unit没有开启原生」/ 4001001「创意形式unit_style没有开启
  // 或生成」）。官方：原生仅信息流广告（ad_type=0，scene_id 含 1/6/7）支持。
  if (row.outerLoopNative === 1 && row.adType !== 1) {
    payload.outer_loop_native = 1;
  }

  // ——— 搜索快投 / 搜索广告的组层能力字段 ———
  // 依据：Go SDK model/dsp/unit/create.go（scene_id 39=搜索广告、quick_search、
  // extend_search、target_explore、negative_word_param）+ 创量真实表单实测（2026-09-25）：
  // 搜索快投属于展示广告（信息流）组层开关；搜索广告（ad_type=1）只有扩词/否词/人群追投。
  //
  // ⚠️ 2026-10-08 线上实测补充（必须保留这条强制逻辑）：
  //    平台对 quick_search 有跨字段硬校验 —— quick_search=1 时必须同时下发
  //    extend_search=true，否则组创建被拒：401000「搜索快投必须开启智能扩词」。
  //    此前「智能扩词」开关只在 adType=1 分支暴露给用户，快投用户根本拿不到它，
  //    于是必然撞这个错。现在改为：快投场景无条件补全，不依赖用户勾选。
  const quickSearch = row.adType === 0 && row.searchQuick === 1;
  if (quickSearch) {
    // 搜索快投：展示广告组开启后无需关键词即获得搜索流量（需白名单）
    payload.quick_search = 1;
  }
  // 智能扩词（extend_search，boolean 而非 0/1）：快投场景平台强制开启；搜索广告按用户开关
  if (quickSearch || (row.adType === 1 && row.searchExtend === 1)) {
    payload.extend_search = true;
  }
  if (row.adType === 1) {
    if (row.searchExplore === 1) payload.target_explore = 1;
    // 否词：短语否定词 / 精确否定词（官方各支持 200 个）
    if (row.searchNegPhrase?.length || row.searchNegExact?.length) {
      payload.negative_word_param = {
        ...(row.searchNegPhrase?.length ? { phrase_words: row.searchNegPhrase } : {}),
        ...(row.searchNegExact?.length ? { exact_words: row.searchNegExact } : {}),
      };
    }
    // 关键词走独立接口（v2/word_info/create 需要 campaign_id + unit_id），
    // 挂在保留键上由任务引擎剥离，绝不混进 unit/create 请求体。
    if (row.searchKeywords?.length) {
      payload[SEARCH_KEYWORDS_META] = {
        match_type: row.searchMatchType ?? 3,
        words: [...new Set(row.searchKeywords.map((w) => w.trim()).filter(Boolean))].slice(0, 1000),
      };
    }
  }

  return dropEmpty(payload);
}

export function buildCreativePayload(
  row: PlanRow,
  unitId: string,
  /** 创意组模型：一行多创意时按视频逐个构建；不传则用行上自带的素材 */
  video?: { photoId: string; description?: string | null },
  /** 覆盖创意名：多创意时任务引擎传入带 -创XX 后缀的名字（组内唯一，平台校验） */
  creativeNameOverride?: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    advertiser_id: toId(row.advertiserId),
    unit_id: toId(unitId),
    creative_name: (creativeNameOverride ?? row.creativeName).trim(),
    creative_material_type: row.materialType,
    action_bar_text: row.actionBarText.trim(),
  };

  if (video) {
    if (video.photoId) payload.photo_id = video.photoId;
    if (video.description) payload.description = video.description;
  } else {
    if (row.photoId) payload.photo_id = row.photoId;
    if (row.imageToken) payload.image_token = row.imageToken;
    if (row.imageTokens?.length) payload.image_tokens = row.imageTokens;
    if (row.description) payload.description = row.description;
  }
  // 创意分类与创意标签：官方校验「要么都传，要么都不传」，缺一就都不发
  if (row.creativeCategory && row.creativeTags?.length) {
    payload.creative_category = row.creativeCategory;
    payload.creative_tag = row.creativeTags;
  }

  // PLC 自定义文案（recommendation）：直达链接贴片描述，≤13 字
  if (row.recommendation) payload.recommendation = row.recommendation;

  // 原生广告：outer_loop_native=1 时官方要求 kol_user_type / kol_user_id 必填
  if (row.outerLoopNative === 1 && row.kolUserType) {
    payload.outer_loop_native = 1;
    payload.kol_user_type = row.kolUserType;
    if (row.kolUserId) payload.kol_user_id = toId(row.kolUserId);
  }

  // 推荐理由（new_expose_tag）：[{text:"工厂直发"}, …]，官方最多 2 个
  if (row.newExposeTags?.length) payload.new_expose_tag = row.newExposeTags;

  // 第三方监测链接（创意层）：
  // - 点击监测：自定义创意 click_track_url / 程序化创意 click_url（官方：优化目标为
  //   激活且应用未接 SDK 时必填，否则转化数据无法回传）；
  // - 开始播放监测：impression_url，仅自定义创意支持。
  if (row.clickMonitorUrl) {
    payload[row.unitType === 7 ? 'click_url' : 'click_track_url'] = row.clickMonitorUrl;
  }
  if (row.impressionMonitorUrl && row.unitType !== 7) {
    payload.impression_url = row.impressionMonitorUrl;
  }

  return dropEmpty(payload);
}

/** 定向结构。空值一律不下发，让平台走「不限」默认行为 */
function buildTarget(row: PlanRow): Record<string, unknown> {
  const target: Record<string, unknown> = {};

  if (row.region?.length) target.region = row.region;
  if (row.gender != null && row.gender !== 0) target.gender = row.gender;
  if (row.agesRange?.length) target.ages_range = row.agesRange;
  if (row.platformOs != null && row.platformOs !== 0) target.platform_os = row.platformOs;
  if (row.network != null && row.network !== 0) target.network = row.network;

  // 定向抽屉的完整参数透传（白名单键，防止未知字段直入请求体）。
  // 与上方固定字段重名时以前端定向抽屉为准（前端构造时已避开）。
  if (row.targeting && typeof row.targeting === 'object') {
    for (const [key, value] of Object.entries(row.targeting)) {
      if (!TARGET_PASSTHROUGH_KEYS.has(key)) continue;
      if (value === null || value === undefined || value === '') continue;
      if (Array.isArray(value) && value.length === 0) continue;
      target[key] = value;
    }
  }

  // behavior_type 在「target 非空」时必填且无默认值 —— 固定给「不限」。
  // 这是官方文档明确的一条硬约束，漏了会直接报错；定向抽屉选了「系统优选」则用前端传的 2。
  if (target.behavior_type == null) target.behavior_type = 0;

  return target;
}

/** 允许从 row.targeting 透传进平台 target 的字段（gw/dsp/unit/create target 全集） */
const TARGET_PASSTHROUGH_KEYS = new Set([
  'region',
  'user_type',
  'ages_range',
  'gender',
  'platform_os',
  'android_osv',
  'ios_osv',
  'network',
  'device_brand_ids',
  'device_price',
  'app_interest_ids',
  'app_ids',
  'filter_converted_level',
  'population',
  'exclude_population',
  'inteli_extend_option',
  'behavior_type',
  'disable_installed_app_switch',
  'filter_time_range',
]);

/** 按营销目标挑出链路字段 */
function pickLinkFields(row: PlanRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const setId = (key: string, value: string | number | null | undefined) => {
    if (value === null || value === undefined || value === '') return;
    out[key] = typeof value === 'string' && /^\d+$/.test(value) ? toId(value) : value;
  };

  setId('app_id', row.appId);
  setId('package_id', row.packageId);
  setId('site_id', row.siteId);
  setId('group_id', row.groupId);
  setId('series_id', row.seriesId);
  setId('episode_id', row.episodeId);
  setId('jingle_bell_id', row.jingleBellId);
  setId('live_user_id', row.liveUserId);

  if (row.webUriType) out.web_uri_type = row.webUriType;
  if (row.url) out.url = row.url;
  if (row.schemaUri) out.schema_uri = row.schemaUri;

  // 直播推广的转化途径固定为 6（官方文档明确）
  if (row.campaignType === 16) out.conversion_type = 6;

  return out;
}

/** 剔除 null / undefined / 空字符串；数组为空也剔除（空数组表示「不限」的字段除外） */
function dropEmpty(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

/** 幂等键：同一任务内，同样内容只提交一次（用户误粘贴重复行时能挡住） */
export function idemKeyOf(level: string, row: PlanRow): string {
  const base = `${level}:${row.advertiserId}:${row.rowNo}`;
  const sig =
    level === 'CAMPAIGN'
      ? row.campaignName
      : level === 'UNIT'
        ? row.unitName
        : row.creativeName;
  return `${base}:${sig}`.slice(0, 180);
}

export { toIdArray };
