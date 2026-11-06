/**
 * 快手磁力引擎开放平台（MAPI）常量定义
 * 所有枚举、限额、错误分类的唯一来源。后端与前端共用。
 */

/** 开放平台网关地址 */
export const MAPI_BASE_URL = 'https://ad.e.kuaishou.com';

/* ------------------------------------------------------------------
 * OAuth 授权入口
 *
 * ⚠️ 这里是本项目最容易踩的坑（两次踩坑教训都在这）：
 *
 * 1. 域名错 → 跳错平台。罗盘授权必须用 developers.e.kuaishou.com/tools/authorize，
 *    用成 ad.e.kuaishou.com/openapi/oauth 会落到磁力智投单账户授权。
 * 2. oauth_type 漏传 → 页面报「授权类型不应为空」，无法授权。
 *    官方文档（2025-12-29 更新）明确 tools/authorize 的 oauth_type 为必填参数：
 *    advertiser（广告主/罗盘，可操作授权主体下所有广告账户）/
 *    agent（代理商，单 Token 多账户）/ ad_social（聚星）/ series（短剧）。
 *    罗盘用户授权流程与广告主一致 —— 用罗盘账号登录 + oauth_type=advertiser，
 *    在页面上选择「用户授权」即可覆盖该快手 ID 名下全部投放账户。
 * ---------------------------------------------------------------- */
export const KUAI_OAUTH_URL_LUOPAN = 'https://developers.e.kuaishou.com/tools/authorize';

/** 授权入口 */
export const AUTH_ENTRY = {
  /** 磁力罗盘 —— 批量授权，支持「基于用户授权」覆盖该快手 ID 下全部账户 */
  LUOPAN: 'LUOPAN',
  /** 磁力智投 —— 广告主 / 服务商，仅覆盖该广告主体下的投放账户 */
  ADVERTISER: 'ADVERTISER',
  /** 代理商 —— 1 个 token 操作管辖范围内全部广告主账户 */
  AGENT: 'AGENT',
} as const;

export type AuthEntry = (typeof AUTH_ENTRY)[keyof typeof AUTH_ENTRY];

export const ALL_AUTH_ENTRIES: AuthEntry[] = [
  AUTH_ENTRY.LUOPAN,
  AUTH_ENTRY.ADVERTISER,
  AUTH_ENTRY.AGENT,
];

/** 授权入口的元信息 —— 前端直接引用，避免各处重复写死 */
export const AUTH_ENTRY_META: Record<
  AuthEntry,
  {
    label: string;
    /** 授权页会跳到哪个平台 */
    platform: string;
    /** 授权链接基地址 */
    url: string;
    /** 追加到授权链接的 oauth_type（官方必填，漏传会报「授权类型不应为空」） */
    oauthType: string | null;
    /** 覆盖范围描述 */
    coverage: string;
    /** 具体操作指引 */
    howTo: string;
    /** 是否推荐 */
    recommended: boolean;
  }
> = {
  LUOPAN: {
    label: '磁力罗盘授权',
    platform: '磁力罗盘',
    url: KUAI_OAUTH_URL_LUOPAN,
    // 官方文档：罗盘用户授权流程与广告主一致，oauth_type=advertiser，
    // 登录罗盘账号后在页面上选择「用户授权」即可覆盖名下全部投放账户
    oauthType: 'advertiser',
    coverage: '罗盘下全部广告账户（基于用户授权），或勾选的多个账户（基于广告账户授权）',
    howTo:
      '授权页会跳到【磁力罗盘/开放平台】。用罗盘账号（贻之账号等）登录 → 选择「基于用户授权」（该罗盘下所有广告客户以及新增广告客户将自动完成授权）→ 勾选协议 → 确认授权。这是账户多时的唯一正确做法。',
    recommended: true,
  },
  ADVERTISER: {
    label: '广告主授权（单主体）',
    platform: '磁力智投',
    url: KUAI_OAUTH_URL_LUOPAN,
    oauthType: 'advertiser',
    coverage: '该广告主体下的投放账户',
    howTo:
      '用广告投放账号登录 → 在授权页选择「账户授权」（授权 DSP 投放账户，支持罗盘绑定账户）→ 确认授权。只能覆盖该主体自己的账户，账户多时不建议逐个授权。',
    recommended: false,
  },
  AGENT: {
    label: '代理商授权',
    platform: '代理商平台',
    url: KUAI_OAUTH_URL_LUOPAN,
    oauthType: 'agent',
    coverage: '该代理商管辖范围内的全部广告主账户（单 Token 多账户，需双向授权）',
    howTo:
      '用【代理商主账号】登录 → 打开授权链接 → 选择已代理的客户账户进行授权。一份 token 即可操作管辖范围内全部账户，无需逐个登录广告主账户。',
    recommended: false,
  },
};

/* ------------------------------------------------------------------
 * 接口路径
 * ---------------------------------------------------------------- */
