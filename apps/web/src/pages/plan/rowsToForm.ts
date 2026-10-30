import type { PlanRow } from '@wkbd/shared';
import type { CardForm } from './PlanCardMode';

/**
 * 任务行快照 → 上计划表单（CardForm）。
 *
 * 「批量任务 → 复制」跳转到上计划页时，用任务创建时的 PlanRow 快照
 * 反解出表单配置，让用户在上一次投放配置的基础上修改后重新生成。
 *
 * 反解规则与 buildRows（PlanCardMode）的构造一一对应；不可逆的字段
 * （如随机/阶梯出价的原始区间、全自动命名模板通配符）用合理默认值兜底。
 */

/** 去掉名称尾部动态标号（_01 / -02 / _07）拿前缀与起始序号 */
function splitNameSuffix(name: string): { prefix: string; seq: number | null } {
  const m = /^(.*?)[_-](\d+)$/.exec(name.trim());
  if (!m) return { prefix: name.trim(), seq: null };
  return { prefix: m[1], seq: Number(m[2]) };
}

const parseSeries = (s: string): boolean[] => {
  const cells = s.padEnd(168, '0').slice(0, 168);
  return Array.from(cells, (c) => c === '1');
};

export function rowsToCardForm(rows: PlanRow[]): Partial<CardForm> & { __videos?: string[] } {
  const first = rows[0];
  if (!first) return {};

  // 名称前缀 / 起始序号：从行名称反推（buildRows 用 `_序号` 生成）
  const unitSplit = splitNameSuffix(first.unitName);
  const creativeSplit = splitNameSuffix(first.creativeName);

  // 定向扩展（buildTargetingPayload 的逆变换）；「不限」字段缺省即正确
  const t = (first.targeting && typeof first.targeting === 'object' ? first.targeting : {}) as Record<
    string,
    unknown
  >;
  const num = (v: unknown, d: number): number => (typeof v === 'number' ? v : v != null ? Number(v) : d);
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const targeting = {
    intelliExtend: num(t.inteli_extend_option, 0),
    userType: num(t.user_type, 2),
    regionIds: arr(t.region ?? first.region).map(Number),
    agesRange: arr(t.ages_range ?? first.agesRange).map(Number),
    deviceBrands: arr(t.device_brand_ids).map(Number),
    devicePrices: arr(t.device_price).map(Number),
    filterConvertedLevel: num(t.filter_converted_level, 0),
    disableInstalledApp: num(t.disable_installed_app_switch, 0),
    behaviorType: num(t.behavior_type, 0),
    population: arr(t.population).map(String),
    excludePopulation: arr(t.exclude_population).map(String),
  };

  // 文案：按视频顺序收集（buildRows 按视频轮转分配，去重还原成文案列表）
  const titlesList: string[] = [];
  // 已选素材：photo_id 即素材库 AssetItem.id（plan.assets 统一字符串化）
  const videos: string[] = [];
  // units 模型（素材切分装填）：从 units 收集；旧快照回退 creativeVideos
  const videosOf = (row: PlanRow): Array<{ photoId?: string | null; description?: string | null }> =>
    row.units && row.units.length > 0
      ? row.units.flatMap((u) => u.videos)
      : (row.creativeVideos ?? []);
  for (const row of rows) {
    for (const v of videosOf(row)) {
      const s = (v.description ?? '').trim();
      if (s && !titlesList.includes(s)) titlesList.push(s);
    }
  }
  for (const row of rows) {
    for (const v of videosOf(row)) {
      if (v.photoId && !videos.includes(v.photoId)) videos.push(v.photoId);
    }
    if (!videosOf(row).length && row.photoId && !videos.includes(row.photoId)) {
      videos.push(row.photoId);
    }
  }

  // 每组视频数 / 每计划组数：units 模型从首计划反推；旧快照回退 creativeVideos/unitsPerCampaign
  const groupSize = first.units?.length
    ? Math.min(15, Math.max(1, ...first.units.map((u) => u.videos.length || 8)))
    : Math.min(15, Math.max(1, first.creativeVideos?.length || 8));
  const isMaxConvert = first.bidType === 12;
  const timeSeriesRaw = first.scheduleTime && /^[01]{168}$/.test(first.scheduleTime)
    ? parseSeries(first.scheduleTime)
    : null;

  const form: Partial<CardForm> & { __videos?: string[] } = {
    advertiserId: first.advertiserId,
    adType: first.adType ?? 0,
    putMode: first.autoManage === 1 ? 'auto' : 'normal',
    cycleStable: first.periodicDeliveryType === 1,
    stableDays: first.periodicDays === 5 ? 5 : 7,
    stableRenew: first.continuePeriodType === 2,
    cycleBudgetYuan: first.rangeBudgetYuan ?? null,
    // 命名：动态标号起始值从行名称反推；自动投放模板通配符不可逆，交给用户确认
    namePrefix: unitSplit.prefix,
    unitSeqStart: unitSplit.seq ?? 1,
    creativeSeqStart: creativeSplit.seq ?? 1,
    sceneMode: (first.sceneIds ?? []).includes(1) ? 1 : 2,
    sceneIds: [...(first.sceneIds ?? [1])],
    bidStrategy: first.campaignBidType === 1 ? 1 : 0,
    // 出价方式不可逆（fixed/random/ladder 无法区分），固定出价最保守
    bidMode: 'fixed',
    bidType: isMaxConvert ? 10 : first.bidType,
    bidYuan: first.bidYuan ?? null,
    cpaBidYuan: first.cpaBidYuan ?? null,
    bidMinYuan: null,
    bidMaxYuan: null,
    ocpxActionType: first.ocpxActionType ?? null,
    roiRatio: first.roiRatio ?? null,
    deepEnabled: first.deepConversionType != null,
    deepConversionType: first.deepConversionType ?? 3,
    deepConversionBidYuan: first.deepConversionBidYuan ?? null,
    platformOs: first.platformOs ?? 0,
    downloadMode: first.appDownloadType === 1 ? 1 : 0,
    useAppMarket: first.useAppMarket === 1,
    appStores: first.appStores?.length ? [...first.appStores] : undefined,
    gender: first.gender ?? 0,
    network: first.network ?? 0,
    targeting,
    budgetMode:
      first.campaignDayBudgetYuan != null || first.unitDayBudgetYuan != null
        ? 'unified'
        : 'unlimited',
    campaignDayBudgetYuan: first.campaignDayBudgetYuan ?? null,
    unitDayBudgetYuan: first.unitDayBudgetYuan ?? null,
    scheduleMode: first.endTime ? 'custom' : 'long',
    beginTime: first.beginTime,
    endTime: first.endTime ?? '',
    timeMode: timeSeriesRaw ? 'custom' : 'all',
    timeSeries: timeSeriesRaw ?? undefined,
    showMode: first.showMode ?? 2,
    actionBarText: first.actionBarText,
    creativeTags: first.creativeTags?.length ? [...first.creativeTags] : [],
    creativeCategory: first.creativeCategory ?? null,
    searchQuick: first.searchQuick === 1,
    searchExtend: first.searchExtend === 1,
    searchExplore: first.searchExplore === 1,
    searchNegPhraseText: (first.searchNegPhrase ?? []).join('\n'),
    searchNegExactText: (first.searchNegExact ?? []).join('\n'),
    nativeAd: first.outerLoopNative === 1,
    // kol_user_type → 授权类型：2 服务号→1 / 3 聚星→2 / 1 普通号→3
    nativeAuthType: first.kolUserType === 2 ? 1 : first.kolUserType === 3 ? 2 : 3,
    nativeKwaiUserId: first.kolUserId ?? null,
    plcMode: 'unified',
    plcText: first.recommendation ?? '',
    recommendReasons: (first.newExposeTags ?? []).map((x) => x.text).slice(0, 2),
    titlesList,
    groupSize,
    unitsPerCampaign: first.units?.length
      ? Math.min(50, Math.max(1, first.units.length))
      : Math.min(Math.max(Math.trunc(first.unitsPerCampaign ?? 1) || 1, 1), 50),
    // 旧快照没有该字段，默认走命名模板
    creativeNameSameAsMaterial: first.creativeNameSameAsMaterial === true,
    assignRule: 'even',
    appId: first.appId ?? null,
    packageId: first.packageId ?? null,
    webUriType: first.webUriType ?? 1,
    url: first.url ?? '',
    siteId: first.siteId ?? null,
    clickMonitorUrl: first.clickMonitorUrl ?? '',
    impressionMonitorUrl: first.impressionMonitorUrl ?? '',
    __videos: videos,
  };

  // undefined 字段剔除，避免覆盖 CardForm 默认值时引入 undefined
  return Object.fromEntries(Object.entries(form).filter(([, v]) => v !== undefined)) as Partial<
    CardForm
  > & { __videos?: string[] };
}
