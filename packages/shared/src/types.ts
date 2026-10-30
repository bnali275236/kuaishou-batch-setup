/**
 * 前后端共享的传输类型定义
 */

import type { InitialStatus } from './constants';

/** MAPI 统一响应包装 */
export interface MapiResponse<T = unknown> {
  code: number;
  message?: string;
  data?: T;
}

/** 授权账户摘要（返回给前端）。token 信息一律来自所属授权凭证 */
export interface AccountSummary {
  advertiserId: string;
  accountName: string | null;
  /** 账户在工作台内的状态：ACTIVE | DISABLED */
  status: string;
  /** 代投白名单：true = 仅可看数据，禁止上计划/调预算/调整计划 */
  readOnly: boolean;
  /** 所属授权凭证 */
  grantId: number;
  /** 从凭证继承：授权入口 LUOPAN / ADVERTISER / AGENT */
  authEntry: 'LUOPAN' | 'ADVERTISER' | 'AGENT';
  /** 从凭证继承：ACCOUNT = 基于广告账户授权；USER = 基于用户（罗盘）授权 */
  authType: 'ACCOUNT' | 'USER';
  /** 所属凭证的展示标签 */
  grantLabel: string | null;
  /** 凭证状态：ACTIVE | REFRESHING | NEED_REAUTH | DISABLED */
  grantStatus: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
  /** refresh_token 剩余天数，负数表示已过期 */
  refreshTokenDaysLeft: number;
  lastSyncAt: string | null;
  createdAt: string;
}

/**
 * 授权凭证摘要。
 * 一次授权 = 一份凭证 = 一个 access_token，可能覆盖 N 个广告账户。
 */
export interface AuthGrantSummary {
  id: number;
  label: string | null;
  /** 授权入口：LUOPAN / ADVERTISER / AGENT —— 决定 token 的覆盖粒度 */
  authEntry: 'LUOPAN' | 'ADVERTISER' | 'AGENT';
  /** 授权方式：ACCOUNT = 基于广告账户授权；USER = 基于用户授权 */
  authType: 'ACCOUNT' | 'USER';
  /** USER 模式下的授权主体快手ID */
  subjectId: string | null;
  subjectName: string | null;
  scopes: string[];
  status: string;
  lastError: string | null;
  /** 该凭证覆盖的账户总数 */
  accountCount: number;
  /** 其中处于启用状态的账户数 */
  activeAccountCount: number;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
  refreshTokenDaysLeft: number;
  lastSyncedAt: string | null;
  createdAt: string;
}

/** 应用配置（secret 永不出后端） */
export interface AppConfigView {
  configured: boolean;
  appId: string | null;
  /** 只回显尾部 4 位，用于确认填对了没有 */
  secretMasked: string | null;
  redirectUri: string | null;
  scopes: string[];
  updatedAt: string | null;
}

/** 授权链接生成结果 */
export interface AuthorizeUrlResult {
  url: string;
  state: string;
  /**
   * 本次授权走的是哪个入口。
   * 不同入口的**域名不同**，决定了用户会落到磁力罗盘还是磁力智投。
   */
  authEntry: 'LUOPAN' | 'ADVERTISER' | 'AGENT';
  /** 本次授权链接声明的授权方式（仅用于界面提示，实际由快手授权页决定） */
  authType: 'ACCOUNT' | 'USER';
}

/** 用 auth_code 兑换 token 的结果 */
export interface ExchangeResult {
  grantId: number;
  authEntry: 'LUOPAN' | 'ADVERTISER' | 'AGENT';
  authType: 'ACCOUNT' | 'USER';
  /** 本次发现的账户数，为 0 表示需要稍后重新对齐账户列表 */
  accountCount: number;
  pending: boolean;
  accounts: AccountSummary[];
}

/** 账户列表重新对齐结果 */
export interface ResyncResult {
  grants: number;
  found: number;
  added: number;
  removed: number;
  details: Array<{
    grantId: number;
    found: number;
    added: number;
    removed: number;
    error?: string;
  }>;
}

/** 统一 API 错误体 */
export interface ApiErrorBody {
  statusCode: number;
  message: string;
  /** MAPI 原始错误码，便于排查 */
  mapiCode?: number;
  kind?: string;
}