export const MAPI_PATHS = {
  // 授权
  ACCESS_TOKEN: '/rest/openapi/oauth2/authorize/access_token',
  REFRESH_TOKEN: '/rest/openapi/oauth2/authorize/refresh_token',
  APPROVAL_LIST: '/rest/openapi/oauth2/authorize/approval/list',

  // 账户
  ADVERTISER_INFO: '/rest/openapi/v1/advertiser/info',
  ADVERTISER_FUND: '/rest/openapi/v1/advertiser/fund/get',
  ADVERTISER_FUND_FLOWS: '/rest/openapi/v1/advertiser/fund/daily_flows',
  ADVERTISER_WHITE_LIST: '/rest/openapi/v1/advertiser/white_list',
  // 账户日预算（doc 2072）：day_budget 单位厘，0=不限；不得低于当日最高花费 1.2 倍与原预算较小者
  ADVERTISER_BUDGET_UPDATE: '/rest/openapi/v1/advertiser/update/budget',
  // 账户日预算查询（doc 1961）
  ADVERTISER_BUDGET_QUERY: '/rest/openapi/v1/advertiser/budget/get',

  // 报表（实时）
  REPORT_ACCOUNT: '/rest/openapi/v1/report/account_report',
  REPORT_CAMPAIGN: '/rest/openapi/v1/report/campaign_report',
  REPORT_UNIT: '/rest/openapi/v1/report/unit_report',
  REPORT_CREATIVE: '/rest/openapi/v1/report/creative_report',
  REPORT_MATERIAL: '/rest/openapi/v1/report/material_report',

  // 报表（异步）
  ASYNC_TASK_CREATE: '/rest/openapi/v1/async_task/create',
  ASYNC_TASK_LIST: '/rest/openapi/v1/async_task/list',
  ASYNC_TASK_DOWNLOAD: '/rest/openapi/v1/async_task/download',

  // 创编相关路径见下方 PLAN_PATHS —— 这里不再重复定义，只保留一个来源，
  // 否则「同一路径两处定义、改一处漏一处」是迟早要踩的坑。

  // 工具字典
  OCPX_TYPES: '/rest/openapi/gw/dsp/v1/ocpx/ocpxTypes',
  DEEP_TYPES: '/rest/openapi/gw/dsp/v1/ocpx/deepTypes',
  CONVERT_LIST: '/rest/openapi/v1/tool/convert/list',
  POPULATION_LIST: '/rest/openapi/v2/dmp/population/list',
  LP_PAGE_LIST: '/rest/openapi/v2/lp/page/list',
  LABEL_BEHAVIOR_INTEREST: '/rest/openapi/v1/tool/label/behavior_interest',
  KEYWORD_QUERY: '/rest/openapi/v1/tool/keyword/query',
  REGION_DISTRICT: '/rest/openapi/v1/region/district/list',
  /** 地域定向树（GET，返回 id → {id,level,name,parent,children} 映射） */
  REGION_LIST: '/rest/openapi/v1/region/list',
  APP_LIST: '/rest/openapi/v2/file/ad/app/list',
  /**
   * 新版应用发布列表【单元创编必选】（官方文档 2026-09-26 实查，documentId 2337）：
   * list_type 不传=全部 / 1-我创建的 / 2-共享给我的。账户无自有应用但被共享应用时，
   * 旧 APP_LIST 返回空、本接口能拿到共享应用（source_type=2），含 app_id + package_id。
   */
  APP_RELEASE_LIST: '/rest/openapi/gw/dsp/appcenter/app/release/list',
  /** 获取原生快手号列表（kol_user_type：1 普通快手号 / 2 服务号达人 / 3 聚星达人） */
  NATIVE_USER_LIST: '/rest/openapi/gw/dsp/v1/native/user/list',
  /**
   * 创意分类列表（返回「倒着的树」：details 里每个节点带 parent_id，
   * 没有子节点引用它的即为叶子 —— creative_category 只能选叶子类目）。
   */
  CREATIVE_CATEGORY_LIST: '/rest/openapi/v1/creative/creative_category/list',
  /** 搜索广告-创建关键词（组创建成功后调用，单组上限 1000 个，词长 ≤20） */
  WORD_INFO_CREATE: '/rest/openapi/v2/word_info/create',
  VIDEO_UPLOAD: '/rest/openapi/v2/file/ad/video/upload',
  IMAGE_UPLOAD: '/rest/openapi/v2/file/ad/image/upload',
  VIDEO_LIST: '/rest/openapi/v1/file/ad/video/list',
  TARGET_TEMPLATE_CREATE: '/rest/openapi/gw/dsp/target/template/create',
  TARGET_TEMPLATE_DETAILS: '/rest/openapi/gw/dsp/target/template/details',
} as const;

/* ------------------------------------------------------------------
 * scope 权限
 * ---------------------------------------------------------------- */
export const KUAI_SCOPES = {
  REPORT: 'report_service',
  ACCOUNT: 'account_service',
  QUERY: 'ad_query',
  MANAGE: 'ad_manage',
} as const;

/** scope 的展示文案 —— 前端勾选框直接引用 */
export const SCOPE_META: Record<
  string,
  { label: string; desc: string; core: boolean }
> = {
  report_service: {
    label: '数据报表',
    desc: '获取广告账户报表信息与建站信息',
    core: true,
  },
  ad_query: {
    label: '广告查询',
    desc: '获取计划 / 广告组 / 创意信息',
    core: true,
  },
  ad_manage: {
    label: '广告创建与修改',
    desc: '创建与修改计划 / 广告组 / 创意，以及人群管理',
    core: true,
  },
  account_service: {
    label: '账户服务',
    desc: '获取账户信息、余额、资金流水（官方说明第三方无需申请即可用余额等接口，流水需加白）',
    core: false,
  },
};

/** 核心三段权限：报表 / 查询 / 创编。授权是一次性的，默认全带上 */
export const REQUIRED_SCOPES = [
  KUAI_SCOPES.REPORT,
  KUAI_SCOPES.QUERY,
  KUAI_SCOPES.MANAGE,
];

/** 默认申请的 scope（核心三段 + 账户服务） */
export const DEFAULT_SCOPES = [...REQUIRED_SCOPES, KUAI_SCOPES.ACCOUNT];

/* ------------------------------------------------------------------
 * 限流配额（QPM = queries per minute）
 * 依据官方文档与 M-API 常见问题整理
 * ---------------------------------------------------------------- */
export const RATE_LIMITS = {
  /** 应用级全局令牌桶 */
  GLOBAL: 1000,
  /** 计划 / 广告组层级创编 */
  CREATE: 600,
  /** 创意 / 程序化创意创编 */
  CREATIVE: 400,
  /** 批量接口 */
  BATCH: 200,
  /** 单账户维度创编 */
  PER_ADVERTISER: 600,
  /** 查询类接口（保守取值，避免与创编抢配额） */
  QUERY: 600,
} as const;

/** 自适应限流阈值：超时率超过该值主动降速 */
export const ADAPTIVE_SLOWDOWN_RATIO = 0.15;
/** 平台硬性自适应限流阈值：超时率超过该值会被限流约 1 分钟 */
export const ADAPTIVE_BLOCK_RATIO = 0.2;

/** 单次查询 ID 数量上限 */
export const MAX_IDS_PER_REQUEST = 5000;
/** 报表分页单页上限 */
export const MAX_PAGE_SIZE = 2000;
/** 实时报表可查询天数范围（含当天） */
export const REALTIME_REPORT_LOOKBACK_DAYS = 7;
/**
 * 异步报表回溯天数：实时接口实测只开近 7 天（第 8 天起报 401000「选取起始时间超过允许范围」），
 * 更早的历史走异步任务（async_task/create 单次跨度最长 6 个月）。
 * 用户明确要求：异步的话直接取最长 —— 6 个月。
 */
export const ASYNC_BACKFILL_DAYS = 180;
/** T-1 数据完成更新时间（次日 09:00） */
export const T_MINUS_1_READY_HOUR = 9;

/** 创建类接口的日上限（成功次数，删除不计入） */
export const DAILY_CREATE_LIMITS = {
  CAMPAIGN: 1000,
  UNIT: 600,
  CREATIVE: 2000,
  ASYNC_TASK: 20,
} as const;

/* ------------------------------------------------------------------
 * 凭证有效期（单位：秒）
 * ---------------------------------------------------------------- */
export const TOKEN_TTL = {
  /** auth_code：10 分钟，一次性 */
  AUTH_CODE: 10 * 60,
  /** access_token：1 天 */
  ACCESS_TOKEN: 24 * 60 * 60,
  /** refresh_token：30 天 */
  REFRESH_TOKEN: 30 * 24 * 60 * 60,
} as const;

/** access_token 提前刷新窗口：到期前 30 分钟 */
export const TOKEN_REFRESH_AHEAD_SECONDS = 30 * 60;
/** refresh_token 告警窗口：到期前 7 天 */
export const REFRESH_TOKEN_WARN_SECONDS = 7 * 24 * 60 * 60;

/* ------------------------------------------------------------------
 * 金额单位
 * ---------------------------------------------------------------- */
/** 快手所有金额字段单位均为「厘」，1 元 = 1000 厘 */
export const LI = 1000;

export const yuanToLi = (yuan: number): number => Math.round(yuan * LI);
export const liToYuan = (li: number): number => li / LI;

/* ------------------------------------------------------------------
 * 计划 / 营销目标枚举
 * ---------------------------------------------------------------- */
export const CAMPAIGN_TYPE: Record<number, string> = {
  1: '快手作品推广',
  2: '提升应用安装',
  3: '获取电商下单',
  4: '推广品牌活动',
  5: '收集销售线索',
  6: '保量广告',
  7: '提升应用活跃',
  9: '商品库推广',
  13: '小店商品推广',
  14: '小店直播推广',
  16: '粉丝直播推广',
  19: '推广快手小程序',
  30: '快手号-短剧推广',
  32: '微信小程序/小游戏推广',
  34: '快手号-小说推广',
  35: '电商下单推广',
  40: 'DPA-应用拉活',
  41: 'DPA-应用下载',
};

/** 投放状态的中文名（展示用）。数值请用 PUT_STATUS_CODE，不要写魔法数字 */
export const PUT_STATUS: Record<number, string> = {
  1: '投放中',
  2: '暂停投放',
  3: '已删除',
};

export const BID_TYPE: Record<number, string> = {
  2: 'CPC',
  10: 'OCPM',
  12: 'MCB 最大转化',
};

/** 资源位 */
export const SCENE_ID: Record<number, string> = {
  1: '优选广告位',
  5: '联盟广告',
  6: '上下滑大屏广告',
  7: '双列信息流广告',
  10: '联盟场景',
  24: '激励视频',
  27: '开屏广告位',
  39: '搜索广告',
  53: '一甜广告',
  56: '内容消费资源位',
};