/** 实时报表公共查询入参 */
export interface ReportQueryInput {
  advertiserId: string;
  /** yyyy-MM-dd */
  startDate?: string;
  /** yyyy-MM-dd */
  endDate?: string;
  /** yyyy-MM-dd HH:mm 增量拉取 */
  startDateMin?: string;
  /** yyyy-MM-dd HH:mm 增量拉取 */
  endDateMin?: string;
  temporalGranularity?: 'DAILY' | 'HOURLY';
  page?: number;
  pageSize?: number;
}

/** 账户实时报表单行（字段随平台增补，保留索引签名） */
export interface AccountReportRow {
  stat_date?: string;
  stat_hour?: number;
  charge?: number;
  show?: number;
  photo_click?: number;
  aclick?: number;
  bclick?: number;
  photo_click_ratio?: number;
  played_num?: number;
  play_3s_ratio?: number;
  action_ratio?: number;
  impression_1k_cost?: number;
  photo_click_cost?: number;
  action_cost?: number;
  [key: string]: unknown;
}

export interface ReportPage<T> {
  totalCount: number;
  page: number;
  pageSize: number;
  rows: T[];
}

/** 授权全过程记录，用于排查 */
export interface OauthEventLog {
  at: string;
  step: string;
  ok: boolean;
  detail?: string;
}

/* ------------------------------------------------------------------
 * 上计划（批量创编）
 * ---------------------------------------------------------------- */

/**
 * 创编表格的一行。
 *
 * 一行 = 一个「计划 → 组 → 创意」的三层结构（这是批量上计划最常见的用法：
 * 一行铺一条完整链路）。也可以只填计划层或组层，用 `levels` 声明要创建哪些层级。
 */
export interface PlanRow {
  /** 行号，前端表格行标识，用于把校验错误定位回具体行 */
  rowNo: number;
  /** 目标广告账户 */
  advertiserId: string;

  /** ——— 计划层 ——— */
  campaignName: string;
  /** 营销目标 campaign.type */
  campaignType: number;
  /** 0 信息流 / 1 搜索 */
  adType?: number;
  /** 计划日预算（元，提交时转厘） */
  campaignDayBudgetYuan?: number | null;
  /** 计划出价类型 0 默认（成本优先）/ 1 最大转化 */
  campaignBidType?: number;
  /** 全自动投放（auto_manage，需同时开启 auto_adjust/auto_build，白名单功能） */
  autoManage?: number | null;
  /**
   * ⚠️ 搜索快投已迁移：官方「创建广告计划」接口**没有** feed_deliver_search 字段
   * （2026-09-25 经 Go SDK 与官方文档双重核实），真实下发位置是**组层**
   * quick_search —— 见下方 searchQuick。
   */
  searchQuick?: number | null;
  /**
   * 智能扩词（组级 extend_search，boolean）。
   * · 搜索广告（ad_type=1）：按用户开关；
   * · 搜索快投（searchQuick=1）：**平台强制必须开启** —— 否则创建组报
   *   401000「搜索快投必须开启智能扩词」，mapper 会无条件补 true。
   */
  searchExtend?: number | null;
  /** 搜索人群探索（组级 target_explore）：基于搜索行为探索定向外人群，仅 quick_search=1 时生效 */
  searchExplore?: number | null;
  /**
   * 搜索广告关键词（≤1000 个/组，单词 ≤20 字）。
   * 创建链路：组创建成功后经 v2/word_info/create 下发（需要 campaign_id + unit_id，
   * 因此不能塞进 unit/create 请求体，由任务引擎在组成功后追加调用）。
   */
  searchKeywords?: string[] | null;
  /** 关键词匹配方式 word_infos.match_type：1 精确 / 2 短语 / 3 广泛（平台建议广泛+否词） */
  searchMatchType?: number | null;
  /** 短语否定词（unit/create negative_word_param.phrase_words，≤200 个） */
  searchNegPhrase?: string[] | null;
  /** 精确否定词（unit/create negative_word_param.exact_words，≤200 个） */
  searchNegExact?: string[] | null;
  /** 周期稳投开关（计划级 periodic_delivery_type）：1 开启 / 0 关闭（白名单） */
  periodicDeliveryType?: number | null;
  /** 周期稳投-投放周期（periodic_days，官方默认 7 天，加白后支持 5 天） */
  periodicDays?: number | null;
  /** 周期稳投-续投（continue_period_type）：1 关闭 / 2 开启 */
  continuePeriodType?: number | null;
  /** 周期总预算（元，计划级 range_budget，仅稳投开启时生效，提交时转厘） */
  rangeBudgetYuan?: number | null;
  /**
   * 定向透传扩展（组级 target 下的额外字段，白名单键）：
   * user_type / device_brand_ids / device_price / filter_converted_level /
   * disable_installed_app_switch / inteli_extend_option / behavior_type /
   * population / exclude_population 等，由前端定向抽屉构造。
   */
  targeting?: Record<string, unknown> | null;