/* ------------------------------------------------------------------
 * 授权方式（两个正交维度之一）
 *
 * ⚠️ 必须与 AUTH_ENTRY 区分开，这是两个**正交**的维度：
 *
 *   授权入口 AUTH_ENTRY（选域名）→ 决定跳到哪个平台、能授权到什么粒度
 *   授权方式 AUTH_TYPE （选范围）→ 在快手授权页上勾的，决定覆盖几个账户
 *
 * 只有「磁力罗盘」和「磁力智投」这两个入口的授权页上才会出现
 * 「基于用户授权 / 基于快手广告账户授权」二选一；
 * 「代理商」入口没有这个选择，一份 token 天然覆盖管辖内全部账户。
 *
 * 且授权方式**不由 URL 参数决定** —— 用户在页面上选了什么就是什么。
 * 我们能做的只是把自己这边的预期随 state 带出去，回调时校正入库标签。
 * ---------------------------------------------------------------- */
export const AUTH_TYPE = {
  /** 基于用户授权：覆盖该快手ID（磁力罗盘 / 代理商）下的**全部**广告账户 */
  USER: 'USER',
  /** 基于快手广告账户授权：覆盖**勾选的一个或多个**广告账户 */
  ACCOUNT: 'ACCOUNT',
} as const;

export type AuthType = (typeof AUTH_TYPE)[keyof typeof AUTH_TYPE];

/** 授权方式的展示文案与操作指引 —— 前端直接引用，避免各处重复写死 */
export const AUTH_TYPE_META: Record<
  AuthType,
  { label: string; short: string; scope: string; howTo: string }
> = {
  USER: {
    label: '基于用户授权',
    short: '罗盘 / 用户',
    scope: '该快手 ID（磁力罗盘 / 代理商）下的全部广告账户',
    howTo:
      '在快手授权页选择「基于用户授权」→ 确认。一次即可接入该账号下所有账户，后续新增的账户也能通过「对齐账户列表」同步进来。',
  },
  ACCOUNT: {
    label: '基于快手广告账户授权',
    short: '广告账户',
    scope: '勾选的一个或多个广告账户',
    howTo:
      '在快手授权页选择「基于快手广告账户授权」→ 勾选需要接入的账户（支持多选 / 全选）→ 确认。若只想接入个别账户，用这种方式。',
  },
};

/* ------------------------------------------------------------------
 * 授权凭证状态（token 维度）
 * ---------------------------------------------------------------- */
export const GRANT_STATUS = {
  /** token 正常 */
  ACTIVE: 'ACTIVE',
  /** 正在刷新 */
  REFRESHING: 'REFRESHING',
  /** refresh_token 也失效，必须重新走授权 */
  NEED_REAUTH: 'NEED_REAUTH',
  /** 已停用（用户手动） */
  DISABLED: 'DISABLED',
} as const;

export type GrantStatus = (typeof GRANT_STATUS)[keyof typeof GRANT_STATUS];

/* ------------------------------------------------------------------
 * 广告账户在工作台内的状态（是否参与拉数与创编）
 * ---------------------------------------------------------------- */
export const ACCOUNT_STATUS = {
  ACTIVE: 'ACTIVE',
  /** 已停用（手动，或平台侧已解绑后自动标记） */
  DISABLED: 'DISABLED',
} as const;

export type AccountStatus = (typeof ACCOUNT_STATUS)[keyof typeof ACCOUNT_STATUS];

/* ------------------------------------------------------------------
 * 接口调用错误分类 —— 决定「重试 / 不重试 / 需加白」
 * ---------------------------------------------------------------- */
export enum MapiErrorKind {
  /** 成功 */
  OK = 'OK',
  /** 网络抖动、超时、服务端 5xx、平台限流 —— 可重试 */
  RETRYABLE = 'RETRYABLE',
  /** 参数非法、区间越界、字段缺失 —— 不重试，需修正后重跑 */
  PARAM = 'PARAM',
  /** 无权限、未加白、资质不匹配 —— 不重试，需运营处理 */
  PERMISSION = 'PERMISSION',
  /** access_token 失效 —— 刷新 token 后重试 */
  TOKEN_INVALID = 'TOKEN_INVALID',
  /** 未知 —— 记录并人工排查 */
  UNKNOWN = 'UNKNOWN',
}