  /** ——— 广告组层 ——— */
  unitName: string;
  /**
   * 每条计划建几个广告组（默认 1）。>1 时服务端把该行展开成
   * 1 计划 + N 组，每组下挂同一批创意（组名自动加 -01/-02 序号）。
   */
  unitsPerCampaign?: number | null;
  /** 出价类型 2/10/12 */
  bidType: number;
  /** CPC 出价（元） */
  bidYuan?: number | null;
  /** OCPM/CPC 出价（元） */
  cpaBidYuan?: number | null;
  /** 优化目标 ocpx_action_type */
  ocpxActionType?: number | null;
  /** 资源位置 */
  sceneIds: number[];
  /** 创意制作方式 4 常规自定义 / 7 程序化创意 */
  unitType: number;
  /** 投放开始日期 yyyy-MM-dd */
  beginTime: string;
  endTime?: string | null;
  /** 组日预算（元） */
  unitDayBudgetYuan?: number | null;
  /** 投放时段 168 位字符串，不传为全时段 */
  scheduleTime?: string | null;
  /** 创意展现方式 show_mode：1 轮播 / 2 优选（平台默认） */
  showMode?: number | null;
  /** 深度转化目标 deep_conversion_type（3 付费 / 7 次日留存…，白名单） */
  deepConversionType?: number | null;
  /** 深度转化目标出价（元，需大于浅层出价） */
  deepConversionBidYuan?: number | null;
  /** 付费 ROI 系数（优化目标为首日/7日 ROI 时必填，(0,100] 最多三位小数） */
  roiRatio?: number | null;
  /** 应用下载方式 app_download_type：0 直接下载 / 1 落地页下载（白名单） */
  appDownloadType?: number | null;
  /** 优先从应用商店下载 use_app_market：0 / 1 */
  useAppMarket?: number | null;
  /** 应用商店列表 app_store：huawei/oppo/vivo/xiaomi/meizu/smartian/honor */
  appStores?: string[] | null;
  /** 定向：地域 */
  region?: number[];
  /** 定向：性别 0 不限 / 1 女 / 2 男 */
  gender?: number | null;
  /** 定向：年龄 */
  agesRange?: number[] | null;
  /** 定向：操作系统 0 不限 / 1 安卓 / 2 iOS */
  platformOs?: number | null;
  /** 定向：网络 0 不限 / 1 wifi / 2 移动 */
  network?: number | null;

  /** ——— 链路参数（随营销目标变化）——— */
  /** 应用 ID（应用安装/活跃、商品库推广） */
  appId?: string | null;
  /** 新版应用中心应用包 ID */
  packageId?: string | null;
  /** 落地页形态 */
  webUriType?: number | null;
  /** 自有链接 */
  url?: string | null;
  /** 建站落地页 ID */
  siteId?: string | null;
  /** 程序化落地页 ID */
  groupId?: string | null;
  /** 调起链接 */
  schemaUri?: string | null;
  /** 短剧 ID */
  seriesId?: string | null;
  /** 剧集 ID */
  episodeId?: string | null;
  /** 小铃铛组件 ID */
  jingleBellId?: string | null;
  /** 主播/作者 ID */
  liveUserId?: string | null;
  /**
   * 第三方点击监测链接（创意层，官方：优化目标为激活且未接 SDK 时必填）。
   * 自定义创意 → click_track_url；程序化创意 → click_url。
   */
  clickMonitorUrl?: string | null;
  /** 第三方开始播放监测链接（创意层 impression_url，仅自定义创意支持） */
  impressionMonitorUrl?: string | null;

  /** ——— 创意层 ——— */
  creativeName: string;
  /** 创意名直接使用素材（视频）名，忽略命名模板；组内重名自动加 -2/-3 序号 */
  creativeNameSameAsMaterial?: boolean | null;
  /** 素材类型 */
  materialType: number;
  /** 视频 ID（photo_id） */
  photoId?: string | null;
  /**
   * 创意组模型（mobgi 对齐）：一行 = 1 计划 + 1 广告组 + N 个创意。
   * 存在且多于一个元素时，创意层按本数组逐个展开（每个创意一个视频），
   * photoId 取第一个视频兜底；为空/单元素时保持旧行为：一行一个创意。
   */
  creativeVideos?: Array<{ photoId: string; description?: string | null; name?: string | null }> | null;
  /**
   * 计划下各广告组的视频分配（素材切分装填，每组视频不重复）。
   * 存在时服务端按本数组展开组；为空时回退旧模型：同一批 creativeVideos
   * 在 unitsPerCampaign 个组下各建一轮（旧行为兼容）。
   */
  units?: Array<{
    unitName?: string | null;
    videos: Array<{ photoId: string; description?: string | null; name?: string | null }>;
  }> | null;
  /** 封面图片 token */
  imageToken?: string | null;
  /** 图片创意 token（图片/小图/组图） */
  imageTokens?: string[] | null;
  /** 行动号召文案 */
  actionBarText: string;
  /** 广告语 */
  description?: string | null;
  /** 创意分类 */
  creativeCategory?: number | null;
  /** 创意标签 */
  creativeTags?: string[] | null;
  /** PLC 自定义文案（recommendation，13 字以内；官方创建创意接口真实字段） */
  recommendation?: string | null;
  /** 原生广告：1 开启（outer_loop_native，开启时 kol 两项必填） */
  outerLoopNative?: number;
  /** 原生达人用户类型：1 普通快手号 / 2 服务号 / 3 聚星 */
  kolUserType?: number | null;
  /** 原生投放目标达人 ID（快手号授权列表拉到的 user_id） */
  kolUserId?: string | null;
  /** 推荐理由（new_expose_tag，官方最多 2 个） */
  newExposeTags?: Array<{ text: string }> | null;
}

/** 单行校验结果 */
export interface PlanRowIssue {
  rowNo: number;
  field: string;
  level: 'CAMPAIGN' | 'UNIT' | 'CREATIVE' | 'ROW';
  message: string;
  /** ERROR 会阻止提交；WARN 只提示 */
  severity: 'ERROR' | 'WARN';
}

/** 校验汇总 */
export interface PlanValidateResult {
  rows: number;
  errorCount: number;
  warnCount: number;
  issues: PlanRowIssue[];
  /** 按账户统计将要创建的实体数，用于提交前确认 */
  perAccount: Array<{
    advertiserId: string;
    accountName: string | null;
    campaigns: number;
    units: number;
    creatives: number;
    /** 该账户今日已创建数量（平台限制核对） */
    createdToday: number;
  }>;
}