/** 已知错误码映射。官方「报错码枚举」下发后应补全本表 —— 当前为实测码 + 消息关键字兜底 */
export const ERROR_CODE_MAP: Record<number, { kind: MapiErrorKind; desc: string }> = {
  0: { kind: MapiErrorKind.OK, desc: '成功' },

  // ── 限流 ──────────────────────────────────────────────
  400001: { kind: MapiErrorKind.RETRYABLE, desc: '触发平台限流，稍后重试即可' },
  400003: { kind: MapiErrorKind.RETRYABLE, desc: '并发 refresh_token 异常，稍后重试' },

  // ── 权限（需运营/加白处理，重试无用）────────────────────
  400002: { kind: MapiErrorKind.PERMISSION, desc: '无该接口权限（账户不在白名单）' },
  400004: {
    kind: MapiErrorKind.PERMISSION,
    desc: '广告主资质不在开发者授权资质主体内，无法操作该账户',
  },
  402007: { kind: MapiErrorKind.PERMISSION, desc: '账户状态异常，请检查账户是否可用（冻结/欠费）' },
  402009: { kind: MapiErrorKind.PERMISSION, desc: '密钥（secret）错误，请核对「设置」页的应用配置' },
  402010: { kind: MapiErrorKind.PERMISSION, desc: '申请权限过大，请核对授权 scope' },
  402011: { kind: MapiErrorKind.PERMISSION, desc: '回调地址错误，需与开放平台登记的一致' },
  // 2026-09 实测（授权链路）：app_id 填错 / 应用未上线时返回
  402012: {
    kind: MapiErrorKind.PERMISSION,
    desc: '应用已下线或不存在，请核对 app_id 是否与开放平台「应用管理」中一致，且应用已通过审核',
  },
  402013: { kind: MapiErrorKind.PERMISSION, desc: '代理商信息不正确，请重新登录再试' },
  402014: { kind: MapiErrorKind.PERMISSION, desc: '开发者应用状态须为「审核通过」才可调用' },
  410001: { kind: MapiErrorKind.PERMISSION, desc: '没有报表数据权限' },

  // ── 参数（改内容后重跑，重试无用）──────────────────────
  // 401000 是平台最常用的「业务校验不通过」码，具体原因看 message。
  // 2026-09-24 实测：出价超出建议区间、状态更新重复传 ID 都返回它。
  401000: { kind: MapiErrorKind.PARAM, desc: '参数或业务校验未通过（具体原因见平台返回文案）' },
  401001: { kind: MapiErrorKind.PARAM, desc: '参数格式错误' },
  401002: { kind: MapiErrorKind.PARAM, desc: '选取时间跨度过大' },
  401003: { kind: MapiErrorKind.PARAM, desc: '选取起始时间超过允许范围' },
  401004: { kind: MapiErrorKind.PARAM, desc: '选取起始时间大于结束时间' },
  401005: { kind: MapiErrorKind.PARAM, desc: '使用了重复名称' },
  410002: { kind: MapiErrorKind.PARAM, desc: '优化目标 optimize_target 错误' },
  410003: { kind: MapiErrorKind.PARAM, desc: '报表 page_size 过大' },
  410004: { kind: MapiErrorKind.PARAM, desc: '报表场景选择错误' },
  410005: { kind: MapiErrorKind.PARAM, desc: '获取代理商信息错误' },

  // ── 凭证失效（刷新/重新授权）─────────────────────────
  402000: { kind: MapiErrorKind.TOKEN_INVALID, desc: 'access_token 过期' },
  402001: { kind: MapiErrorKind.TOKEN_INVALID, desc: 'refresh_token 过期，需重新授权' },
  402002: { kind: MapiErrorKind.TOKEN_INVALID, desc: 'auth_code 过期，需重新发起授权' },
  402003: { kind: MapiErrorKind.TOKEN_INVALID, desc: 'access_token 为空' },
  402004: { kind: MapiErrorKind.TOKEN_INVALID, desc: 'access_token 错误' },
  402005: { kind: MapiErrorKind.TOKEN_INVALID, desc: 'refresh_token 错误' },
  402006: { kind: MapiErrorKind.TOKEN_INVALID, desc: 'auth_code 错误' },

  // ── 其他 ──────────────────────────────────────────────
  410000: { kind: MapiErrorKind.UNKNOWN, desc: '获取报表数据异常' },
};

/** 消息关键字 → 错误分类，用于错误码未知时兜底判断 */
export const ERROR_MESSAGE_PATTERNS: Array<{
  pattern: RegExp;
  kind: MapiErrorKind;
  desc: string;
}> = [
  {
    pattern: /限流|频控|频率|过于频繁|请求过多|too many|rate ?limit|qps|qpm/i,
    kind: MapiErrorKind.RETRYABLE,
    desc: '触发平台限流',
  },
  {
    pattern: /超时|timeout|系统繁忙|服务异常|稍后重试|内部错误|try again/i,
    kind: MapiErrorKind.RETRYABLE,
    desc: '平台服务繁忙或超时',
  },
  {
    pattern: /access.?token|令牌|登录失效|未授权登录|token.*(过期|失效|错误)/i,
    kind: MapiErrorKind.TOKEN_INVALID,
    desc: 'access_token 失效',
  },
  {
    pattern: /白名单|加白|无权限|没有权限|权限不足|不在.*名单|资质/i,
    kind: MapiErrorKind.PERMISSION,
    desc: '账户无该能力权限，需运营加白',
  },
  {
    // 2026-09 实测：app_id 配置有误时的返回文案
    pattern: /应用已下线|应用不存在|app.*不存在|未上线|审核未通过/i,
    kind: MapiErrorKind.PERMISSION,
    desc: '开发者应用不可用，请核对 app_id 与开放平台配置',
  },
  {
    pattern: /参数|非法|不合法|字段|格式|取值范围|超过限制|必填|重复|invalid|required/i,
    kind: MapiErrorKind.PARAM,
    desc: '请求参数不合法',
  },
];

/** 可重试的 HTTP 状态码 */
export const RETRYABLE_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** 重试退避序列（毫秒） */
export const RETRY_BACKOFF_MS = [1000, 2000, 4000, 8000];

/* ------------------------------------------------------------------
 * 创编（上计划）—— 接口路径
 *
 * 重要：官方文档里「创编 2.0」「创编 3.0」均标注**下线中**，
 * 现行链路是「智能化创编」。
 * 计划层与广告组层**没有批量创建接口**，只有创意层有 batch_update，
 * 所以「批量上计划」在 API 层面必然是本地循环编排。
 *
 * ⚠️ **前缀陷阱（2026-09-24 按官方文档核实）**：
 * 创建 / 查询 在 `/rest/openapi/gw/dsp/` 下，
 * 但**状态更新在 `/rest/openapi/v1/` 下** —— 同一个业务对象，两个前缀。
 * 不要因为「创建是 gw/dsp，所以更新也是 gw/dsp」就顺手拼一个出来，
 * 那条路径不存在。反过来也不成立。
 * ---------------------------------------------------------------- */
/** 以下路径全部于 2026-09-24 在真实账户 124276382 上实测（标注见各条注释） */
export const PLAN_PATHS = {
  /** ✅ 实测通过：真实创建成功，code=0，427ms（计划 ID 11632789152） */
  CAMPAIGN_CREATE: '/rest/openapi/gw/dsp/campaign/create',
  /** ✅ 实测通过：code=0，463ms。响应外壳 `{total_count, details}` */
  CAMPAIGN_LIST: '/rest/openapi/gw/dsp/campaign/list',
  /** ✅ 实测通过：置暂停 code=0，246ms。响应 `{campaign_ids, errors, campaign_id}` */
  CAMPAIGN_STATUS_UPDATE: '/rest/openapi/v1/campaign/update/status',
  /** ✅ 实测通过：真实创建成功，code=0，770ms（组 ID 39354902490） */
  UNIT_CREATE: '/rest/openapi/gw/dsp/unit/create',
  /** ✅ 实测通过（回读核验命中） */
  UNIT_LIST: '/rest/openapi/gw/dsp/unit/list',
  /** ⚠️ 仍未实测：组一直是「创建时直接带 put_status」，从没调过这个接口 */
  UNIT_STATUS_UPDATE: '/rest/openapi/v1/ad_unit/update/status',
  /** ✅ 实测通过：真实创建成功，code=0，1043ms（创意 ID 322989435349） */
  CREATIVE_CREATE: '/rest/openapi/gw/dsp/creative/create',
  /** ✅ 实测通过（回读核验命中） */
  CREATIVE_LIST: '/rest/openapi/gw/dsp/creative/list',
  /** ✅ 实测通过：置暂停 code=0，268ms */
  CREATIVE_STATUS_UPDATE: '/rest/openapi/v1/creative/update/status',

  /* —— 盯盘看板「进入账户」后的层级调整（2026-09-29 按官方文档核对路径）—— */
  /** 修改广告计划（文档 2260）：campaign_id + 选填 day_budget（厘，0=不限） */
  CAMPAIGN_UPDATE: '/rest/openapi/gw/dsp/campaign/update',
  /** 修改广告组（文档 2263）：unit_name / bid_type 必填，schedule_time 投放时段（24*7 的 0/1 串） */
  UNIT_UPDATE: '/rest/openapi/gw/dsp/unit/update',
  /** 修改广告组预算（文档 2040）：单组，day_budget（厘） */
  UNIT_BUDGET_UPDATE: '/rest/openapi/v1/ad_unit/update/day_budget',
  /** 修改广告组出价（文档 1975）：支持 unit_ids 批量改成同一出价（厘） */
  UNIT_BID_UPDATE: '/rest/openapi/v1/ad_unit/update/bid',
} as const;

/**
 * 单账户创建上限（官方「12.1 频控和创建限制」）。
 *
 * ⚠️ 注意三者口径并不一致，官方原文如此：
 *   - 计划：**总数限制**（最多可创建 1000 个广告计划），不是日增量
 *   - 组：日新增限制（600/日），对总数不限制
 *   - 创意：日新增限制（2000/日），对总数不限制
 * 程序化创意的 300/天 与组&创意上限**不共用**，是独立额度。
 *
 * 本地目前统一按「今日已创建数」预检，对计划层是偏保守的估计 —— 宁可拦早，不要撞到平台报错。
 */
export const CREATE_DAILY_LIMIT = {
  CAMPAIGN: 1000,
  UNIT: 600,
  CREATIVE: 2000,
} as const;

/* ------------------------------------------------------------------
 * 投放状态（put_status）
 *
 * 只有**广告组**在创建时支持指定状态；计划层与创意层的创建接口
 * 都没有状态字段，只能创建成功后再调 update/status 改。
 * 这是「创建即暂停」必须分两步走的根本原因。
 * ---------------------------------------------------------------- */
export const PUT_STATUS_CODE = {
  RUNNING: 1,
  PAUSED: 2,
  DELETED: 3,
} as const;

/** 状态更新接口单次可传的 ID 上限（官方文档明确） */
export const STATUS_UPDATE_BATCH_LIMIT = {
  CAMPAIGN: 20,
  UNIT: 10,
  CREATIVE: 20,
} as const;

/**
 * 批量任务的「创建后状态」。
 * 默认暂停：批量创建 100 条一旦默认投放，就是真实预算风险；
 * 暂停后由投手复核定向 / 出价 / 素材，再决定是否启用。
 */