/** 创编草稿 */
export interface PlanDraftView {
  id: number;
  name: string;
  campaignType: number;
  rows: PlanRow[];
  /** 策略组表单快照（CardForm JSON；旧草稿为 null） */
  formJson: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 监测链接包（命名的第三方监测链接资产） */
export interface MonitorPackageDto {
  id: number;
  name: string;
  note: string | null;
  clickUrl: string;
  impressionUrl: string;
}

/** 批量任务摘要 */
export interface BatchTaskSummary {
  id: number;
  name: string;
  status: string;
  /** 本次任务要创建的总实体数 */
  totalItems: number;
  succeeded: number;
  failed: number;
  skipped: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  /** 涉及的账户数 */
  accountCount: number;
  /** 本次提交要创建的计划数（一次提交 = 一个任务，进度按计划计） */
  planTotal: number;
  /** 整条计划链（计划+组+创意）全部成功的计划数 */
  planSucceeded: number;
  /** 计划层失败（其下组/创意随之跳过）的计划数 */
  planFailed: number;
  /** 创建后置状态：PAUSED（默认）| RUNNING */
  initialStatus: InitialStatus;
}

/** 任务条目视图 */
export interface BatchTaskItemView {
  id: number;
  seq: number;
  advertiserId: string;
  level: string;
  status: string;
  verifyStatus: string;
  /** 提交的名称，便于人工核对 */
  displayName: string | null;
  platformId: string | null;
  attempts: number;
  errorCode: number | null;
  errorKind: string | null;
  errorMessage: string | null;
  verifiedAt: string | null;
  verifyDiff: string | null;
  /** 所属的提交行号，前端按它把条目归组到「一条计划」 */
  rowNo: number;
}

/** 任务详情 */
export interface BatchTaskDetail extends BatchTaskSummary {
  items: BatchTaskItemView[];
}

/* ------------------------------------------------------------------
 * 素材看板（素材维度数据观察与投放结论）
 *
 * 数据来源：/v1/report/material_report（view_type=5 视频报表）
 *   - 平台实时报表只能查「近 7 天」，因此历史数据必须落本地永久留存；
 *   - 落库粒度 = 账户 × 素材 × 日期，区间汇总一律从原始计数重算
 *     （比率不能做算术平均，否则小消耗素材会把大盘拉偏）。
 * ---------------------------------------------------------------- */

/** 素材指标（一段区间或单日的聚合结果） */
export interface MaterialMetrics {
  /** 消耗（元） */
  charge: number;
  /**
   * 展示数。
   * ⚠️ 取平台的 **aclick（素材曝光数）**，不是 show（封面曝光数）。
   * 实测（2026-09-29）同一素材 show=738 而 aclick=161683（aclick 恒等于 played_num）；
   * 平台自算 action_ratio = bclick / aclick、impression_1k_cost = charge / show × 1000。
   * 若拿 coverShow 当展示数，会算出 473% 这种荒唐点击率。
   */
  show: number;
  /**
   * 点击数。
   * ⚠️ 取平台的**行为数 bclick**，不是封面点击 photo_click —— 实测（2026-09-29）
   * 同一素材 photo_click=21 而 bclick=1115，而转化数 76 > 封面点击 21，
   * 说明转化并不发生在「封面点击」之后；用封面点击当分母会算出 >100% 的转化率。
   */
  click: number;
  /** 激活数 */
  activation: number;
  /** 注册数 */
  registerCount: number;
  /** 转化数 */
  conversionNum: number;
  /**
   * 千展（元）= 消耗 ÷ **展示数（aclick）** × 1000。
   * 四列可互相验算：消耗 ÷ 展示数 × 1000 ＝ 千展；点击数 ÷ 展示数 ＝ 点击率。
   * （平台另有按封面曝光 show 算的 impression_1k_cost，数值动辄上千元，未采用。）
   */
  impression1kCost: number;
  /** 点击率 = 点击数（bclick）/ 展示数（aclick），与平台 action_ratio 口径一致 */
  clickRatio: number;
  /** 激活率 = 激活数 / 点击数 */
  activationRatio: number;
  /** 注册率 = 注册数 / 点击数 */
  registerRatio: number;
  /** 转化率 = 转化数 / 点击数 */
  conversionRatio: number;
  /** 3s 播放率（区间按播放量/展示量加权） */
  play3sRatio: number;
  /** 视频完播率（区间按播放量/展示量加权） */
  playEndRatio: number;
}

/** 素材 × 账户 的一行明细（展开行）—— 指标直接铺平，便于与主表复用同一份列定义 */
export interface MaterialAccountRow extends MaterialMetrics {
  advertiserId: string;
  accountName: string | null;
}

/** 素材看板的一行（按素材聚合；按日粒度时为「素材 × 日期」） */
export interface MaterialRow extends MaterialMetrics {
  /** 素材 ID（视频 photo_id，字符串透传） */
  photoId: string;
  /** 素材名称（视频库 photo_name 回填，可能为空） */
  materialName: string | null;
  /** 视频地址，用于播放预览 */
  photoUrl: string | null;
  /** 封面地址，用于列表缩略图 */
  coverUrl: string | null;
  /** 作品广告语 photo_caption */
  caption: string | null;
  /** 时间：区间汇总时为「起始 ~ 结束」；按日粒度时为该日 yyyy-MM-dd */
  statDate: string | null;
  /** 该素材覆盖的账户数 */
  accountCount: number;
  /** 各账户明细（点开行查看） */
  accounts: MaterialAccountRow[];
}

/** 素材看板查询结果 */
export interface MaterialBoardResult {
  /** history = 本地永久库；today = 平台实时 */
  mode: 'history' | 'today';
  /** TOTAL = 整个区间汇总；DAILY = 按日展开 */
  granularity: 'TOTAL' | 'DAILY';
  startDate: string;
  endDate: string;
  /** 汇总（所有素材合计） */
  totals: MaterialMetrics;
  rows: MaterialRow[];
  /** 本地库覆盖的数据天数（提示「已积累多少天可回溯数据」） */
  storedDays?: number;
  /** 本地数据最早日期 */
  earliestDate?: string | null;
  /** 参与统计的账户数 */
  accountCount: number;
  /** 拉取/查询过程中失败的账户（不阻塞整体返回） */
  failures: Array<{ advertiserId: string; message: string }>;
  fetchedAt: string;
}

/** 素材同步结果（手动/定时同步共用） */
export interface MaterialSyncResult {
  accounts: number;
  rows: number;
  failures: Array<{ advertiserId: string; message: string }>;
  startedAt: string;
  finishedAt: string;
}