export type InitialStatus = 'PAUSED' | 'RUNNING';
export const DEFAULT_INITIAL_STATUS: InitialStatus = 'PAUSED';

/* ------------------------------------------------------------------
 * 营销目标（campaign.type）
 *
 * 这个字段决定**整条链路的必填字段**：
 *   应用安装(2) → app_id / package_id / 下载中间页
 *   销售线索(5) → 落地页（建站 site_id / 程序化落地页 group_id / 自有链接）
 *   短剧(30)    → series_id / episode_id / 作者 ID
 *   直播(16)    → jingle_bell_id / live_user_id / conversion_type
 * 因此创编表格的列必须随它变化，不能一套列走天下。
 * ---------------------------------------------------------------- */
// 注：营销目标的 code→名称 映射沿用上文已有的 CAMPAIGN_TYPE 常量，
// 这里只补充「该目标需要哪些链路参数、支持哪些素材类型」的元信息。

/** 营销目标元信息：决定表格列与校验规则 */
export const CAMPAIGN_TYPE_META: Record<
  number,
  {
    code: number;
    label: string;
    short: string;
    /** 该目标下必须提供的「链路参数」字段名（本地校验用） */
    requiredFields: string[];
    /** 素材类型白名单（creative_material_type） */
    materialTypes: number[];
    note?: string;
  }
> = {
  2: {
    code: 2,
    label: '提升应用安装',
    short: '应用安装',
    requiredFields: ['app_id'],
    materialTypes: [1, 2],
    note: '需在「应用和监测」选择推广应用',
  },
  7: {
    code: 7,
    label: '提升应用活跃',
    short: '应用活跃',
    requiredFields: ['app_id'],
    materialTypes: [1, 2],
    note: '需在「应用和监测」选择推广应用',
  },
  5: {
    code: 5,
    label: '收集销售线索',
    short: '销售线索',
    requiredFields: ['web_uri_type'],
    materialTypes: [1, 2, 5, 6, 9, 10],
    note: '需确定落地页形态：自有链接 / 建站 / 程序化落地页',
  },
  30: {
    code: 30,
    label: '快手号-短剧推广',
    short: '短剧',
    requiredFields: ['series_id', 'episode_id', 'live_user_id'],
    materialTypes: [1, 2],
    note: '需选择短剧、剧集与短剧作者',
  },
  35: {
    code: 35,
    label: '电商下单推广',
    short: '电商下单',
    requiredFields: ['unit_material_type'],
    materialTypes: [1, 2, 5, 6, 9, 10],
  },
  16: {
    code: 16,
    label: '粉丝/直播推广',
    short: '直播',
    requiredFields: ['jingle_bell_id', 'live_user_id', 'conversion_type'],
    materialTypes: [1, 2],
    note: '需选择小铃铛组件与主播',
  },
};

/* ------------------------------------------------------------------
 * 广告组层级枚举（来自官方「创建广告组」文档 2026-09 版）
 * ---------------------------------------------------------------- */

/** 资源位置 scene_id */
export const SCENE_ID_META: Record<number, { label: string; whiteList?: boolean }> = {
  1: { label: '优选广告位' },
  5: { label: '联盟广告' },
  6: { label: '上下滑大屏广告' },
  7: { label: '双列信息流广告', whiteList: true },
  10: { label: '联盟场景', whiteList: true },
  24: { label: '激励视频', whiteList: true },
  27: { label: '开屏广告位', whiteList: true },
  39: { label: '搜索广告' },
};

/** 创意制作方式 unit_type */
export const UNIT_TYPE_META: Record<number, { label: string }> = {
  3: { label: 'DPA 自定义创意（商品库推广专用）' },
  4: { label: '常规自定义创意' },
  7: { label: '程序化创意 2.0' },
};

/** 出价类型 bid_type */
export const BID_TYPE_META: Record<number, { label: string; bidField: string }> = {
  2: { label: 'CPC（按点击）', bidField: 'bid' },
  10: { label: 'OCPM（按转化）', bidField: 'cpa_bid' },
  12: { label: 'MCB 最大转化（计划 bid_type=1 时必须）', bidField: 'cpa_bid' },
};

/**
 * 优化目标 ocpx_action_type —— 仅列高频值，
 * 完整可选值需调 /rest/openapi/gw/dsp/v1/ocpx/ocpxTypes 按账户查。
 */
export const OCPX_ACTION_TYPE_META: Record<number, { label: string; campaignTypes: number[] }> = {
  2: { label: '行为数（点击）', campaignTypes: [4, 16] },
  180: { label: '激活数', campaignTypes: [2] },
  53: { label: '表单数', campaignTypes: [5] },
  324: { label: '唤起应用', campaignTypes: [7] },
  348: { label: '有效线索', campaignTypes: [5] },
  396: { label: '注册', campaignTypes: [5, 35] },
  394: { label: '订单提交', campaignTypes: [35] },
  190: { label: '付费', campaignTypes: [2, 7, 35] },
  346: { label: '次留（自然日次日留存）', campaignTypes: [2, 7] },
  191: { label: '首日 ROI', campaignTypes: [35] },
  774: { label: '7 日 ROI', campaignTypes: [7, 35] },
  717: { label: '广告观看次数', campaignTypes: [2] },
  739: { label: '7 日付费次数', campaignTypes: [2, 7] },
};

/** 需要 roi_ratio 的优化目标（首日 ROI / 7 日 ROI，官方文档明确必填） */
export const OCPX_ROI_TYPES = new Set<number>([191, 774]);

/**
 * 深度转化目标 deep_conversion_type（双出价里的「深出价」）。
 * 完整可选值需调 /rest/openapi/gw/dsp/v1/ocpx/deepTypes 按账户查，且需白名单。
 */
export const DEEP_CONVERSION_META: Record<number, { label: string }> = {
  3: { label: '付费' },
  7: { label: '次日留存' },
  15: { label: '购买' },
  44: { label: '有效线索' },
  11: { label: '授信' },
  181: { label: '激活后24H次日留存' },
};

/** 应用商店 app_store 取值（use_app_market=1 时生效） */
export const APP_STORE_META: Record<string, string> = {
  huawei: '华为',
  oppo: 'OPPO',
  vivo: 'vivo',
  xiaomi: '小米',
  meizu: '魅族',
  smartian: '锤子',
  honor: '荣耀',
};

/** 素材类型 creative_material_type */
export const CREATIVE_MATERIAL_TYPE_META: Record<number, { label: string; short: string }> = {
  1: { label: '竖版视频', short: '竖视频' },
  2: { label: '横版视频', short: '横视频' },
  5: { label: '竖版图片（优选/联盟）', short: '竖图' },
  6: { label: '横版图片（优选/联盟/信息流）', short: '横图' },
  9: { label: '小图（优选/信息流）', short: '小图' },
  10: { label: '组图（优选/信息流）', short: '组图' },
  11: { label: '开屏视频', short: '开屏视频' },
  12: { label: '开屏图片', short: '开屏图片' },
  14: { label: 'DPA 模板（联盟）', short: 'DPA' },
};

/** 行动号召按钮常用文案 */
export const ACTION_BAR_TEXT_OPTIONS = [
  '立即下载',
  '立即安装',
  '立即体验',
  '立即购买',
  '立即咨询',
  '立即预约',
  '了解详情',
  '查看详情',
  '免费领取',
  '填写表单',
] as const;

/** 落地页形态 web_uri_type（销售线索/应用活跃/电商下单用） */
export const WEB_URI_TYPE_META: Record<number, { label: string; extraField?: string }> = {
  1: { label: '广告主自有链接', extraField: 'url' },
  2: { label: '建站落地页', extraField: 'site_id' },
  3: { label: '程序化落地页', extraField: 'group_id' },
  4: { label: '微信小程序调起链接', extraField: 'schema_uri' },
};

/* ------------------------------------------------------------------
 * 批量任务
 * ---------------------------------------------------------------- */
export const TASK_STATUS = {
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  DONE: 'DONE',
  /** 有成功也有失败 */
  PARTIAL: 'PARTIAL',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;
export type TaskStatus = (typeof TASK_STATUS)[keyof typeof TASK_STATUS];

export const TASK_STATUS_META: Record<string, { text: string; color: string; hint: string }> = {
  PENDING: { text: '待执行', color: 'default', hint: '已入队，等待执行器调度' },
  RUNNING: { text: '执行中', color: 'processing', hint: '正在逐条调用平台接口' },
  PAUSED: { text: '已暂停', color: 'warning', hint: '可恢复继续执行' },
  DONE: { text: '全部成功', color: 'success', hint: '所有条目创建成功' },
  PARTIAL: { text: '部分成功', color: 'warning', hint: '存在失败条目，可重试失败项' },
  FAILED: { text: '全部失败', color: 'error', hint: '所有条目均失败，请查看错误原因' },
  CANCELLED: { text: '已取消', color: 'default', hint: '任务被手动取消' },
};

/** 任务条目层级 */
export const TASK_LEVEL = {
  CAMPAIGN: 'CAMPAIGN',
  UNIT: 'UNIT',
  CREATIVE: 'CREATIVE',
} as const;
export type TaskLevel = (typeof TASK_LEVEL)[keyof typeof TASK_LEVEL];

export const TASK_ITEM_STATUS = {
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
} as const;
export type TaskItemStatus = (typeof TASK_ITEM_STATUS)[keyof typeof TASK_ITEM_STATUS];

/** 创建后回读核验状态 */
export const VERIFY_STATUS = {
  NONE: 'NONE',
  PENDING: 'PENDING',
  OK: 'OK',
  MISMATCH: 'MISMATCH',
  NOT_FOUND: 'NOT_FOUND',
} as const;
export type VerifyStatus = (typeof VERIFY_STATUS)[keyof typeof VERIFY_STATUS];

export const VERIFY_STATUS_META: Record<string, { text: string; color: string; hint: string }> = {
  NONE: { text: '未核验', color: 'default', hint: '尚未回读平台数据' },
  PENDING: { text: '待核验', color: 'default', hint: '已排入核验队列' },
  OK: { text: '核验通过', color: 'success', hint: '平台回读数据与提交内容一致' },
  MISMATCH: { text: '不一致', color: 'warning', hint: '平台回读字段与提交内容有差异' },
  NOT_FOUND: { text: '平台查不到', color: 'error', hint: '创建返回了 ID 但查询不到，需人工确认' },
};
