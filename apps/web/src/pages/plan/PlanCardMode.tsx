import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  DatePicker,
  Drawer,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
  TreeSelect,
  Typography,
} from 'antd';
import dayjs, { Dayjs } from 'dayjs';
import {
  AppstoreOutlined,
  CloseOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  RightOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AccountSummary,
  ACTION_BAR_TEXT_OPTIONS,
  APP_STORE_META,
  CAMPAIGN_TYPE,
  CAMPAIGN_TYPE_META,
  DEEP_CONVERSION_META,
  OCPX_ACTION_TYPE_META,
  OCPX_ROI_TYPES,
  PlanRow,
  SCENE_ID_META,
  WEB_URI_TYPE_META,
} from '@wkbd/shared';
import { api } from '../../api/client';
import { defaultRow, today } from './planRow';
import {
  AssetItem,
  BRAND,
  ChipGroup,
  FormRow,
  HistoryDropdown,
  LpPickerModal,
  pushHistory,
  TimeSeriesPicker,
  VideoPickerModal,
} from './pickers';

export type { AssetItem } from './pickers';

/**
 * 向导模式（2026-09-24 按 mobgi「程序化批量创建」交互规格重做）：
 *
 * 1. **摘要行 + 编辑抽屉**：主页面只放「键：值摘要 + 编辑按钮」，
 *    表单收进右侧抽屉（广告组基本信息 / 定向 / 创意基本信息 / 转化路径）。
 * 2. **创意组模型**：选中的视频按「每组 N 个（默认 8，≤15）」平均分成创意组，
 *    一个创意组 = 一条链路（1 计划 + 1 广告组 + N 个创意），组内视频平均分配。
 * 3. **出价方式是生成策略**：固定（统一出价）/ 随机（区间内随机）/ 阶梯（区间内等差递增），
 *    在「预览广告组」时实体化为每条链路各自的目标出价（与 mobgi 12→12.071→…→14 一致）。
 * 4. **预览区三层树表**（计划 → 广告组 → 创意）：提交前把将要生成的链路全量展示，
 *    确认后才真正生成任务行（表格模式已于 2026-09-25 移除）。
 *
 * 🚫 红线：本页面**没有也不会有**「上传/推送素材到快手主页」入口；
 *    素材只用于广告创意投放。后端网关与任务引擎另有黑名单拦截兜底。
 */

const LAST_TAGS_KEY = 'wkbd_plan_last_creative_tags';

/** 已授权的原生快手号（服务端 /api/plan/assets/native-users 返回） */
interface NativeKwaiUser {
  userId: string;
  userName: string;
  headUrl?: string;
  /** 1 普通快手号 / 2 服务号达人 / 3 聚星达人 */
  kolUserType: number;
}

/**
 * 定向抽屉完整参数（gw/dsp/unit/create 的 target 扩展字段）。
 * 除 gender/platformOs/network（CardForm 直传）外的全部可下发定向。
 */
interface TargetingForm {
  /** 智能定向 inteli_extend_option：0 关闭 / 1 开启 / 2 Pro（白名单） */
  intelliExtend: number;
  /** 用户类型 user_type：0 实时 / 1 常驻 / 2 不限 */
  userType: number;
  /** 地域 region：勾选的省/市 ID（勾父级即代表整个父级，不再传子级） */
  regionIds: number[];
  /** 年龄 ages_range：18-23/24-30/31-40/41-49/50-100 */
  agesRange: number[];
  /** 设备品牌 device_brand_ids */
  deviceBrands: number[];
  /** 设备价格 device_price（新枚举） */
  devicePrices: number[];
  /** 过滤已转化人群 filter_converted_level：0 不限 / 1 广告组 / 2 计划 / 3 本账户 / 4 公司主体 / 5 APP */
  filterConvertedLevel: number;
  /** 过滤已安装APP disable_installed_app_switch：0 过滤（默认）/ 1 不限 */
  disableInstalledApp: number;
  /** 行为兴趣 behavior_type：0 不限 / 2 系统优选（1 自定义需标签库，暂未开放） */
  behaviorType: number;
  /** 人群包定向 population（orientation_id） */
  population: string[];
  /** 人群包排除 exclude_population */
  excludePopulation: string[];
}

const DEFAULT_TARGETING: TargetingForm = {
  intelliExtend: 0,
  userType: 2,
  regionIds: [],
  agesRange: [],
  deviceBrands: [],
  devicePrices: [],
  filterConvertedLevel: 0,
  disableInstalledApp: 0,
  behaviorType: 0,
  population: [],
  excludePopulation: [],
};

/** 设备品牌官方枚举（device_brand_ids） */
const DEVICE_BRAND_OPTIONS = [
  { value: 1, label: '苹果' },
  { value: 2, label: 'vivo' },
  { value: 3, label: 'OPPO' },
  { value: 4, label: '华为' },
  { value: 5, label: '小米' },
  { value: 6, label: '荣耀' },
  { value: 7, label: '三星' },
  { value: 8, label: '魅族' },
  { value: 18, label: '360' },
  { value: 26, label: '谷歌' },
  { value: 29, label: '康佳' },
];

/** 设备价格官方枚举（device_price，新枚举值） */
const DEVICE_PRICE_OPTIONS = [
  { value: 11, label: '1000元以下' },
  { value: 12, label: '1001~1500' },
  { value: 2, label: '1501~2000' },
  { value: 3, label: '2001~2500' },
  { value: 4, label: '2501~3000' },
  { value: 5, label: '3001~3500' },
  { value: 6, label: '3501~4000' },
  { value: 13, label: '4001~5000' },
  { value: 14, label: '5001~6000' },
  { value: 15, label: '6000元以上' },
];

/** 年龄段官方枚举（ages_range） */
const AGE_OPTIONS = [
  { value: 18, label: '18-23岁' },
  { value: 24, label: '24-30岁' },
  { value: 31, label: '31-40岁' },
  { value: 41, label: '41-49岁' },
  { value: 50, label: '50岁以上' },
];

/** 策略组快照用的表单形态（整份 CardForm 序列化即可复用） */
export interface CardForm {
  advertiserId: string;
  namePrefix: string;
  /** 广告类型（计划 ad_type）：0 展示（信息流）/ 1 搜索（本期未实现） */
  adType: number;
  /** 投放方式：normal 常规 / auto 全自动（auto_manage，白名单） */
  putMode: 'normal' | 'auto';
  /** 全自动投放：周期稳投（计划级 periodic_delivery_type，白名单特性，真实下发） */
  cycleStable: boolean;
  /** 周期稳投-投放周期（periodic_days）：官方默认 7 天，加白后支持 5 天 */
  stableDays: number;
  /** 周期稳投-续投（continue_period_type） */
  stableRenew: boolean;
  /** 全自动投放：广告组命名规则模板，支持通配符 [序号]/[日期]/[时间] */
  unitNameTpl: string;
  /** 创意名直接用素材（视频）名，忽略命名模板 */
  creativeNameSameAsMaterial: boolean;
  /** 广告创意命名规则模板（常规/全自动均生效，支持通配符） */
  creativeNameTpl: string;
  /** 全自动+周期稳投开启：周期总预算（元，系统在稳投周期内总消耗上限） */
  cycleBudgetYuan: number | null;
  /** 出价分配规则：same 全部相同 / perAccount 按账户分配 */
  bidAssign: 'same' | 'perAccount';
  /** 按账户分配：账户 ID → 固定出价（元） */
  accountBids: Record<string, number | null>;
  /** 广告组名称配置：unified 统一配置 / perAccount 分账户配置 */
  nameMode: 'unified' | 'perAccount';
  /** 分账户配置：账户 ID → 命名前缀 */
  accountNamePrefixes: Record<string, string>;
  /** 动态标号起始值（广告组/创意名称的 _01 序号从该值开始） */
  unitSeqStart: number;
  creativeSeqStart: number;
  /** 投放位置：1 智能优选 / 2 手动选择 */
  sceneMode: number;
  sceneIds: number[];
  /** 竞价策略（计划 bid_type）：0 成本优先 / 1 最大转化 */
  bidStrategy: 0 | 1;
  bidType: number;
  /** 出价方式（oCPM 生成策略）：fixed 固定 / random 随机 / ladder 阶梯 */
  bidMode: 'fixed' | 'random' | 'ladder';
  bidYuan: number | null;
  cpaBidYuan: number | null;
  /** 出价范围（随机 / 阶梯用） */
  bidMinYuan: number | null;
  bidMaxYuan: number | null;
  ocpxActionType: number | null;
  /** 付费 ROI 系数（首日/7日 ROI 优化目标必填） */
  roiRatio: number | null;
  /** 深度优化目标（双出价，白名单） */
  deepEnabled: boolean;
  deepConversionType: number | null;
  deepConversionBidYuan: number | null;
  platformOs: number;
  /** 应用下载方式（type 2/7）：0 直接下载 / 1 落地页下载 */
  downloadMode: 0 | 1;
  /** 落地页下载时的下载中间页（建站）ID */
  downloadSiteId: string | null;
  /** 优先从应用商店下载 + 商店列表 */
  useAppMarket: boolean;
  appStores: string[];
  gender: number;
  network: number;
  /** 定向抽屉完整参数（组级 target 扩展字段，真实下发） */
  targeting: TargetingForm;
  /** 每日预算：unlimited 不限 / unified 统一预算 */
  budgetMode: 'unlimited' | 'unified';
  campaignDayBudgetYuan: number | null;
  unitDayBudgetYuan: number | null;
  /** 排期：long 长期投放 / custom 设定起止 */
  scheduleMode: 'long' | 'custom';
  beginTime: string;
  endTime: string;
  /** 投放时段：all 全天 / custom 特定时间（168 格） */
  timeMode: 'all' | 'custom';
  timeSeries: boolean[];
  /** 创意展现方式 show_mode：2 智能优选（平台默认）/ 1 随机轮播 */
  showMode: number;
  actionBarText: string;
  creativeTags: string[];
  /** 创意分类（creative_category，树形下拉选叶子类目） */
  creativeCategory: number | null;
  /**
   * ——— 搜索相关（对齐创量真实结构，2026-09-25 实测）———
   * 搜索快投（组级 quick_search）：属于「展示广告」创意层开关——选择智能优选或
   * 上下滑大屏广告版位后开启，即可获得搜索流量；需白名单；MAPI 暂不支持添加关键词。
   * 搜索广告（ad_type=1）创意层只有：智能扩词 / 否定词 / 搜索人群追投，没有快投。
   */
  searchQuick: boolean;
  /** 智能扩词（extend_search，仅搜索广告） */
  searchExtend: boolean;
  /** 搜索人群追投（target_explore，仅搜索广告） */
  searchExplore: boolean;
  /** 短语否定词文本（一行一词，≤200，仅搜索广告） */
  searchNegPhraseText: string;
  /** 精确否定词文本（一行一词，≤200，仅搜索广告） */
  searchNegExactText: string;
  /** 原生广告投放（outer_loop_native + kol 两项） */
  nativeAd: boolean;
  /** 原生广告-授权类型：1 服务号授权 / 2 达人视频授权 / 3 普通快手号 */
  nativeAuthType: number;
  /** 原生广告-统一配置下选定的快手号（user_id，来自账户已授权快手号列表） */
  nativeKwaiUserId: string | null;
  /** PLC 描述语配置方式：unified 统一配置 / manual 手动设置禁用词汇 */
  plcMode: 'unified' | 'manual';
  /** PLC 描述语文案（统一配置时填写，≤13 字，下发 recommendation 字段） */
  plcText: string;
  /** 推荐理由（多选，下发 new_expose_tag） */
  recommendReasons: string[];
  /** 文案列表（按视频顺序轮转分配） */
  titlesList: string[];
  /** 创意组模型：每个创意组的视频数（平台单组 ≤15） */
  groupSize: number;
  /** 每条计划建几个广告组（>1 时同一批素材在每个组下各建一轮创意） */
  unitsPerCampaign: number;
  /** 素材分配规则（单账户版：全账户使用与平均分配等价，保留样式对齐） */
  assignRule: 'all' | 'even';
  // type 2/7
  appId: string | null;
  packageId: string | null;
  // type 5
  webUriType: number;
  url: string;
  siteId: string | null;
  /** 第三方点击监测链接（创意层；激活优化目标未接 SDK 时官方必填） */
  clickMonitorUrl: string;
  /** 第三方开始播放监测链接（创意层，仅自定义创意支持） */
  impressionMonitorUrl: string;
}

const ALL_HOURS_TRUE = (): boolean[] => Array.from({ length: 168 }, () => true);

const boolToSeries = (cells: boolean[]): string =>
  cells.map((on) => (on ? '1' : '0')).join('');

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** 文本域 → 关键词列表：按行/逗号拆分、去空白、去重 */
function parseLines(raw: string): string[] {
  const out: string[] = [];
  for (const piece of raw.split(/[\r\n,，]+/)) {
    const word = piece.trim();
    if (word && !out.includes(word)) out.push(word);
  }
  return out;
}

/** 平均分组成创意组：每组不超过 maxPerGroup，组数最少，组间数量差不超过 1 */
function splitEvenly<T>(items: T[], maxPerGroup: number): T[][] {
  if (items.length === 0) return [];
  const groupCount = Math.max(1, Math.ceil(items.length / Math.max(1, maxPerGroup)));
  const base = Math.floor(items.length / groupCount);
  const extra = items.length % groupCount;
  const groups: T[][] = [];
  let cursor = 0;
  for (let g = 0; g < groupCount; g += 1) {
    const size = base + (g < extra ? 1 : 0);
    groups.push(items.slice(cursor, cursor + size));
    cursor += size;
  }
  return groups;
}

/** 均分成恰好 k 份（组间数量差 ≤1；k > 数量时后面的份为空，由调用方跳过） */
function splitAcross<T>(items: T[], k: number): T[][] {
  const out: T[][] = Array.from({ length: Math.max(1, k) }, () => []);
  if (items.length === 0 || k <= 0) return out;
  const base = Math.floor(items.length / k);
  const extra = items.length % k;
  let cursor = 0;
  for (let i = 0; i < k; i += 1) {
    const size = base + (i < extra ? 1 : 0);
    out[i] = items.slice(cursor, cursor + size);
    cursor += size;
  }
  return out;
}

/**
 * 校验字段 → 出错表单所在位置。
 * - 对应编辑抽屉字段：定位时打开抽屉并高亮 fld-<field> 的表单项；
 * - null：素材类问题（创意组卡片本身就是问题点，只滚动高亮卡片）；
 * - 未登记的字段：只滚动高亮创意组卡片（保守兜底）。
 */
const FIELD_DRAWER: Record<string, 'group' | 'target' | 'creative' | 'conversion' | null> = {
  // 转化路径（应用/落地页）
  appId: 'conversion',
  packageId: 'conversion',
  webUriType: 'conversion',
  url: 'conversion',
  siteId: 'conversion',
  clickMonitorUrl: 'conversion',
  impressionMonitorUrl: 'conversion',
  groupId: 'conversion',
  schemaUri: 'conversion',
  seriesId: 'conversion',
  episodeId: 'conversion',
  jingleBellId: 'conversion',
  liveUserId: 'conversion',
  // 广告组基本信息（竞价/预算/排期/版位/命名）
  campaignName: 'group',
  campaignType: 'group',
  campaignDayBudgetYuan: 'group',
  unitName: 'group',
  creativeName: 'group', // 创意名由「广告创意命名规则」模板生成，模板在广告组抽屉
  bidType: 'group',
  bidYuan: 'group',
  cpaBidYuan: 'group',
  ocpxActionType: 'group',
  sceneIds: 'group',
  unitType: 'group',
  beginTime: 'group',
  endTime: 'group',
  scheduleTime: 'group',
  unitDayBudgetYuan: 'group',
  // 创意基本信息
  materialType: 'creative',
  actionBarText: 'creative',
  description: null, // 文案在主页「文案」卡片（fld-description）
  imageTokens: null,
  creativeTags: 'creative',
  // 素材
  photoId: null,
  creativeVideos: null,
};

export function PlanCardMode(props: {
  campaignType: number;
  accounts: AccountSummary[];
  hasRows: number;
  onGenerate: (rows: PlanRow[]) => void;
  /** 错误定位：报错弹窗点击某条错误后，跳转到第 N 行（创意组）卡片；
   *  带 field 时进一步打开对应编辑抽屉并高亮出错的表单项。 */
  locate?: { rowNo: number; field?: string | null } | null;
  /** 策略组保存：父组件用 ref 随时读取当前完整表单快照（不触发重渲染） */
  strategyRef?: React.MutableRefObject<(CardForm & { __videos?: string[] }) | null>;
  /** 策略组载入：token 变化时把 form 整体恢复到卡片模式（含已选素材 id） */
  loadSignal?: { token: number; form: Partial<CardForm> & { __videos?: string[] } } | null;
}) {
  const { campaignType, accounts, hasRows, onGenerate, locate, strategyRef, loadSignal } = props;
  const queryClient = useQueryClient();
  const { message, modal } = App.useApp();

  const [form, setForm] = useState<CardForm>(() => ({
    advertiserId: accounts[0]?.advertiserId ?? '',
    namePrefix: defaultPrefix(),
    adType: 0,
    putMode: 'normal',
    cycleStable: false,
    stableDays: 7,
    stableRenew: false,
    unitNameTpl: `${defaultPrefix()}-[日期]-[序号]`,
    creativeNameSameAsMaterial: false,
    creativeNameTpl: `${defaultPrefix()}-[日期]-创意[序号]`,
    cycleBudgetYuan: null,
    bidAssign: 'same',
    accountBids: {},
    nameMode: 'unified',
    accountNamePrefixes: {},
    unitSeqStart: 1,
    creativeSeqStart: 1,
    sceneMode: 1,
    sceneIds: [1],
    bidStrategy: 0,
    bidType: 10,
    bidMode: 'fixed',
    bidYuan: null,
    cpaBidYuan: null,
    bidMinYuan: null,
    bidMaxYuan: null,
    ocpxActionType: defaultRow(campaignType, '', 0).ocpxActionType ?? null,
    roiRatio: null,
    deepEnabled: false,
    deepConversionType: 3,
    deepConversionBidYuan: null,
    platformOs: 0,
    downloadMode: 0,
    downloadSiteId: null,
    useAppMarket: false,
    appStores: Object.keys(APP_STORE_META),
    gender: 0,
    network: 0,
    targeting: { ...DEFAULT_TARGETING },
    budgetMode: 'unlimited',
    campaignDayBudgetYuan: null,
    unitDayBudgetYuan: null,
    scheduleMode: 'long',
    // 长期投放的开始日期每次打开取当天，避免默认值过期导致创建失败
    beginTime: today(),
    endTime: '',
    timeMode: 'all',
    timeSeries: ALL_HOURS_TRUE(),
    showMode: 2,
    actionBarText: campaignType === 2 ? '立即下载' : '了解详情',
    creativeTags: [],
    creativeCategory: null,
    searchQuick: false,
    searchExtend: false,
    searchExplore: false,
    searchNegPhraseText: '',
    searchNegExactText: '',
    nativeAd: false,
    nativeAuthType: 3,
    nativeKwaiUserId: null,
    plcMode: 'unified',
    plcText: '',
    recommendReasons: [],
    titlesList: [],
    groupSize: 8,
    unitsPerCampaign: 1,
    assignRule: 'even',
    appId: null,
    packageId: null,
    webUriType: 1,
    url: '',
    siteId: null,
    clickMonitorUrl: '',
    impressionMonitorUrl: '',
  }));
  const patch = (p: Partial<CardForm>) => setForm((f) => ({ ...f, ...p }));

  /* ---------------- 策略组：表单快照上报 / 载入（effect 在 selectedVideos 声明后） ---------------- */

  const isAppGoal = campaignType === 2 || campaignType === 7;

  /** 版位互斥：优选(1)与其他具体版位不能同时选 */
  const toggleScenes = (next: number[]) => {
    const had = form.sceneIds.includes(1);
    if (next.includes(1) && !had) {
      patch({ sceneIds: [1] });
      return;
    }
    if (next.includes(1) && next.length > 1) {
      patch({ sceneIds: next.filter((v) => v !== 1) });
      return;
    }
    patch({ sceneIds: next });
  };

  /** 素材账户：账户列表到位后补默认值；顶部多选变化后当前素材账户被移除时回落到第一个 */
  useEffect(() => {
    setForm((f) => {
      if (accounts.length === 0) return f;
      if (accounts.some((a) => a.advertiserId === f.advertiserId)) return f;
      return { ...f, advertiserId: accounts[0].advertiserId };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts.length, form.advertiserId]);

  const [selectedVideos, setSelectedVideos] = useState<string[]>([]);

  /* ---------------- 策略组：表单快照上报 / 载入 ---------------- */
  // 保存侧：任何表单变化都同步到父组件的 ref，父组件「保存策略组」时直接读
  useEffect(() => {
    if (strategyRef) strategyRef.current = { ...form, __videos: selectedVideos };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, selectedVideos]);
  // 载入侧：token 变化即整体恢复（合并到默认值之上，容忍字段增减）
  const appliedLoadToken = useRef(-1);
  useEffect(() => {
    if (!loadSignal || loadSignal.token === appliedLoadToken.current) return;
    appliedLoadToken.current = loadSignal.token;
    const { __videos, ...rest } = loadSignal.form;
    setForm((f) => ({ ...f, ...rest }));
    if (__videos) setSelectedVideos(__videos);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadSignal]);

  const [videoModalOpen, setVideoModalOpen] = useState(false);
  const [lpModalOpen, setLpModalOpen] = useState(false);
  /** 应用「落地页下载」的下载中间页选择弹窗（type 2/7） */
  const [downloadLpOpen, setDownloadLpOpen] = useState(false);
  /** 换账户后，已选素材与表单里残留的链路参数都不再成立 */
  const [tagInput, setTagInput] = useState('');

  /* ---------------- 编辑抽屉 ---------------- */
  const [drawer, setDrawer] = useState<null | 'group' | 'target' | 'creative' | 'conversion'>(null);
  const openDrawer = (d: 'group' | 'target' | 'creative' | 'conversion') => setDrawer(d);
  const closeDrawer = () => setDrawer(null);

  /* ---------------- 错误定位（提交报错弹窗 → 跳到对应创意组卡片/表单项） ---------------- */
  const [flashRow, setFlashRow] = useState<number | null>(null);
  const [flashField, setFlashField] = useState<string | null>(null);
  useEffect(() => {
    if (!locate) return;
    const { rowNo, field } = locate;
    const el = document.getElementById(`plan-group-card-${rowNo}`);
    if (!el && !field) {
      message.info(`第 ${rowNo} 行对应的创意组已不存在，请重新「预览生成」`);
      return;
    }
    // 1. 先滚到出错行对应的创意组卡片
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlashRow(rowNo);
    // 2. 字段级定位：抽屉字段 → 打开抽屉滚到表单项；
    //    主页锚点字段（description=文案卡 / photoId 等素材类）→ 滚到主页锚点
    if (field) {
      setFlashField(field);
      const drawerTarget = FIELD_DRAWER[field];
      const delay = drawerTarget ? 400 : 150; // 抽屉打开有动画，多等一拍
      setTimeout(() => {
        document
          .getElementById(`fld-${field}`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, delay);
      if (drawerTarget) openDrawer(drawerTarget);
    }
    const timer = setTimeout(() => {
      setFlashRow(null);
      setFlashField(null);
    }, 2500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locate]);

  /* ---------------- 资产同步 ---------------- */

  const videosQuery = useQuery({
    queryKey: ['plan-assets', 'videos', form.advertiserId],
    queryFn: () =>
      api.get<AssetItem[]>(`/api/plan/assets/videos?advertiserId=${form.advertiserId}`),
    enabled: Boolean(form.advertiserId),
  });
  const appsQuery = useQuery({
    queryKey: ['plan-assets', 'apps', form.advertiserId],
    queryFn: () => api.get<AssetItem[]>(`/api/plan/assets/apps?advertiserId=${form.advertiserId}`),
    enabled: Boolean(form.advertiserId) && (campaignType === 2 || campaignType === 7),
  });
  const lpQuery = useQuery({
    queryKey: ['plan-assets', 'lp', form.advertiserId],
    queryFn: () =>
      api.get<AssetItem[]>(`/api/plan/assets/lp-pages?advertiserId=${form.advertiserId}`),
    // 销售线索用建站落地页；应用类目标「落地页下载」需要下载中间页（同为建站资产）
    enabled: Boolean(form.advertiserId) && (campaignType === 5 || isAppGoal),
  });

  /* ---------------- 原生快手号（已授权账户拉取） ---------------- */

  /** 服务端返回的已授权原生快手号（gw/dsp/v1/native/user/list） */
  const nativeUsersQuery = useQuery({
    queryKey: ['plan-assets', 'native-users', form.advertiserId],
    queryFn: () =>
      api.get<NativeKwaiUser[]>(`/api/plan/assets/native-users?advertiserId=${form.advertiserId}`),
    enabled: Boolean(form.advertiserId) && form.nativeAd,
  });
  /** 授权类型 → 平台达人类型：服务号授权→2 服务号达人，达人视频授权→3 聚星达人，普通快手号→1 */
  const nativeKolType = form.nativeAuthType === 1 ? 2 : form.nativeAuthType === 2 ? 3 : 1;
  const nativeUsers = useMemo(
    () => (nativeUsersQuery.data ?? []).filter((u) => u.kolUserType === nativeKolType),
    [nativeUsersQuery.data, nativeKolType],
  );
  const nativeKwaiUser = useMemo(
    () => nativeUsers.find((u) => u.userId === form.nativeKwaiUserId) ?? null,
    [nativeUsers, form.nativeKwaiUserId],
  );

  /* ---------------- 定向抽屉数据源（地域树 / 人群包） ---------------- */

  interface RegionNodeDto {
    id: number;
    name: string;
    level: number;
    parent: number;
    children: RegionNodeDto[];
  }
  interface PopulationDto {
    id: string;
    name: string;
    recordSize: number;
    status: number;
  }
  const regionsQuery = useQuery({
    queryKey: ['plan-assets', 'regions', form.advertiserId],
    queryFn: () =>
      api.get<RegionNodeDto[]>(`/api/plan/assets/regions?advertiserId=${form.advertiserId}`),
    // 定向抽屉打开时才拉（地域树一次性全量，服务端按账户 token 拉取后全局缓存 24h）
    enabled: Boolean(form.advertiserId) && drawer === 'target',
  });
  const populationsQuery = useQuery({
    queryKey: ['plan-assets', 'populations', form.advertiserId],
    queryFn: () =>
      api.get<PopulationDto[]>(`/api/plan/assets/populations?advertiserId=${form.advertiserId}`),
    enabled: Boolean(form.advertiserId) && drawer === 'target',
  });

  /* ---------------- 定向包（对齐创量：先建包、上计划时选择） ---------------- */

  interface TargetPackageDto {
    id: number;
    name: string;
    note: string | null;
    targeting: Record<string, unknown>;
  }
  const packagesQuery = useQuery({
    queryKey: ['plan-target-packages'],
    queryFn: () => api.get<TargetPackageDto[]>('/api/plan/target-packages'),
    enabled: drawer === 'target',
  });
  /** 当前卡片应用的定向包 id（仅作展示；参数改动后仍以此为准，不做双向回写） */
  const [appliedPackageId, setAppliedPackageId] = useState<number | null>(null);
  const savePackageMutation = useMutation({
    mutationFn: (payload: { name: string; targeting: Record<string, unknown> }) =>
      api.post<TargetPackageDto>('/api/plan/target-packages', payload),
    onSuccess: (pkg) => {
      void queryClient.invalidateQueries({ queryKey: ['plan-target-packages'] });
      setAppliedPackageId(pkg.id);
      message.success(`定向包「${pkg.name}」已保存`);
    },
  });
  /** 保存当前参数到已选中的定向包（覆盖更新） */
  const updatePackageMutation = useMutation({
    mutationFn: (payload: { id: number; name: string; targeting: Record<string, unknown> }) =>
      api.put<TargetPackageDto>(`/api/plan/target-packages/${payload.id}`, {
        name: payload.name,
        targeting: payload.targeting,
      }),
    onSuccess: (pkg) => {
      void queryClient.invalidateQueries({ queryKey: ['plan-target-packages'] });
      setAppliedPackageId(pkg.id);
      message.success(`定向包「${pkg.name}」已更新`);
    },
  });
  const removePackageMutation = useMutation({
    mutationFn: (id: number) => api.del(`/api/plan/target-packages/${id}`),
    onSuccess: (_d, id) => {
      void queryClient.invalidateQueries({ queryKey: ['plan-target-packages'] });
      if (appliedPackageId === id) setAppliedPackageId(null);
      message.success('定向包已删除');
    },
  });
  /** 当前表单 → 包体：定向抽屉序列化结果 + 顶层性别 */
  const pkgFromForm = (): Record<string, unknown> => ({
    ...buildTargetingPayload(),
    ...(form.gender !== 0 ? { gender: form.gender } : {}),
  });
  /** 包体 → 表单：平台键反解回定向抽屉结构 */
  const applyPkgTargeting = (t: Record<string, unknown>) => {
    const num = (v: unknown, d: number) => (typeof v === 'number' ? v : v != null ? Number(v) : d);
    const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
    patch({
      gender: num(t.gender, 0),
      targeting: {
        ...form.targeting,
        regionIds: arr(t.region).map(Number),
        userType: num(t.user_type, 2),
        agesRange: arr(t.ages_range).map(Number),
        deviceBrands: arr(t.device_brand_ids).map(Number),
        devicePrices: arr(t.device_price).map(Number),
        filterConvertedLevel: num(t.filter_converted_level, 0),
        disableInstalledApp: num(t.disable_installed_app_switch, 0),
        intelliExtend: num(t.inteli_extend_option, 0),
        behaviorType: num(t.behavior_type, 0),
        population: arr(t.population).map(String),
        excludePopulation: arr(t.exclude_population).map(String),
      },
    });
  };
  /** 应用定向包：整体覆盖当前定向参数 */
  const applyPackage = (pkgId: number | null) => {
    setAppliedPackageId(pkgId);
    if (pkgId == null) return;
    const pkg = packagesQuery.data?.find((p) => p.id === pkgId);
    if (pkg?.targeting) {
      applyPkgTargeting(pkg.targeting);
      message.success(`已应用定向包「${pkg.name}」`);
    }
  };

  /* ---------------- 文案包（可复用的文案批次资产，对齐定向包模式） ---------------- */

  interface CopyPackageDto {
    id: number;
    name: string;
    note: string | null;
    titles: string[];
  }
  const copyPackagesQuery = useQuery({
    queryKey: ['plan-copy-packages'],
    queryFn: () => api.get<CopyPackageDto[]>('/api/plan/copy-packages'),
  });
  const [appliedCopyId, setAppliedCopyId] = useState<number | null>(null);
  const saveCopyMutation = useMutation({
    mutationFn: (payload: { name: string; titles: string[] }) =>
      api.post<CopyPackageDto>('/api/plan/copy-packages', payload),
    onSuccess: (pkg) => {
      void queryClient.invalidateQueries({ queryKey: ['plan-copy-packages'] });
      setAppliedCopyId(pkg.id);
      message.success(`文案包「${pkg.name}」已保存`);
    },
  });
  /** 保存当前文案列表到已选中的文案包（覆盖更新） */
  const updateCopyMutation = useMutation({
    mutationFn: (payload: { id: number; name: string; titles: string[] }) =>
      api.put<CopyPackageDto>(`/api/plan/copy-packages/${payload.id}`, {
        name: payload.name,
        titles: payload.titles,
      }),
    onSuccess: (pkg) => {
      void queryClient.invalidateQueries({ queryKey: ['plan-copy-packages'] });
      setAppliedCopyId(pkg.id);
      message.success(`文案包「${pkg.name}」已更新`);
    },
  });
  const removeCopyMutation = useMutation({
    mutationFn: (id: number) => api.del(`/api/plan/copy-packages/${id}`),
    onSuccess: (_d, id) => {
      void queryClient.invalidateQueries({ queryKey: ['plan-copy-packages'] });
      if (appliedCopyId === id) setAppliedCopyId(null);
      message.success('文案包已删除');
    },
  });
  /** 应用文案包：整体覆盖当前文案列表 */
  const applyCopyPackage = (id: number | null) => {
    setAppliedCopyId(id);
    if (id == null) return;
    const pkg = copyPackagesQuery.data?.find((p) => p.id === id);
    if (pkg?.titles?.length) {
      patch({ titlesList: [...pkg.titles] });
      message.success(`已应用文案包「${pkg.name}」（${pkg.titles.length} 条）`);
    }
  };
  /** 当前文案列表 → 文案包（另存为弹窗共用） */
  const saveCopyAs = () => {
    if (form.titlesList.length === 0) {
      message.warning('当前没有文案，先添加或应用一个文案包');
      return;
    }
    let pkgName = '';
    modal.confirm({
      title: '另存为新文案包',
      content: (
        <Input
          placeholder="文案包名称，如：传奇开服通用文案"
          onChange={(e) => {
            pkgName = e.target.value;
          }}
        />
      ),
      onOk: () =>
        saveCopyMutation.mutateAsync({
          name: pkgName.trim() || `文案包 ${dayjs().format('MM-DD HH:mm')}`,
          titles: [...form.titlesList],
        }),
    });
  };

  /* ---------------- 监测链接包（命名的第三方监测链接资产，多账户创编可复用） ---------------- */

  interface MonitorPackageDto {
    id: number;
    name: string;
    note: string | null;
    clickUrl: string;
    impressionUrl: string;
  }
  const monitorPackagesQuery = useQuery({
    queryKey: ['plan-monitor-packages'],
    queryFn: () => api.get<MonitorPackageDto[]>('/api/plan/monitor-packages'),
  });
  const [appliedMonitorId, setAppliedMonitorId] = useState<number | null>(null);
  const saveMonitorMutation = useMutation({
    mutationFn: (payload: { name: string; clickUrl: string; impressionUrl: string }) =>
      api.post<MonitorPackageDto>('/api/plan/monitor-packages', payload),
    onSuccess: (pkg) => {
      void queryClient.invalidateQueries({ queryKey: ['plan-monitor-packages'] });
      setAppliedMonitorId(pkg.id);
      message.success(`监测链接「${pkg.name}」已保存`);
    },
  });
  const updateMonitorMutation = useMutation({
    mutationFn: (payload: { id: number; name: string; clickUrl: string; impressionUrl: string }) =>
      api.put<MonitorPackageDto>(`/api/plan/monitor-packages/${payload.id}`, {
        name: payload.name,
        clickUrl: payload.clickUrl,
        impressionUrl: payload.impressionUrl,
      }),
    onSuccess: (pkg) => {
      void queryClient.invalidateQueries({ queryKey: ['plan-monitor-packages'] });
      setAppliedMonitorId(pkg.id);
      message.success(`监测链接「${pkg.name}」已更新`);
    },
  });
  const removeMonitorMutation = useMutation({
    mutationFn: (id: number) => api.del(`/api/plan/monitor-packages/${id}`),
    onSuccess: (_d, id) => {
      void queryClient.invalidateQueries({ queryKey: ['plan-monitor-packages'] });
      if (appliedMonitorId === id) setAppliedMonitorId(null);
      message.success('监测链接已删除');
    },
  });
  /** 应用监测链接包：整体覆盖点击/展示监测链接 */
  const applyMonitorPackage = (id: number | null) => {
    setAppliedMonitorId(id);
    if (id == null) return;
    const pkg = monitorPackagesQuery.data?.find((p) => p.id === id);
    if (pkg) {
      patch({ clickMonitorUrl: pkg.clickUrl, impressionMonitorUrl: pkg.impressionUrl });
      message.success(`已应用监测链接「${pkg.name}」`);
    }
  };
  /** 当前两条监测链接 → 保存 / 覆盖当前包 / 另存为新包 */
  const monitorUrlsReady = () =>
    Boolean(form.clickMonitorUrl.trim() || form.impressionMonitorUrl.trim());
  /** 命名弹窗共用：名称必填（不自动生成随机名），返回 Promise.reject 保持弹窗不关 */
  const askMonitorName = (title: string, initial: string, onOk: (name: string) => Promise<unknown>) => {
    let name = initial;
    modal.confirm({
      title,
      content: (
        <Input
          defaultValue={initial}
          autoFocus
          placeholder="名称，如：盼之回传-游戏A"
          onChange={(e) => {
            name = e.target.value;
          }}
        />
      ),
      onOk: () => {
        const trimmed = name.trim();
        if (!trimmed) {
          message.warning('请填写监测链接名称');
          return Promise.reject();
        }
        return onOk(trimmed);
      },
    });
  };
  const saveMonitorAs = () => {
    if (!monitorUrlsReady()) {
      message.warning('先填写点击或展示监测链接，再保存为监测链接');
      return;
    }
    askMonitorName('保存为监测链接', '', (name) =>
      saveMonitorMutation.mutateAsync({
        name,
        clickUrl: form.clickMonitorUrl.trim(),
        impressionUrl: form.impressionMonitorUrl.trim(),
      }),
    );
  };
  /** 重命名当前监测链接模板（链接内容不变） */
  const renameMonitor = () => {
    if (appliedMonitorId == null) return;
    const pkg = monitorPackagesQuery.data?.find((p) => p.id === appliedMonitorId);
    if (!pkg) return;
    askMonitorName('重命名监测链接', pkg.name, (name) =>
      updateMonitorMutation.mutateAsync({
        id: pkg.id,
        name,
        clickUrl: pkg.clickUrl,
        impressionUrl: pkg.impressionUrl,
      }),
    );
  };
  const updateMonitorCurrent = () => {
    if (appliedMonitorId == null) return;
    if (!monitorUrlsReady()) {
      message.warning('监测链接不能全部为空');
      return;
    }
    const pkg = monitorPackagesQuery.data?.find((p) => p.id === appliedMonitorId);
    updateMonitorMutation.mutate({
      id: appliedMonitorId,
      name: pkg?.name ?? '监测链接',
      clickUrl: form.clickMonitorUrl.trim(),
      impressionUrl: form.impressionMonitorUrl.trim(),
    });
  };

  /* ---------------- 创意分类树（creative_category 只能选叶子类目） ---------------- */

  interface CategoryNodeDto {
    id: number;
    name: string;
    parentId: number;
    level: number;
    children: CategoryNodeDto[];
  }
  const categoriesQuery = useQuery({
    queryKey: ['plan-assets', 'creative-categories', form.advertiserId],
    queryFn: () =>
      api.get<CategoryNodeDto[]>(
        `/api/plan/assets/creative-categories?advertiserId=${form.advertiserId}`,
      ),
    // 创意抽屉打开时才拉（树一次性全量，服务端缓存 24h）
    enabled: Boolean(form.advertiserId) && drawer === 'creative',
  });
  const categoryTreeData = useMemo(() => {
    const walk = (
      nodes: CategoryNodeDto[],
    ): { value: number; title: string; selectable: boolean; children?: unknown[] }[] =>
      nodes.map((n) => ({
        value: n.id,
        title: n.name,
        // 官方约束：creative_category 只能传叶子类目
        selectable: n.children.length === 0,
        children: n.children.length ? walk(n.children) : undefined,
      }));
    return walk(categoriesQuery.data ?? []);
  }, [categoriesQuery.data]);
  const categoryNameOf = useMemo(() => {
    const map = new Map<number, string>();
    const walk = (nodes: CategoryNodeDto[]) => {
      for (const n of nodes) {
        map.set(n.id, n.name);
        walk(n.children);
      }
    };
    walk(categoriesQuery.data ?? []);
    return map;
  }, [categoriesQuery.data]);
  /** 平台地域树 → TreeSelect 数据（父子级联，多选） */
  const regionTreeData = useMemo(() => {
    const walk = (nodes: RegionNodeDto[]): { value: number; title: string; children?: { value: number; title: string }[] }[] =>
      nodes.map((n) => ({
        value: n.id,
        title: n.name,
        children: n.children.length ? walk(n.children) : undefined,
      }));
    return walk(regionsQuery.data ?? []);
  }, [regionsQuery.data]);
  const populationOptions = useMemo(
    () =>
      (populationsQuery.data ?? []).map((p) => ({
        value: p.id,
        label: `${p.name}（${p.recordSize > 0 ? `${(p.recordSize / 10000).toFixed(1)}万` : '新'}）`,
      })),
    [populationsQuery.data],
  );

  /**
   * 把定向抽屉的表单值折叠成平台 target 扩展对象。
   * 「不限」的一律不发；地域用 TreeSelect SHOW_PARENT 策略天然满足
   * 官方规则「勾父级只传父级 ID，不与子级同时传」。
   */
  const buildTargetingPayload = (): Record<string, unknown> => {
    const t = form.targeting;
    const out: Record<string, unknown> = {};
    if (t.regionIds.length > 0) out.region = [...t.regionIds];
    if (t.userType !== 2) out.user_type = t.userType;
    if (t.agesRange.length > 0) out.ages_range = [...t.agesRange];
    if (t.deviceBrands.length > 0) out.device_brand_ids = [...t.deviceBrands];
    if (t.devicePrices.length > 0) out.device_price = [...t.devicePrices];
    if (t.filterConvertedLevel > 0) out.filter_converted_level = t.filterConvertedLevel;
    if (t.disableInstalledApp === 1) out.disable_installed_app_switch = 1;
    if (t.intelliExtend !== 0) out.inteli_extend_option = t.intelliExtend;
    if (t.behaviorType !== 0) out.behavior_type = t.behaviorType;
    if (t.population.length > 0) out.population = t.population.map(Number);
    if (t.excludePopulation.length > 0) out.exclude_population = t.excludePopulation.map(Number);
    return out;
  };

  /** 强制刷新：绕过服务端 10 分钟缓存 */
  const refreshAssets = (kind: 'videos' | 'apps' | 'lp') => {
    if (!form.advertiserId) return;
    api
      .get<AssetItem[]>(
        `/api/plan/assets/${kind === 'lp' ? 'lp-pages' : kind}?advertiserId=${form.advertiserId}&force=1`,
      )
      .then((data) => queryClient.setQueryData(['plan-assets', kind, form.advertiserId], data))
      .catch(() => undefined);
  };

  const videos = useMemo(
    () => (videosQuery.data ?? []).filter((v) => v.status === undefined || v.status === 1),
    [videosQuery.data],
  );
  const apps = appsQuery.data ?? [];
  const lpPages = lpQuery.data ?? [];
  const selectedVideoItems = useMemo(
    () => videos.filter((v) => selectedVideos.includes(v.id)),
    [videos, selectedVideos],
  );

  /** 创意组：选中视频按每组 N 个平均分配 */
  const groups = useMemo(
    () => splitEvenly(selectedVideoItems, form.groupSize),
    [selectedVideoItems, form.groupSize],
  );

  /* ---------------- 文案列表 ---------------- */

  const [copyModalOpen, setCopyModalOpen] = useState(false);
  const [copyText, setCopyText] = useState('');
  const [copyFromNames, setCopyFromNames] = useState(false);

  const addCopies = () => {
    const incoming = copyText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (s.length > 30 ? s.slice(0, 30) : s));
    const fromNames = copyFromNames
      ? selectedVideoItems
          .map((v) => (v.name || '').trim().slice(0, 30))
          .filter(Boolean)
      : [];
    const merged = [...form.titlesList];
    for (const t of [...incoming, ...fromNames]) {
      if (!merged.includes(t)) merged.push(t);
    }
    if (merged.length > 0) patch({ titlesList: merged });
    if (incoming.length > 0) pushHistory('plan.copies', copyText);
    setCopyText('');
    setCopyFromNames(false);
    setCopyModalOpen(false);
  };

  const shuffleCopies = () => {
    const arr = [...form.titlesList];
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    patch({ titlesList: arr });
  };

  /* ---------------- 创意标签 ---------------- */

  const addTags = (raw: string) => {
    const incoming = raw
      .split(/[\s,，]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (incoming.length === 0) return;
    pushHistory('plan.creativeTags', incoming.join(' '));
    setForm((f) => {
      const merged = [...f.creativeTags];
      for (const t of incoming) {
        if (t.length > 10) continue;
        if (merged.includes(t)) continue;
        if (merged.length >= 10) break;
        merged.push(t);
      }
      return { ...f, creativeTags: merged };
    });
    setTagInput('');
  };

  const quoteLastTags = () => {
    try {
      const raw = localStorage.getItem(LAST_TAGS_KEY);
      if (raw) addTags(raw);
    } catch {
      /* localStorage 不可用时静默跳过 */
    }
  };

  /* ---------------- 校验 ---------------- */

  const sceneValid = form.sceneMode === 1 || form.sceneIds.length > 0;
  /** 搜索广告：定向仅支持 地域 / 操作系统 / 过滤已转化 / 排除人群包 4 个维度（官方） */
  const isSearchAd = form.adType === 1;
  const maxConvert = form.bidStrategy === 1;
  const isOcpx = !maxConvert && form.bidType === 10;
  const useBidRange = isOcpx && form.bidMode !== 'fixed';
  /** 最大转化必须设计划预算（官方：预算不限不支持最大转化）——mobgi 式禁用交互 */
  const maxConvertBlocked = form.budgetMode === 'unlimited';

  const bidMissing = maxConvert
    ? form.campaignDayBudgetYuan == null
    : form.bidType === 2
      ? form.bidYuan == null
      : form.bidMode === 'fixed'
        ? form.cpaBidYuan == null
        : form.bidMinYuan == null ||
          form.bidMaxYuan == null ||
          form.bidMinYuan <= 0 ||
          form.bidMaxYuan < form.bidMinYuan;
  const ocpxMissing = isOcpx && form.ocpxActionType == null;
  const needRoiRatio = isOcpx && form.ocpxActionType != null && OCPX_ROI_TYPES.has(form.ocpxActionType);
  const roiMissing = needRoiRatio && (form.roiRatio == null || form.roiRatio <= 0);
  const deepBidMissing =
    form.deepEnabled && (form.deepConversionBidYuan == null || form.deepConversionBidYuan <= 0);

  const ready =
    selectedVideos.length > 0 &&
    accounts.length > 0 &&
    sceneValid &&
    !bidMissing &&
    !ocpxMissing &&
    !roiMissing &&
    !deepBidMissing;

  /* ---------------- 生成（预览时实体化出价） ---------------- */

  /**
   * 出价生成策略：返回每条链路（创意组）各自的目标出价。
   * 阶梯 = min→max 等差分布（mobgi 实测：29 组 12~14 元，步长 ≈0.071）；
   * 随机 = 区间内均匀随机，保留三位小数。
   */
  const computeBids = (count: number): Array<number | null> => {
    if (count === 0) return [];
    if (maxConvert) return Array(count).fill(null);
    if (form.bidType === 2) return Array(count).fill(form.bidYuan);
    if (form.bidMode === 'fixed') return Array(count).fill(form.cpaBidYuan);
    const min = form.bidMinYuan ?? 0;
    const max = form.bidMaxYuan ?? 0;
    if (count === 1) return [round3(min)];
    if (form.bidMode === 'ladder') {
      return Array.from({ length: count }, (_, i) => round3(min + (i * (max - min)) / (count - 1)));
    }
    return Array.from({ length: count }, () => round3(min + Math.random() * (max - min)));
  };

  /**
   * 单个账户的全部链路行。items 已解析为「该账户素材库内的条目」，
   * rowNo 从 rowNoStart 起连续编号（多账户时全局连续，方便错误定位跳转）。
   */
  const buildRowsForAccount = (
    account: AccountSummary,
    items: AssetItem[],
    rowNoStart: number,
  ): PlanRow[] => {
    const advertiserId = account.advertiserId;
    const accGroups = splitEvenly(items, form.groupSize);
    const base = defaultRow(campaignType, advertiserId, 0);
    // 素材切分装填：素材先按「每组 N 个视频」切成组（组间数量差 ≤1），
    // 再把组依次装进计划（每计划最多 unitsPerCampaign 个组），素材不重复。
    // 例：30 个素材、每组 8 个 → 4 个组；每计划 5 个组 → 1 条计划装 4 个组。
    const unitsPer = Math.min(Math.max(Math.trunc(form.unitsPerCampaign || 1), 1), 50);
    const campaigns: (typeof accGroups)[] = [];
    for (let i = 0; i < accGroups.length; i += unitsPer) {
      campaigns.push(accGroups.slice(i, i + unitsPer));
    }
    // 出价分配规则：按账户分配时，该账户用自己填写的固定出价（随机/阶梯仍走全局区间）
    const perAccountBid =
      form.bidAssign === 'perAccount' ? (form.accountBids[advertiserId] ?? null) : null;
    const bids = computeBids(campaigns.length).map((b) =>
      form.bidAssign === 'perAccount' && form.bidMode === 'fixed' && !maxConvert && form.bidType === 10
        ? perAccountBid
        : b,
    );

    // 命名规则：全自动投放用独立模板（通配符 [序号]/[日期]/[时间]/[账户ID]/[账户备注]/[应用名称]），
    // 常规投放沿用「前缀_序号」。空模板回落到前缀。
    // 分账户命名配置时各账户用各自前缀；序号每账户独立从起始值计。
    const namePrefixForAccount =
      form.nameMode === 'perAccount'
        ? (form.accountNamePrefixes[advertiserId] ?? form.namePrefix)
        : form.namePrefix;
    const applyTpl = (tpl: string, seq: number) =>
      (tpl.trim() || `${namePrefixForAccount}-[序号]`)
        .replaceAll('[序号]', String(seq))
        .replaceAll('[日期]', form.beginTime || today())
        .replaceAll('[时间]', new Date().toTimeString().slice(0, 5).replace(':', ''))
        .replaceAll('[账户ID]', advertiserId)
        .replaceAll('[账户备注]', account.accountName ?? advertiserId)
        .replaceAll(
          '[应用名称]',
          ((account as (typeof account & { appName?: string }) | undefined)?.appName ?? ''),
        )
        .slice(0, 100);
    const unitTpl = form.putMode === 'auto' ? form.unitNameTpl : `${namePrefixForAccount}_[序号]`;
    // 创意名独立于组名：两种投放模式都用创意命名模板（可自定义），不再沿用组名；
    // 勾选「创意名与素材名一致」时服务端直接取视频名。
    const creativeTpl = form.creativeNameTpl;

    return campaigns.map((unitGroups, ci) => {
      // 组内文案按「本账户视频全局序号」轮转，保证相邻链路衔接、不重复起头
      let globalVideoIndex = 0;
      for (let c = 0; c < ci; c += 1) {
        for (const g of campaigns[c]) globalVideoIndex += g.length;
      }

      const unitCount = unitGroups.length;
      const padUnit = (n: number) => String(n).padStart(2, '0');
      const baseUnitName = applyTpl(unitTpl, form.unitSeqStart + ci);
      const descOf = (vi: number) =>
        form.titlesList.length > 0
          ? form.titlesList[(globalVideoIndex + vi) % form.titlesList.length]
          : null;

      const row: PlanRow = {
        ...base,
        rowNo: rowNoStart + ci + 1,
        advertiserId,
        campaignName: baseUnitName,
        unitName: baseUnitName,
        // 每计划最多装的组数（素材切分装填，供校验/统计参考）
        unitsPerCampaign: unitsPer,
        creativeName: applyTpl(creativeTpl, form.creativeSeqStart + ci),
        creativeNameSameAsMaterial: form.creativeNameSameAsMaterial,
        // 计划层
        adType: form.adType,
        campaignBidType: form.bidStrategy,
        autoManage: form.putMode === 'auto' ? 1 : 0,
        // 周期稳投（全自动 + 白名单，仅展示广告有——创量实测搜索广告无此区块）：
        // 真实下发 periodic_delivery_type 族字段
        periodicDeliveryType:
          form.putMode === 'auto' && form.cycleStable && form.adType === 0 ? 1 : null,
        periodicDays:
          form.putMode === 'auto' && form.cycleStable && form.adType === 0
            ? form.stableDays
            : null,
        continuePeriodType:
          form.putMode === 'auto' && form.cycleStable && form.adType === 0
            ? form.stableRenew
              ? 2
              : 1
            : null,
        rangeBudgetYuan:
          form.putMode === 'auto' && form.cycleStable && form.adType === 0
            ? form.cycleBudgetYuan
            : null,
        campaignDayBudgetYuan:
          form.budgetMode === 'unified' ? form.campaignDayBudgetYuan : null,
        // 组层：最大转化 = MCB（bid_type=12），平台智能出价，不传出价
        bidType: maxConvert ? 12 : form.bidType,
        bidYuan: !maxConvert && form.bidType === 2 ? form.bidYuan : null,
        cpaBidYuan: !maxConvert && form.bidType === 10 ? (bids[ci] ?? null) : null,
        ocpxActionType: isOcpx ? form.ocpxActionType : null,
        roiRatio: needRoiRatio ? form.roiRatio : null,
        deepConversionType: form.deepEnabled ? form.deepConversionType : null,
        deepConversionBidYuan: form.deepEnabled ? form.deepConversionBidYuan : null,
        // 搜索广告版位固定 scene_id=39；信息流按智能优选/手动选择
        sceneIds: form.adType === 1 ? [39] : form.sceneMode === 1 ? [1] : [...form.sceneIds],
        showMode: form.showMode,
        beginTime: form.beginTime,
        endTime: form.scheduleMode === 'custom' && form.endTime ? form.endTime : null,
        scheduleTime: form.timeMode === 'custom' ? boolToSeries(form.timeSeries) : null,
        unitDayBudgetYuan: form.unitDayBudgetYuan,
        gender: form.gender,
        platformOs: form.platformOs,
        network: form.network,
        // 定向抽屉完整参数（地域/年龄/设备/智能定向/人群包等）
        targeting: buildTargetingPayload(),
        // ——— 搜索相关（组层字段，对齐创量实测结构）———
        // 搜索快投：展示广告（信息流）组层开关，quick_search=1
        searchQuick: form.adType === 0 && form.searchQuick ? 1 : null,
        // 智能扩词：搜索广告按用户开关；搜索快投场景平台强制要求开启（否则 401000
        // 「搜索快投必须开启智能扩词」），这里与后端 mapper 保持同一口径
        searchExtend:
          (form.adType === 1 && form.searchExtend) || (form.adType === 0 && form.searchQuick)
            ? 1
            : null,
        // 搜索广告：人群追投 / 否词
        searchExplore: form.adType === 1 && form.searchExplore ? 1 : null,
        searchKeywords: null,
        searchNegPhrase: form.adType === 1 ? parseLines(form.searchNegPhraseText) : null,
        searchNegExact: form.adType === 1 ? parseLines(form.searchNegExactText) : null,
        materialType: 1,
        photoId: unitGroups[0]?.[0]?.id ?? null,
        // 素材切分装填：计划下各组的视频分配（每组视频不重复，服务端按此展开）
        units: unitGroups.map((g, ui) => ({
          unitName:
            unitCount > 1 ? `${baseUnitName.slice(0, 116)}-${padUnit(ui + 1)}` : baseUnitName,
          videos: g.map((v, vi) => ({
            photoId: v.id,
            name: v.name ?? null,
            description: descOf(vi),
          })),
        })),
        // 兼容旧消费方（校验/统计兜底）：首组的视频列表
        creativeVideos: unitGroups[0].map((v, vi) => ({
          photoId: v.id,
          name: v.name ?? null,
          description: descOf(vi),
        })),
        actionBarText: form.actionBarText,
        description: form.titlesList.length > 0 ? form.titlesList[globalVideoIndex % form.titlesList.length] : null,
        creativeTags: form.creativeTags.length > 0 ? [...form.creativeTags] : null,
        creativeCategory: form.creativeCategory || null,
        // 真实下发字段（官方创建创意接口）：
        recommendation:
          form.plcMode === 'unified' && form.plcText.trim()
            ? form.plcText.trim().slice(0, 13)
            : null,
        // 原生广告：只有选定了快手号才能满足官方 kol_user_id 必填校验
        outerLoopNative: form.nativeAd && form.nativeKwaiUserId ? 1 : 0,
        kolUserType: form.nativeAd ? nativeKolType : null,
        kolUserId: form.nativeAd ? form.nativeKwaiUserId : null,
        // 推荐理由 → new_expose_tag（官方最多 2 个）
        newExposeTags:
          form.recommendReasons.length > 0
            ? form.recommendReasons.slice(0, 2).map((text) => ({ text }))
            : null,
      };
      if (isAppGoal) {
        row.appId = form.appId;
        row.packageId = form.packageId;
        row.appDownloadType = form.downloadMode;
        row.useAppMarket = form.useAppMarket ? 1 : 0;
        row.appStores = form.useAppMarket ? [...form.appStores] : null;
        // 落地页下载需要下载中间页（site_id，建站资产）
        if (form.downloadMode === 1) row.siteId = form.downloadSiteId;
      }
      if (campaignType === 5) {
        row.webUriType = form.webUriType;
        row.url = form.webUriType === 1 ? form.url || null : null;
        row.siteId = form.webUriType === 2 ? form.siteId : null;
      }
      // 第三方监测链接（创意层）：有值才下发
      row.clickMonitorUrl = form.clickMonitorUrl.trim() || null;
      row.impressionMonitorUrl = form.impressionMonitorUrl.trim() || null;
      return row;
    });
  };

  /** 多账户素材解析结果 */
  interface AccountMaterials {
    account: AccountSummary;
    /** 该账户实际使用的素材（条目 ID 属于该账户素材库） */
    items: AssetItem[];
    /** 按素材名在该账户库内匹配到的数量 */
    matched: number;
    /** 未匹配、沿用素材账户原 ID 的数量 */
    fallback: number;
    /** 该账户素材库拉取失败（全部沿用原 ID） */
    libFailed: boolean;
  }

  /**
   * 把所选素材映射到每个目标账户。
   *
   * photo_id 是账户级资产，其他账户不能直接使用素材账户的素材 ID；
   * 矩阵投放的惯例是同一批素材文件上传到各账户（同名），
   * 因此按素材名在各账户素材库里找对应 ID；找不到则沿用原 ID
   * （素材库实际共享的账户仍可创建，其余会在该条创建时报错，不影响其他账户）。
   */
  const resolveMaterials = async (): Promise<AccountMaterials[]> => {
    if (accounts.length <= 1) {
      return [
        {
          account: accounts[0],
          items: selectedVideoItems,
          matched: selectedVideoItems.length,
          fallback: 0,
          libFailed: false,
        },
      ];
    }
    // 并发拉各账户素材库（每批 4 个；服务端 10 分钟缓存，重复生成很快）
    const libs: (AssetItem[] | null)[] = new Array(accounts.length).fill(null);
    for (let i = 0; i < accounts.length; i += 4) {
      const chunk = accounts.slice(i, i + 4);
      const part = await Promise.all(
        chunk.map((acc) =>
          api
            .get<AssetItem[]>(`/api/plan/assets/videos?advertiserId=${acc.advertiserId}`)
            .catch(() => null),
        ),
      );
      part.forEach((lib, j) => {
        libs[i + j] = lib;
      });
    }
    // 分配目标：全账户使用 = 每账户全量素材；平均分配 = 素材均分成 N 份（账户间不重复）
    const chunks =
      form.assignRule === 'all'
        ? accounts.map(() => selectedVideoItems)
        : splitAcross(selectedVideoItems, accounts.length);
    return accounts.map((account, idx) => {
      const src = chunks[idx] ?? [];
      // 素材账户本身用精确选中的条目，无需名称匹配
      if (account.advertiserId === form.advertiserId) {
        return { account, items: src, matched: src.length, fallback: 0, libFailed: false };
      }
      const lib = libs[idx];
      if (!lib) {
        return { account, items: src, matched: 0, fallback: src.length, libFailed: true };
      }
      const byName = new Map<string, AssetItem>();
      for (const v of lib) {
        const k = (v.name || '').trim();
        if (k && !byName.has(k)) byName.set(k, v);
      }
      let matched = 0;
      const items = src.map((s) => {
        const hit = byName.get((s.name || '').trim());
        if (hit) {
          matched += 1;
          return hit;
        }
        return s;
      });
      return { account, items, matched, fallback: src.length - matched, libFailed: false };
    });
  };

  /** 全部账户的链路行（rowNo 全局连续；分不到素材的账户跳过） */
  const buildRows = (mats: AccountMaterials[]): PlanRow[] => {
    const rows: PlanRow[] = [];
    let rowNo = 0;
    for (const m of mats) {
      if (m.items.length === 0) continue;
      const accRows = buildRowsForAccount(m.account, m.items, rowNo);
      rows.push(...accRows);
      rowNo += accRows.length;
    }
    return rows;
  };

  /** 生成量预估（底部条与预览按钮展示；多账户时按素材名匹配结果可能略有出入，实际以预览为准） */
  const planEstimate = useMemo(() => {
    const unitsPer = Math.max(form.unitsPerCampaign || 1, 1);
    if (selectedVideoItems.length === 0 || accounts.length === 0) {
      return { plans: 0, groups: 0 };
    }
    const chunks =
      accounts.length === 1 || form.assignRule === 'all'
        ? accounts.map(() => selectedVideoItems)
        : splitAcross(selectedVideoItems, accounts.length);
    let groups = 0;
    let plans = 0;
    for (const c of chunks) {
      if (c.length === 0) continue;
      const g = splitEvenly(c, form.groupSize).length;
      groups += g;
      plans += Math.ceil(g / unitsPer);
    }
    return { plans, groups };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, selectedVideoItems, form.groupSize, form.unitsPerCampaign, form.assignRule]);

  /* ---------------- 预览（三层树表） ---------------- */

  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewRows, setPreviewRows] = useState<PlanRow[]>([]);
  /** 多账户生成时需要拉各账户素材库做名称匹配，过程不能秒回 */
  const [preparing, setPreparing] = useState(false);

  const openPreview = async () => {
    if (!ready || preparing) return;
    setPreparing(true);
    try {
      const mats = await resolveMaterials();
      const usable = mats.filter((m) => m.items.length > 0);
      if (usable.length === 0) {
        message.warning('没有账户分到素材，无法生成');
        return;
      }
      const skipped = mats.length - usable.length;
      if (skipped > 0) {
        message.info(`${skipped} 个账户因素材数量不足未分到素材，已跳过`);
      }
      const fallbackAccounts = usable.filter((m) => m.fallback > 0);
      if (fallbackAccounts.length > 0) {
        message.warning(
          `${fallbackAccounts.length} 个账户有素材未按名称匹配到本账户素材库` +
            `${fallbackAccounts.some((m) => m.libFailed) ? '（部分账户素材库拉取失败）' : ''}` +
            '，这些素材将沿用素材账户的素材 ID 创建',
          6,
        );
      }
      if (form.nativeAd && accounts.length > 1) {
        message.info('原生广告的快手号取自素材账户，其他账户需平台同样授权该快手号', 5);
      }
      setPreviewRows(buildRows(usable));
      setPreviewOpen(true);
    } finally {
      setPreparing(false);
    }
  };

  const confirmGenerate = () => {
    setPreviewOpen(false);
    // 记住这次用过的标签，下次「引用上次内容」
    try {
      if (form.creativeTags.length > 0) {
        localStorage.setItem(LAST_TAGS_KEY, form.creativeTags.join(' '));
      }
    } catch {
      /* ignore */
    }
    onGenerate(previewRows);
  };

  /* ---------------- 摘要文案 ---------------- */

  const bidTypeLabel = maxConvert
    ? '最大转化（平台智能出价）'
    : form.bidType === 2
      ? 'CPC（按点击）'
      : 'oCPM（按展示付费）';

  const bidValueText = maxConvert
    ? '—'
    : form.bidType === 2
      ? form.bidYuan != null
        ? `${form.bidYuan} 元`
        : '未填'
      : form.bidMode === 'fixed'
        ? form.cpaBidYuan != null
          ? `统一出价 ${form.cpaBidYuan} 元`
          : '未填'
        : `${form.bidMode === 'ladder' ? '阶梯' : '随机'} ${form.bidMinYuan ?? '?'} ~ ${form.bidMaxYuan ?? '?'} 元`;

  const sceneText =
    form.sceneMode === 1
      ? '智能优选'
      : form.sceneIds.map((k) => SCENE_ID_META[k]?.label ?? k).join('、') || '未选择';

  const platformText =
    form.platformOs === 0 ? '不限' : form.platformOs === 1 ? 'Android' : 'iOS';

  const budgetText =
    form.budgetMode === 'unlimited'
      ? '不限'
      : `计划 ${form.campaignDayBudgetYuan ?? '?'} 元${form.unitDayBudgetYuan ? ` / 组 ${form.unitDayBudgetYuan} 元` : ''}`;

  const scheduleText =
    form.scheduleMode === 'long'
      ? `长期投放（${form.beginTime} 起）`
      : `${form.beginTime} ~ ${form.endTime || '?'}`;

  const timeText =
    form.timeMode === 'all'
      ? '全天'
      : `特定时间（${form.timeSeries.filter(Boolean).length}/168 小时）`;

  const ocpxLabel = isOcpx && form.ocpxActionType
    ? OCPX_ACTION_TYPE_META[form.ocpxActionType]?.label ?? form.ocpxActionType
    : null;

  const deepLabel = form.deepEnabled && form.deepConversionType
    ? `${DEEP_CONVERSION_META[form.deepConversionType]?.label ?? form.deepConversionType} · ${form.deepConversionBidYuan ?? '?'} 元`
    : null;

  const ocpxValid = isOcpx && form.ocpxActionType != null && OCPX_ROI_TYPES.has(form.ocpxActionType);

  /* ================= 渲染 ================= */

  return (
    <div>
      {/* 顶部：账户 + 营销目标上下文。
          投放账户以页面顶部「投放账户」多选为准（选了几个就在几个账户上批量建计划），
          这里只保留「素材账户」选择——素材库是账户级资产，必须指定从哪个账户的视频库挑素材。 */}
      <Card size="small" style={{ borderRadius: 10, marginBottom: 12 }}>
        <Space size={16} wrap align="center">
          <Space size={8}>
            <Typography.Text style={{ fontSize: 13, color: '#888780' }}>投放账户</Typography.Text>
            <Tag color="orange" style={{ marginInlineEnd: 0 }}>
              {accounts.length} 个
            </Tag>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {accounts.length > 1
                ? '同一套配置将在每个账户各建一批计划'
                : '在页面顶部「投放账户」中增减'}
            </Typography.Text>
          </Space>
          <Space size={8}>
            <Typography.Text style={{ fontSize: 13, color: '#888780' }}>素材账户</Typography.Text>
            <Select
              style={{ minWidth: 200 }}
              placeholder="选素材库账户"
              value={form.advertiserId || undefined}
              onChange={(v) => {
                patch({ advertiserId: v, nativeKwaiUserId: null });
                setSelectedVideos([]);
              }}
              options={accounts.map((a) => ({
                value: a.advertiserId,
                label: a.accountName ?? a.advertiserId,
              }))}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              从该账户视频库挑素材；多账户生成时按素材名匹配各账户库内素材
            </Typography.Text>
          </Space>
          <Space size={8}>
            <Typography.Text style={{ fontSize: 13, color: '#888780' }}>营销目标</Typography.Text>
            <Tag color="orange" style={{ marginInlineEnd: 0 }}>
              {CAMPAIGN_TYPE[campaignType]}
            </Tag>
          </Space>
          {CAMPAIGN_TYPE_META[campaignType]?.note && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {CAMPAIGN_TYPE_META[campaignType].note}
            </Typography.Text>
          )}
        </Space>
      </Card>

      {/* ——— 摘要卡（两列栅格：参考创量单屏布局） ——— */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: 12,
          alignItems: 'start',
        }}
      >
      {/* ——— 摘要卡：广告组基本信息 ——— */}
      <SummaryCard title="广告组基本信息" onEdit={() => openDrawer('group')}>
        <SumItem
          k="广告类型"
          v={
            form.adType === 0
              ? form.searchQuick
                ? '展示广告 · 搜索快投（含智能扩词）'
                : '展示广告'
              : '搜索广告'
          }
        />
        {isSearchAd && (
          <SumItem
            k="搜索设置"
            v={[
              form.searchExtend ? '扩词开' : '扩词关',
              form.searchExplore ? '人群追投开' : null,
              parseLines(form.searchNegPhraseText).length + parseLines(form.searchNegExactText).length >
                0
                ? `${
                    parseLines(form.searchNegPhraseText).length +
                    parseLines(form.searchNegExactText).length
                  } 个否词`
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          />
        )}
        <SumItem k="投放方式" v={form.putMode === 'normal' ? '常规投放' : '全自动投放'} />
        <SumItem k="投放位置" v={sceneText} />
        <SumItem k="竞价策略" v={bidTypeLabel} />
        <SumItem k="优化目标" v={ocpxLabel ?? (maxConvert ? '转化数（平台智能）' : '未选择')} />
        {ocpxValid && <SumItem k="ROI 系数" v={String(form.roiRatio ?? '未填')} />}
        <SumItem k="深度转化" v={deepLabel ?? '不开启'} />
        <SumItem k="投放平台" v={platformText} />
        {isAppGoal && <SumItem k="下载方式" v={form.downloadMode === 0 ? '直接下载' : '落地页下载'} />}
        {isAppGoal && (
          <SumItem
            k="应用商店"
            v={form.useAppMarket ? `优先商店下载（${form.appStores.length} 个）` : '不开启'}
          />
        )}
        <SumItem k="每日预算" v={budgetText} />
        <SumItem k="排期" v={scheduleText} />
        <SumItem k="投放时段" v={timeText} />
        <SumItem
          k="创意展现"
          v={form.showMode === 2 ? '智能优选' : '随机轮播'}
        />
        {form.putMode === 'auto' && form.adType === 0 && (
          <SumItem
            k="周期稳投"
            v={
              form.cycleStable
                ? `开启（${form.stableDays}天${form.stableRenew ? '·续投' : ''}${form.cycleBudgetYuan != null ? `·总预算${form.cycleBudgetYuan}元` : ''}）`
                : '关闭'
            }
          />
        )}
        <SumItem
          k="出价分配"
          v={form.bidAssign === 'same' ? '全部相同' : '按账户分配'}
        />
        <SumItem
          k={form.putMode === 'auto' ? '广告组命名规则' : '广告组名称'}
          v={
            form.putMode === 'auto'
              ? form.unitNameTpl || '（空，按前缀兜底）'
              : form.nameMode === 'perAccount'
                ? `分账户配置（当前账户：${form.accountNamePrefixes[form.advertiserId] || form.namePrefix || '前缀'}）`
                : `${form.namePrefix}_01、_02…`
          }
        />
      </SummaryCard>

      {/* ——— 摘要卡：定向 ——— */}
      <SummaryCard title="定向" onEdit={() => openDrawer('target')}>
        <SumItem
          k="性别/年龄"
          v={`${form.gender === 0 ? '不限' : form.gender === 1 ? '女' : '男'} · ${
            form.targeting.agesRange.length > 0
              ? form.targeting.agesRange
                  .map((a) => AGE_OPTIONS.find((o) => o.value === a)?.label ?? a)
                  .join('/')
              : '年龄不限'
          }`}
        />
        <SumItem
          k="地域"
          v={
            form.targeting.regionIds.length > 0
              ? `${form.targeting.regionIds.length} 个地区`
              : '不限'
          }
        />
        <SumItem
          k="设备/系统"
          v={[
            form.platformOs === 0 ? null : form.platformOs === 1 ? 'Android' : 'iOS',
            form.targeting.deviceBrands.length > 0 ? `${form.targeting.deviceBrands.length} 个品牌` : null,
            form.targeting.devicePrices.length > 0 ? `${form.targeting.devicePrices.length} 个价位` : null,
          ]
            .filter(Boolean)
            .join('·') || '不限'}
        />
        <SumItem
          k="智能定向"
          v={
            form.targeting.intelliExtend === 0
              ? '关闭'
              : form.targeting.intelliExtend === 1
                ? '开启'
                : 'Pro'
          }
        />
        {appliedPackageId != null && (
          <SumItem
            k="定向包"
            v={packagesQuery.data?.find((p) => p.id === appliedPackageId)?.name ?? '已删除'}
          />
        )}
        <SumItem
          k="人群包"
          v={
            form.targeting.population.length > 0 || form.targeting.excludePopulation.length > 0
              ? `定向${form.targeting.population.length}个 / 排除${form.targeting.excludePopulation.length}个`
              : '不限'
          }
        />
      </SummaryCard>

      {/* ——— 摘要卡：创意基本信息 ——— */}
      <SummaryCard title="创意基本信息" onEdit={() => openDrawer('creative')}>
        <SumItem k="行动号召" v={form.actionBarText} />
        {form.adType === 0 && (
          <SumItem k="搜索快投" v={form.searchQuick ? '开启（搜索流量）' : '关闭'} />
        )}
        <SumItem
          k="原生广告"
          v={
            form.nativeAd
              ? `开启（${form.nativeAuthType === 1 ? '服务号授权' : form.nativeAuthType === 2 ? '达人视频授权' : '普通快手号'}${nativeKwaiUser ? `·${nativeKwaiUser.userName}` : '·未选快手号'}）`
              : '关闭'
          }
        />
        <SumItem
          k="PLC 描述语"
          v={
            form.plcMode === 'unified'
              ? form.plcText.trim()
                ? form.plcText.trim()
                : '统一配置（未填写）'
              : '手动设置禁用词汇'
          }
        />
        {form.recommendReasons.length > 0 && (
          <SumItem k="推荐理由" v={form.recommendReasons.join('、')} />
        )}
        <SumItem
          k="创意标签"
          v={form.creativeTags.length > 0 ? form.creativeTags.join('、') : '未添加'}
        />
        <SumItem
          k="创意分类"
          v={
            form.creativeCategory != null
              ? categoryNameOf.get(form.creativeCategory) ?? String(form.creativeCategory)
              : '不限'
          }
        />
        <SumItem
          k="创意名称"
          v={
            form.creativeNameSameAsMaterial
              ? '与素材名一致（直接用视频名）'
              : `${form.creativeNameTpl || '（按前缀兜底）'}${'-创01…'}`
          }
        />
      </SummaryCard>

      {/* ——— 摘要卡：转化路径 ——— */}
      <SummaryCard
        title={campaignType === 5 ? '应用和监测（落地页）' : '应用和监测（应用）'}
        onEdit={() => openDrawer('conversion')}
      >
        {campaignType === 5 ? (
          <>
            <SumItem
              k="落地页形态"
              v={form.webUriType === 1 ? '自有链接' : '建站落地页'}
            />
            <SumItem
              k="落地页"
              v={
                form.webUriType === 1
                  ? form.url || '未填写'
                  : lpPages.find((p) => p.id === form.siteId)?.name || form.siteId || '未选择'
              }
            />
          </>
        ) : (
          <>
            <SumItem
              k="推广应用"
              v={apps.find((a) => a.id === form.appId)?.name || form.appId || '未选择'}
            />
            <SumItem k="应用包" v={form.packageId ?? '未填写'} />
          </>
        )}
        <SumItem
          k="监测链接"
          v={
            form.clickMonitorUrl
              ? `点击监测 ${form.clickMonitorUrl.length > 24 ? `${form.clickMonitorUrl.slice(0, 24)}…` : form.clickMonitorUrl}`
              : '未填写'
          }
        />
      </SummaryCard>
      </div>

      {/* ——— 创意素材 + 文案（左右分栏，节省纵向空间） ——— */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: 12,
          alignItems: 'start',
        }}
      >
      <SectionCard
        title="创意素材（竖版视频）"
        extra={
          <Space size={8}>
            {selectedVideos.length > 0 && (
              <Typography.Link
                style={{ fontSize: 12 }}
                onClick={(e) => {
                  e.preventDefault();
                  setSelectedVideos([]);
                }}
              >
                清空
              </Typography.Link>
            )}
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={videosQuery.isFetching}
              onClick={() => refreshAssets('videos')}
              disabled={!form.advertiserId}
            >
              同步素材
            </Button>
            <Button
              size="small"
              type="primary"
              ghost
              icon={<PlusOutlined />}
              onClick={() => setVideoModalOpen(true)}
              disabled={!form.advertiserId}
            >
              选择素材
            </Button>
          </Space>
        }
      >
        {/* 分配规则（mobgi 三卡样式；多账户下才有实际差异） */}
        <FormRow label="分配规则">
          <Space size={10} wrap>
            {(
              [
                {
                  value: 'all',
                  label: '全账户使用',
                  desc:
                    accounts.length > 1
                      ? `每个账户都用全部 ${selectedVideoItems.length} 个素材`
                      : '所有视频一次性用满',
                  hot: false,
                },
                {
                  value: 'even',
                  label: '平均分配',
                  desc:
                    accounts.length > 1
                      ? `素材平均分给 ${accounts.length} 个账户（不重复）`
                      : '按每组数量均分成创意组',
                  hot: true,
                },
              ] as Array<{ value: 'all' | 'even'; label: string; desc: string; hot: boolean }>
            ).map((r) => {
              const checked = form.assignRule === r.value;
              return (
                <Tooltip
                  key={r.value}
                  title={
                    r.value === 'all'
                      ? accounts.length > 1
                        ? '每个账户都用全部所选素材（各账户建相同组数的计划）'
                        : '单账户下与平均分配效果一致'
                      : accounts.length > 1
                        ? '素材按账户数均分，每个账户只投自己分到的素材'
                        : undefined
                  }
                >
                  <div
                    onClick={() => patch({ assignRule: r.value })}
                    style={{
                      position: 'relative',
                      width: 168,
                      padding: '10px 12px',
                      border: `1px solid ${checked ? BRAND : '#E8E6E1'}`,
                      borderRadius: 8,
                      cursor: 'pointer',
                      background: checked ? '#FFF9F5' : '#fff',
                    }}
                  >
                    {r.hot && (
                      <span
                        style={{
                          position: 'absolute',
                          top: -7,
                          right: 8,
                          background: '#FF4D4F',
                          color: '#fff',
                          fontSize: 10,
                          lineHeight: '14px',
                          padding: '0 6px',
                          borderRadius: 3,
                        }}
                      >
                        推荐
                      </span>
                    )}
                    <div style={{ fontSize: 13, color: checked ? BRAND : '#37352F' }}>{r.label}</div>
                    <div style={{ fontSize: 11, color: '#888780', marginTop: 2 }}>{r.desc}</div>
                  </div>
                </Tooltip>
              );
            })}
            <Space size={6}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                每组
              </Typography.Text>
              <InputNumber
                size="small"
                min={1}
                max={15}
                value={form.groupSize}
                onChange={(v) => patch({ groupSize: v ?? 8 })}
                style={{ width: 64 }}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                个视频（单组 ≤ 15）
              </Typography.Text>
              <span style={{ width: 12, display: 'inline-block' }} />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                每计划
              </Typography.Text>
              <InputNumber
                size="small"
                min={1}
                max={20}
                value={form.unitsPerCampaign}
                onChange={(v) => patch({ unitsPerCampaign: v ?? 1 })}
                style={{ width: 64 }}
              />
              <Tooltip title="素材先按「每组 N 个视频」切分成组，再把组依次装进计划，素材不重复。例：30 个素材、每组 8 个 = 4 个组，每计划 5 个组 → 只需 1 条计划（装 4 个组）">
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  个广告组 ⓘ
                </Typography.Text>
              </Tooltip>
            </Space>
          </Space>
        </FormRow>

        {/* 组墙 */}
        {accounts.length === 0 ? (
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            先在页面顶部「投放账户」中选择账户
          </Typography.Text>
        ) : groups.length === 0 ? (
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            还没选素材，点右上角「选择素材」从账户视频库里挑（支持搜索、分页、多选）。
          </Typography.Text>
        ) : (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              已选 {selectedVideoItems.length} 个素材
              {accounts.length > 1
                ? ` · ${form.assignRule === 'all' ? '每个账户使用全部素材' : `素材平均分配到 ${accounts.length} 个账户`}`
                : ''}
              {' → '}{planEstimate.groups} 个组 → {planEstimate.plans} 条计划
              （每组不重复素材，组依次装入计划）
            </Typography.Text>
            {groups.map((group, gi) => (
              <div
                key={gi}
                id={`plan-group-card-${gi + 1}`}
                style={{
                  border: `1px solid ${flashRow === gi + 1 ? BRAND : '#E8E6E1'}`,
                  borderRadius: 8,
                  padding: '8px 10px',
                  background: flashRow === gi + 1 ? '#FFF9F5' : '#fff',
                  boxShadow: flashRow === gi + 1 ? '0 0 0 2px rgba(255,79,0,0.25)' : 'none',
                  transition: 'box-shadow 0.3s, background 0.3s, border-color 0.3s',
                }}
              >
                <Typography.Text style={{ fontSize: 12, color: '#37352F' }}>
                  组 {pad2(gi + 1)}
                  <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 8 }}>
                    {group.length} 个视频 · 装入第 {Math.floor(gi / Math.max(form.unitsPerCampaign || 1, 1)) + 1} 条计划
                  </Typography.Text>
                </Typography.Text>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                  {group.map((v) => (
                    <Tooltip key={v.id} title={`${v.name || v.id}（点击移除）`}>
                      <div
                        onClick={() =>
                          setSelectedVideos((prev) => prev.filter((x) => x !== v.id))
                        }
                        style={{
                          position: 'relative',
                          width: 44,
                          aspectRatio: '3 / 4',
                          borderRadius: 6,
                          overflow: 'hidden',
                          cursor: 'pointer',
                          border: `1.5px solid ${BRAND}`,
                        }}
                      >
                        {v.cover ? (
                          <img
                            src={v.cover}
                            alt={v.name || v.id}
                            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          />
                        ) : (
                          <div
                            style={{
                              width: '100%',
                              height: '100%',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontSize: 10,
                              color: '#888780',
                              background: '#F5F4F0',
                            }}
                          >
                            视频
                          </div>
                        )}
                        <div
                          style={{
                            position: 'absolute',
                            top: 1,
                            right: 1,
                            width: 13,
                            height: 13,
                            borderRadius: '50%',
                            background: 'rgba(0,0,0,0.5)',
                            color: '#fff',
                            fontSize: 9,
                            lineHeight: '13px',
                            textAlign: 'center',
                          }}
                        >
                          ×
                        </div>
                      </div>
                    </Tooltip>
                  ))}
                </div>
              </div>
            ))}
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              素材仅用于广告创意投放，不会上传/推送到快手主页。
            </Typography.Text>
          </Space>
        )}
      </SectionCard>

      {/* ——— 文案 ——— */}
      <SectionCard
        title="文案"
        rowId="fld-description"
        flash={flashField === 'description'}
        extra={
          <Space size={8}>
            {form.titlesList.length > 1 && (
              <Typography.Link
                style={{ fontSize: 12 }}
                onClick={(e) => {
                  e.preventDefault();
                  shuffleCopies();
                }}
              >
                乱序
              </Typography.Link>
            )}
            {form.titlesList.length > 0 && (
              <Typography.Link
                style={{ fontSize: 12 }}
                onClick={(e) => {
                  e.preventDefault();
                  patch({ titlesList: [] });
                }}
              >
                清空
              </Typography.Link>
            )}
            <Button
              size="small"
              type="primary"
              ghost
              icon={<PlusOutlined />}
              onClick={() => setCopyModalOpen(true)}
            >
              添加文案
            </Button>
          </Space>
        }
      >
        {/* 文案包：选择即套用；支持保存修改 / 另存为（对齐定向包） */}
        <FormRow
          label="文案包"
          tip="选包即整体套用；改过文案后可「保存」覆盖当前包，或「另存为」新包"
        >
          <Space size={8} wrap>
            <Select
              style={{ width: 240 }}
              placeholder="选择文案包"
              value={appliedCopyId ?? undefined}
              onChange={(v) => applyCopyPackage(v ?? null)}
              options={(copyPackagesQuery.data ?? []).map((p) => ({
                value: p.id,
                label: `${p.name}（${p.titles.length} 条）`,
              }))}
              allowClear
              loading={copyPackagesQuery.isFetching}
            />
            {appliedCopyId != null ? (
              <>
                <Button
                  size="small"
                  loading={updateCopyMutation.isPending}
                  onClick={() => {
                    const pkg = copyPackagesQuery.data?.find((p) => p.id === appliedCopyId);
                    if (!pkg) return;
                    if (form.titlesList.length === 0) {
                      message.warning('当前没有文案，先添加再保存');
                      return;
                    }
                    updateCopyMutation.mutate({ id: pkg.id, name: pkg.name, titles: [...form.titlesList] });
                  }}
                >
                  保存当前模板
                </Button>
                <Button size="small" onClick={saveCopyAs}>另存为</Button>
                <Button size="small" danger onClick={() => removeCopyMutation.mutate(appliedCopyId)}>
                  删除此包
                </Button>
              </>
            ) : (
              <Button size="small" onClick={saveCopyAs}>保存为文案包</Button>
            )}
          </Space>
        </FormRow>
        {form.titlesList.length === 0 ? (
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            未添加文案。可手动输入多条，或直接使用素材名作为文案；投放时按视频顺序轮转分配。
          </Typography.Text>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {form.titlesList.map((t, i) => (
              <Tag
                key={`${t}-${i}`}
                closable
                closeIcon={<CloseOutlined style={{ fontSize: 10 }} />}
                onClose={() =>
                  patch({ titlesList: form.titlesList.filter((_, idx) => idx !== i) })
                }
                style={{ fontSize: 12, maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis' }}
              >
                {i + 1}. {t}
              </Tag>
            ))}
            <Typography.Text type="secondary" style={{ fontSize: 12, alignSelf: 'center' }}>
              共 {form.titlesList.length} 条 → 按视频顺序轮转
            </Typography.Text>
          </div>
        )}
      </SectionCard>
      </div>

      {/* ——— 底部：预览 + 生成 ——— */}
      <Card
        size="small"
        style={{
          borderRadius: 10,
          marginTop: 12,
          borderColor: '#FFD9C2',
          background: '#FFF9F5',
        }}
        styles={{ body: { padding: '10px 16px' } }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <Typography.Text style={{ fontSize: 13 }}>
            已选 <b>{selectedVideos.length}</b> 个素材 · <b>{accounts.length}</b> 个账户
            {accounts.length > 1 && (
              <span style={{ color: '#888780' }}>
                （{form.assignRule === 'all' ? '每账户全量素材' : '素材平均分配'}）
              </span>
            )}
            {' → '}预计 <b>{planEstimate.plans}</b> 条计划 / <b>{planEstimate.groups}</b> 个广告组
            {form.titlesList.length > 0 && (
              <span style={{ color: '#888780' }}>（文案按 {form.titlesList.length} 条轮转）</span>
            )}
          </Typography.Text>
          {hasRows > 0 && (
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              生成会覆盖当前已有的 {hasRows} 行
            </Typography.Text>
          )}
          <div style={{ flex: 1 }} />
          <Button
            type="primary"
            icon={<ThunderboltOutlined />}
            disabled={!ready}
            loading={preparing}
            onClick={() => void openPreview()}
          >
            {preparing
              ? '正在解析各账户素材…'
              : ready
                ? `预览 ${planEstimate.plans} 条计划`
                : bidMissing
                  ? maxConvert
                    ? '先填计划预算'
                    : '先填出价'
                  : ocpxMissing
                    ? '选优化目标'
                    : roiMissing
                      ? '填 ROI 系数'
                      : deepBidMissing
                        ? '填深度出价'
                        : accounts.length === 0
                          ? '先选投放账户'
                          : '先选素材'}
          </Button>
        </div>
      </Card>

      {/* ================= 编辑抽屉：广告组基本信息 ================= */}
      <Drawer
        title="广告组基本信息"
        placement="right"
        width={640}
        open={drawer === 'group'}
        onClose={closeDrawer}
        footer={
          <div style={{ textAlign: 'right' }}>
            <Button type="primary" onClick={closeDrawer}>
              完成
            </Button>
          </div>
        }
      >
        <FormRow
          label="广告类型"
          tip="搜索广告：广告主在快手搜索时按关键词触达，支持 2 应用安装 / 5 销售线索 / 7 应用活跃 / 35 电商下单"
        >
          <ChipGroup
            value={form.adType}
            onChange={(v) => {
              const next = v as number;
              if (next === 1) {
                // 搜索广告只支持 4 个定向维度（地域/OS/过滤已转化/排除人群包），
                // 其余清零防止残留值直入请求体；版位固定搜索广告。
                patch({
                  adType: 1,
                  sceneMode: 2,
                  sceneIds: [39],
                  targeting: {
                    ...form.targeting,
                    agesRange: [],
                    userType: 2,
                    deviceBrands: [],
                    devicePrices: [],
                    intelliExtend: 0,
                    behaviorType: 0,
                    disableInstalledApp: 0,
                    population: [],
                  },
                });
              } else {
                patch({
                  adType: 0,
                  // 从搜索切回信息流时，把搜索版位还原成默认优选
                  ...(form.sceneIds[0] === 39 ? { sceneMode: 1, sceneIds: [1] } : {}),
                });
              }
            }}
            options={[
              { value: 0, label: '展示广告' },
              { value: 1, label: '搜索广告' },
            ]}
          />
        </FormRow>

        <FormRow label="投放方式">
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            <ChipGroup
              value={form.putMode}
              onChange={(v) => {
                if (v === 'auto') {
                  // 对齐 mobgi：全自动投放由系统接管预算，统一预算不可用
                  patch({ putMode: 'auto', budgetMode: 'unlimited' });
                } else {
                  patch({ putMode: 'normal' });
                }
              }}
              options={[
                { value: 'normal', label: '常规投放' },
                { value: 'auto', label: '全自动投放', tip: 'auto_manage（UAX），白名单功能，需账户已开通' },
              ]}
            />
            {form.putMode === 'auto' && (
              <Typography.Text type="warning" style={{ fontSize: 12 }}>
                平台投放模式升级中，常规投放模式将逐步下线；全自动投放由系统全面接管优化，助力跑量。
              </Typography.Text>
            )}
          </Space>
        </FormRow>

        {form.putMode === 'auto' && (
          <>
            {/* 周期稳投仅展示广告有：创量实测搜索广告（含全自动投放态）无此区块 */}
            {form.adType === 0 && (
              <>
                <FormRow label="周期稳投" tip="计划级 periodic_delivery_type，白名单特性，开启后真实下发；搜索广告不支持">
                  <ChipGroup
                    value={form.cycleStable ? 'on' : 'off'}
                    onChange={(v) => patch({ cycleStable: v === 'on' })}
                    options={[
                      { value: 'off', label: '关闭' },
                      { value: 'on', label: '开启', tip: '需账户已开通周期稳投白名单' },
                    ]}
                  />
                </FormRow>

                {form.cycleStable && (
                  <>
                    <FormRow label="投放周期" tip="periodic_days：官方默认 7 天，加白后支持 5 天；周期内系统分日稳投">
                      <ChipGroup
                        value={form.stableDays}
                        onChange={(v) => patch({ stableDays: v as number })}
                        options={[
                          { value: 7, label: '7天（默认）' },
                          { value: 5, label: '5天', tip: '需账户加白' },
                        ]}
                      />
                    </FormRow>

                    <FormRow label="续投" tip="continue_period_type：周期结束后自动续投下一个周期">
                      <ChipGroup
                        value={form.stableRenew ? 'on' : 'off'}
                        onChange={(v) => patch({ stableRenew: v === 'on' })}
                        options={[
                          { value: 'off', label: '关闭' },
                          { value: 'on', label: '开启' },
                        ]}
                      />
                    </FormRow>
                  </>
                )}
              </>
            )}

            <FormRow
              label="广告组命名规则"
              tip="通配符：[序号] [日期] [时间] [账户ID] [账户备注] [应用名称]"
              rowId="fld-unitName"
              flash={flashField === 'unitName' || flashField === 'campaignName'}
            >
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                <Space size={6} style={{ width: '100%' }}>
                  <Input
                    style={{ width: 380 }}
                    value={form.unitNameTpl}
                    onChange={(e) => patch({ unitNameTpl: e.target.value })}
                    onBlur={() => pushHistory('plan.unitNameTpl', form.unitNameTpl)}
                    placeholder="系统自动命名，如：批量_[日期]_[序号]"
                    maxLength={100}
                    suffix={<Typography.Text type="secondary" style={{ fontSize: 12 }}>{`${form.unitNameTpl.length}/100`}</Typography.Text>}
                  />
                  <HistoryDropdown histKey="plan.unitNameTpl" onPick={(v) => patch({ unitNameTpl: v })} />
                </Space>
                <NameTplChips tpl={form.unitNameTpl} onChange={(t) => patch({ unitNameTpl: t })} />
                <Space size={8}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    动态标号起始值
                  </Typography.Text>
                  <InputNumber
                    style={{ width: 100 }}
                    min={1}
                    precision={0}
                    value={form.unitSeqStart}
                    onChange={(v) => patch({ unitSeqStart: v ?? 1 })}
                  />
                </Space>
              </Space>
            </FormRow>
          </>
        )}

        {/* 创意命名：常规/全自动都展示（创意名独立于组名，可自定义） */}
        <FormRow
          label="广告创意命名规则"
          tip="通配符：[序号] [日期] [时间]；勾选「与素材名一致」时忽略模板，直接用视频名"
          rowId="fld-creativeName"
          flash={flashField === 'creativeName'}
        >
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            <ChipGroup
              value={form.creativeNameSameAsMaterial ? 'material' : 'tpl'}
              onChange={(v) => patch({ creativeNameSameAsMaterial: v === 'material' })}
              options={[
                { value: 'tpl', label: '命名模板' },
                { value: 'material', label: '与素材名一致', tip: '每个创意直接使用其视频文件名，组内重名自动加 -2/-3 序号' },
              ]}
            />
            {form.creativeNameSameAsMaterial ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                创意名将直接使用所选视频的名称，例如「产品A讲解视频」
              </Typography.Text>
            ) : (
              <>
                <Space size={6} style={{ width: '100%' }}>
                  <Input
                    style={{ width: 380 }}
                    value={form.creativeNameTpl}
                    onChange={(e) => patch({ creativeNameTpl: e.target.value })}
                    onBlur={() => pushHistory('plan.creativeNameTpl', form.creativeNameTpl)}
                    placeholder="系统自动命名，如：批量_[日期]_[序号]"
                    maxLength={100}
                    suffix={<Typography.Text type="secondary" style={{ fontSize: 12 }}>{`${form.creativeNameTpl.length}/100`}</Typography.Text>}
                  />
                  <HistoryDropdown histKey="plan.creativeNameTpl" onPick={(v) => patch({ creativeNameTpl: v })} />
                </Space>
                <NameTplChips tpl={form.creativeNameTpl} onChange={(t) => patch({ creativeNameTpl: t })} />
              </>
            )}
          </Space>
        </FormRow>

        {form.adType === 0 ? (
        <FormRow
          label="投放位置"
          rowId="fld-sceneIds"
          flash={flashField === 'sceneIds'}
        >
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <ChipGroup
              value={form.sceneMode}
              onChange={(v) => patch({ sceneMode: v as number })}
              options={[
                { value: 1, label: '智能优选（推荐）' },
                { value: 2, label: '手动选择' },
              ]}
            />
            {form.sceneMode === 1 ? null : (
              <>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  快手主站
                </Typography.Text>
                <ChipGroup
                  multiple
                  value={form.sceneIds}
                  onChange={(v) => toggleScenes(v as number[])}
                  options={[6, 7, 24, 27].map((k) => ({
                    value: k,
                    label: SCENE_ID_META[k].label,
                    tip: SCENE_ID_META[k].whiteList
                      ? '白名单资源位，需联系官方加白'
                      : undefined,
                  }))}
                />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  快手联盟
                </Typography.Text>
                <ChipGroup
                  multiple
                  value={form.sceneIds}
                  onChange={(v) => toggleScenes(v as number[])}
                  options={[5, 10].map((k) => ({
                    value: k,
                    label: SCENE_ID_META[k].label,
                    tip: SCENE_ID_META[k].whiteList
                      ? SCENE_ID_META[k].label === '联盟场景'
                        ? '对应创意层级联盟广告位，需联盟优选白名单（仅应用安装/活跃/线索）'
                        : '白名单资源位，需联系官方加白'
                      : undefined,
                  }))}
                />
                {!sceneValid && (
                  <Typography.Text type="danger" style={{ fontSize: 12 }}>
                    手动选择模式下至少勾选一个资源位
                  </Typography.Text>
                )}
              </>
            )}
          </Space>
        </FormRow>
        ) : (
          <FormRow label="投放位置" tip="搜索广告计划版位固定为搜索广告（scene_id=39），无需选择">
            <Tag color="orange" style={{ marginInlineEnd: 0 }}>
              搜索广告
            </Tag>
          </FormRow>
        )}

        <FormRow label="竞价策略">
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <ChipGroup
              value={form.bidStrategy}
              onChange={(v) => patch({ bidStrategy: v as 0 | 1 })}
              options={[
                { value: 0, label: '成本优先' },
                {
                  value: 1,
                  label: '最大转化',
                  disabled: maxConvertBlocked,
                  tip: maxConvertBlocked
                    ? '当计划预算为不限时，不支持选择最大转化，请先将预算改为「统一预算」'
                    : '平台智能出价，无需填写出价',
                },
              ]}
            />
            {maxConvert && (
              <Alert
                type="warning"
                showIcon
                message="最大转化为平台智能出价：无需填写出价；请确保计划日预算已填写。"
              />
            )}
          </Space>
        </FormRow>

        {form.putMode === 'auto' && form.cycleStable && (
          <FormRow
            label="周期总预算"
            tip="range_budget：系统在稳投周期内的总消耗上限，仅稳投开启时生效（官方要求 ≥3500 元）"
          >
            <InputNumber
              style={{ width: 160 }}
              min={0}
              step={100}
              addonAfter="元"
              placeholder="周期总预算"
              value={form.cycleBudgetYuan ?? undefined}
              onChange={(v) => patch({ cycleBudgetYuan: v })}
            />
          </FormRow>
        )}

        {!maxConvert && (
          <FormRow label="出价类型">
            <Space size={12} wrap>
              <ChipGroup
                value={form.bidType}
                onChange={(v) => patch({ bidType: v as number })}
                options={[
                  { value: 2, label: 'CPC（按点击）' },
                  { value: 10, label: 'oCPM（按转化）' },
                ]}
              />
              {form.bidType === 10 && (
                <Tag style={{ marginInlineEnd: 0 }}>计费方式：oCPM（按展示付费）</Tag>
              )}
            </Space>
          </FormRow>
        )}

        {!maxConvert && form.bidType === 2 && (
          <FormRow
            label="点击出价"
            rowId="fld-bidYuan"
            flash={flashField === 'bidYuan'}
          >
            <Space size={8}>
              <InputNumber
                style={{ width: 130 }}
                min={0}
                step={0.1}
                addonAfter="元"
                placeholder="点击出价"
                value={form.bidYuan ?? undefined}
                onChange={(v) => patch({ bidYuan: v })}
                onBlur={() => pushHistory('plan.bid', form.bidYuan)}
              />
              <HistoryDropdown histKey="plan.bid" onPick={(v) => patch({ bidYuan: Number(v) })} />
              {bidMissing && (
                <Typography.Text type="danger" style={{ fontSize: 12 }}>
                  请填写出价
                </Typography.Text>
              )}
            </Space>
          </FormRow>
        )}

        {/* 出价方式（oCPM）：固定 / 随机 / 阶梯 —— 生成策略，预览时实体化为每行出价 */}
        {!maxConvert && form.bidType === 10 && (
          <FormRow
            label="出价方式"
            tip="作用于每条链路：预览时按策略为每个创意组生成各自的目标出价"
            rowId="fld-cpaBidYuan"
            flash={
              flashField === 'cpaBidYuan' ||
              flashField === 'bidMinYuan' ||
              flashField === 'bidMaxYuan'
            }
          >
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <ChipGroup
                value={form.bidMode}
                onChange={(v) => patch({ bidMode: v as 'fixed' | 'random' | 'ladder' })}
                options={[
                  { value: 'fixed', label: '固定出价' },
                  { value: 'random', label: '随机出价' },
                  { value: 'ladder', label: '阶梯出价' },
                ]}
              />
              <FormRow label="出价分配规则">
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  <ChipGroup
                    value={form.bidAssign}
                    onChange={(v) => patch({ bidAssign: v as 'same' | 'perAccount' })}
                    options={[
                      { value: 'same', label: '全部相同' },
                      { value: 'perAccount', label: '按账户分配' },
                    ]}
                  />
                  {form.bidAssign === 'perAccount' && (
                    <Space direction="vertical" size={6} style={{ width: '100%' }}>
                      {accounts.map((a) => (
                        <Space key={a.advertiserId} size={8}>
                          <Tag
                            style={{ marginInlineEnd: 0, maxWidth: 260 }}
                            color={a.advertiserId === form.advertiserId ? 'orange' : undefined}
                          >
                            {a.accountName ?? a.advertiserId}
                          </Tag>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {a.advertiserId}
                          </Typography.Text>
                          <InputNumber
                            style={{ width: 120 }}
                            min={0}
                            step={0.1}
                            addonAfter="元"
                            placeholder="该账户出价"
                            value={form.accountBids[a.advertiserId] ?? undefined}
                            onChange={(v) =>
                              patch({
                                accountBids: { ...form.accountBids, [a.advertiserId]: v },
                              })
                            }
                          />
                        </Space>
                      ))}
                    </Space>
                  )}
                </Space>
              </FormRow>
              {form.bidMode === 'fixed' ? (
                <Space size={8}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    统一目标出价
                  </Typography.Text>
                  <InputNumber
                    style={{ width: 130 }}
                    min={0}
                    step={0.1}
                    addonAfter="元"
                    placeholder="目标出价"
                    value={form.cpaBidYuan ?? undefined}
                    onChange={(v) => patch({ cpaBidYuan: v })}
                    onBlur={() => pushHistory('plan.bid', form.cpaBidYuan)}
                  />
                  <HistoryDropdown histKey="plan.bid" onPick={(v) => patch({ cpaBidYuan: Number(v) })} />
                  {bidMissing && (
                    <Typography.Text type="danger" style={{ fontSize: 12 }}>
                      请填写出价
                    </Typography.Text>
                  )}
                </Space>
              ) : (
                <Space size={8}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    出价范围
                  </Typography.Text>
                  <InputNumber
                    style={{ width: 110 }}
                    min={0.1}
                    step={0.5}
                    addonAfter="元"
                    placeholder="最低"
                    value={form.bidMinYuan ?? undefined}
                    onChange={(v) => patch({ bidMinYuan: v })}
                    onBlur={() => pushHistory('plan.bidMin', form.bidMinYuan)}
                  />
                  <HistoryDropdown histKey="plan.bidMin" onPick={(v) => patch({ bidMinYuan: Number(v) })} />
                  <span style={{ color: '#888780' }}>~</span>
                  <InputNumber
                    style={{ width: 110 }}
                    min={0.1}
                    step={0.5}
                    addonAfter="元"
                    placeholder="最高"
                    value={form.bidMaxYuan ?? undefined}
                    onChange={(v) => patch({ bidMaxYuan: v })}
                    onBlur={() => pushHistory('plan.bidMax', form.bidMaxYuan)}
                  />
                  <HistoryDropdown histKey="plan.bidMax" onPick={(v) => patch({ bidMaxYuan: Number(v) })} />
                  {bidMissing && (
                    <Typography.Text type="danger" style={{ fontSize: 12 }}>
                      {form.bidMinYuan == null || form.bidMaxYuan == null
                        ? '请填写出价范围'
                        : '最高出价不能低于最低出价'}
                    </Typography.Text>
                  )}
                </Space>
              )}
            </Space>
          </FormRow>
        )}

        {isOcpx && (
          <FormRow
            label="优化目标"
            tip="转化出价依据的行为"
            rowId="fld-ocpxActionType"
            flash={flashField === 'ocpxActionType'}
          >
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <ChipGroup
                value={form.ocpxActionType}
                onChange={(v) => patch({ ocpxActionType: v as number | null })}
                options={Object.entries(OCPX_ACTION_TYPE_META)
                  .filter(([, meta]) => meta.campaignTypes.includes(campaignType))
                  .map(([k, v]) => ({ value: Number(k), label: v.label }))}
              />
              {needRoiRatio && (
                <Space size={8}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    ROI 系数
                  </Typography.Text>
                  <InputNumber
                    style={{ width: 120 }}
                    min={0}
                    max={100}
                    step={0.001}
                    value={form.roiRatio ?? undefined}
                    onChange={(v) => patch({ roiRatio: v })}
                  />
                </Space>
              )}
              {ocpxMissing && (
                <Typography.Text type="danger" style={{ fontSize: 12 }}>
                  请选择优化目标
                </Typography.Text>
              )}
            </Space>
          </FormRow>
        )}

        <FormRow label="深度优化目标" tip="双出价：主出价之外再为深度目标单独出价">
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Switch
              size="small"
              checked={form.deepEnabled}
              onChange={(on) => patch({ deepEnabled: on })}
            />
            {form.deepEnabled && (
              <>
                <ChipGroup
                  value={form.deepConversionType}
                  onChange={(v) => patch({ deepConversionType: v as number | null })}
                  options={Object.entries(DEEP_CONVERSION_META).map(([k, v]) => ({
                    value: Number(k),
                    label: v.label,
                  }))}
                />
                <Space size={8}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    深度出价
                  </Typography.Text>
                  <InputNumber
                    style={{ width: 130 }}
                    min={0}
                    step={0.5}
                    addonAfter="元"
                    placeholder="深度目标出价"
                    value={form.deepConversionBidYuan ?? undefined}
                    onChange={(v) => patch({ deepConversionBidYuan: v })}
                  />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    需大于浅层出价、不超过 3000 元；深度目标需账户白名单
                  </Typography.Text>
                </Space>
                {deepBidMissing && (
                  <Typography.Text type="danger" style={{ fontSize: 12 }}>
                    请填写深度出价
                  </Typography.Text>
                )}
              </>
            )}
          </Space>
        </FormRow>

        <FormRow label="投放平台">
          <ChipGroup
            value={form.platformOs}
            onChange={(v) => patch({ platformOs: v as number })}
            options={[
              { value: 0, label: '不限' },
              { value: 1, label: 'Android' },
              { value: 2, label: 'iOS' },
            ]}
          />
        </FormRow>

        {isAppGoal && (
          <FormRow label="下载方式" tip="白名单生效；落地页下载需配置下载中间页">
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <ChipGroup
                value={form.downloadMode}
                onChange={(v) => patch({ downloadMode: v as 0 | 1 })}
                options={[
                  { value: 0, label: '直接下载' },
                  { value: 1, label: '落地页下载' },
                ]}
              />
              {form.downloadMode === 1 && (
                <Space size={8} wrap>
                  <div
                    onClick={() => setDownloadLpOpen(true)}
                    style={{
                      minWidth: 280,
                      maxWidth: 420,
                      padding: '5px 12px',
                      border: '1px solid #E8E6E1',
                      borderRadius: 6,
                      fontSize: 13,
                      cursor: 'pointer',
                      color: form.downloadSiteId ? '#37352F' : '#B8B5AC',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                    }}
                  >
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {form.downloadSiteId
                        ? lpPages.find((p) => p.id === form.downloadSiteId)?.name ||
                          form.downloadSiteId
                        : '点此选择下载中间页（建站）'}
                    </span>
                    <RightOutlined style={{ fontSize: 10, color: '#B8B5AC' }} />
                  </div>
                  <Button
                    size="small"
                    icon={<ReloadOutlined />}
                    loading={lpQuery.isFetching}
                    onClick={() => refreshAssets('lp')}
                    disabled={!form.advertiserId}
                  >
                    同步落地页
                  </Button>
                </Space>
              )}
            </Space>
          </FormRow>
        )}

        {isAppGoal && (
          <FormRow label="应用商店下载" tip="优先从应用商店下载（仅安卓应用生效）">
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <Switch
                size="small"
                checked={form.useAppMarket}
                onChange={(on) => patch({ useAppMarket: on })}
              />
              {form.useAppMarket && (
                <>
                  <ChipGroup
                    multiple
                    value={form.appStores}
                    onChange={(v) => patch({ appStores: v as string[] })}
                    options={Object.entries(APP_STORE_META).map(([k, label]) => ({
                      value: k,
                      label,
                    }))}
                  />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    默认全选；仅当开启「优先从应用商店下载」时生效
                  </Typography.Text>
                </>
              )}
            </Space>
          </FormRow>
        )}

        <FormRow
          label="每日预算"
          rowId="fld-campaignDayBudgetYuan"
          flash={flashField === 'campaignDayBudgetYuan' || flashField === 'unitDayBudgetYuan'}
        >
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <ChipGroup
              value={form.budgetMode}
              onChange={(v) =>
                patch({ budgetMode: v as 'unlimited' | 'unified' })
              }
              options={[
                { value: 'unlimited', label: '不限' },
                {
                  value: 'unified',
                  label: '统一预算',
                  disabled: form.putMode === 'auto',
                  tip:
                    form.putMode === 'auto'
                      ? '全自动投放由系统接管预算，不支持统一预算'
                      : maxConvert
                        ? undefined
                        : '选择统一预算后可启用最大转化竞价策略',
                },
              ]}
            />
            {form.budgetMode === 'unified' && (
              <Space size={12}>
                <Space size={6}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>计划</Typography.Text>
                  <InputNumber
                    style={{ width: 130 }}
                    min={0}
                    addonAfter="元"
                    placeholder="计划日预算"
                    status={maxConvert && form.campaignDayBudgetYuan == null ? 'error' : undefined}
                    value={form.campaignDayBudgetYuan ?? undefined}
                    onChange={(v) => patch({ campaignDayBudgetYuan: v })}
                    onBlur={() => pushHistory('plan.campaignBudget', form.campaignDayBudgetYuan)}
                  />
                  <HistoryDropdown
                    histKey="plan.campaignBudget"
                    onPick={(v) => patch({ campaignDayBudgetYuan: Number(v) })}
                  />
                </Space>
                <Space size={6}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>广告组</Typography.Text>
                  <InputNumber
                    style={{ width: 130 }}
                    min={0}
                    addonAfter="元"
                    placeholder="组日预算"
                    value={form.unitDayBudgetYuan ?? undefined}
                    onChange={(v) => patch({ unitDayBudgetYuan: v })}
                    onBlur={() => pushHistory('plan.unitBudget', form.unitDayBudgetYuan)}
                  />
                  <HistoryDropdown
                    histKey="plan.unitBudget"
                    onPick={(v) => patch({ unitDayBudgetYuan: Number(v) })}
                  />
                </Space>
                {maxConvert && form.campaignDayBudgetYuan == null && (
                  <Typography.Text type="danger" style={{ fontSize: 12 }}>
                    最大转化必须填写计划日预算
                  </Typography.Text>
                )}
              </Space>
            )}
          </Space>
        </FormRow>

        <FormRow
          label="排期"
          rowId="fld-beginTime"
          flash={flashField === 'beginTime' || flashField === 'endTime'}
        >
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <ChipGroup
              value={form.scheduleMode}
              onChange={(v) => patch({ scheduleMode: v as 'long' | 'custom' })}
              options={[
                { value: 'long', label: '长期投放' },
                { value: 'custom', label: '设定开始结束日期' },
              ]}
            />
            <Space size={12}>
              <DatePicker
                style={{ width: 150 }}
                value={form.beginTime ? dayjs(form.beginTime) : undefined}
                onChange={(d: Dayjs | null) => patch({ beginTime: d ? d.format('YYYY-MM-DD') : '' })}
                disabledDate={(cur) => cur.isBefore(dayjs().startOf('day'))}
                placeholder="点击选择开始日期"
                allowClear={false}
              />
              {form.scheduleMode === 'custom' && (
                <DatePicker
                  style={{ width: 150 }}
                  value={form.endTime ? dayjs(form.endTime) : undefined}
                  onChange={(d: Dayjs | null) => patch({ endTime: d ? d.format('YYYY-MM-DD') : '' })}
                  disabledDate={(cur) => {
                    if (cur.isBefore(dayjs().startOf('day'))) return true;
                    return form.beginTime ? cur.isBefore(dayjs(form.beginTime)) : false;
                  }}
                  placeholder="点击选择结束日期"
                />
              )}
              {form.scheduleMode === 'long' && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  开始日期自动取当天
                </Typography.Text>
              )}
            </Space>
          </Space>
        </FormRow>

        <FormRow
          label="投放时段"
          rowId="fld-scheduleTime"
          flash={flashField === 'scheduleTime'}
        >
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <ChipGroup
              value={form.timeMode}
              onChange={(v) => patch({ timeMode: v as 'all' | 'custom' })}
              options={[
                { value: 'all', label: '全天' },
                { value: 'custom', label: '特定时间' },
              ]}
            />
            {form.timeMode === 'custom' && (
              <Space direction="vertical" size={4}>
                <TimeSeriesPicker
                  value={form.timeSeries}
                  onChange={(next) => patch({ timeSeries: next })}
                />
                <Space size={12}>
                  <Typography.Link
                    style={{ fontSize: 12 }}
                    onClick={() => patch({ timeSeries: ALL_HOURS_TRUE() })}
                  >
                    重置为全天
                  </Typography.Link>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    已选 {form.timeSeries.filter(Boolean).length} / 168 小时
                  </Typography.Text>
                </Space>
              </Space>
            )}
          </Space>
        </FormRow>

        <FormRow label="创意展现方式">
          <Space direction="vertical" size={4}>
            <ChipGroup
              value={form.showMode}
              onChange={(v) => patch({ showMode: v as number })}
              options={[
                { value: 2, label: '智能优选（默认）' },
                { value: 1, label: '随机轮播' },
              ]}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              每一次展现时系统进行 CTR 预估，预估 CTR 高的创意获得展现机会。
            </Typography.Text>
          </Space>
        </FormRow>

        {form.putMode === 'normal' && (
          <FormRow label="广告组名称配置" tip="对齐 mobgi：统一 / 分账户，支持账户通配符">
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <ChipGroup
                value={form.nameMode}
                onChange={(v) => patch({ nameMode: v as 'unified' | 'perAccount' })}
                options={[
                  { value: 'unified', label: '统一配置' },
                  { value: 'perAccount', label: '分账户配置' },
                ]}
              />
              {form.nameMode === 'perAccount' ? (
                <Space direction="vertical" size={6} style={{ width: '100%' }}>
                  {accounts.map((a) => (
                    <Space key={a.advertiserId} size={8}>
                      <Tag
                        style={{ marginInlineEnd: 0, maxWidth: 240 }}
                        color={a.advertiserId === form.advertiserId ? 'orange' : undefined}
                      >
                        {a.accountName ?? a.advertiserId}
                      </Tag>
                      <Input
                        style={{ width: 200 }}
                        value={form.accountNamePrefixes[a.advertiserId] ?? ''}
                        onChange={(e) =>
                          patch({
                            accountNamePrefixes: {
                              ...form.accountNamePrefixes,
                              [a.advertiserId]: e.target.value,
                            },
                          })
                        }
                        onBlur={() =>
                          pushHistory('plan.namePrefix', form.accountNamePrefixes[a.advertiserId])
                        }
                        placeholder={`${a.advertiserId} 的命名前缀`}
                        maxLength={100}
                      />
                      <HistoryDropdown
                        histKey="plan.namePrefix"
                        onPick={(v) =>
                          patch({
                            accountNamePrefixes: {
                              ...form.accountNamePrefixes,
                              [a.advertiserId]: v,
                            },
                          })
                        }
                      />
                    </Space>
                  ))}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    每个账户用各自前缀生成名称；当前批量使用账户 {form.advertiserId || '（未选）'}。
                  </Typography.Text>
                </Space>
              ) : (
                <Space size={8}>
                  <Input
                    style={{ width: 280 }}
                    value={form.namePrefix}
                    onChange={(e) => patch({ namePrefix: e.target.value })}
                    onBlur={() => pushHistory('plan.namePrefix', form.namePrefix)}
                    placeholder="命名前缀，如：双11_游戏A_扩量"
                    maxLength={100}
                  />
                  <HistoryDropdown histKey="plan.namePrefix" onPick={(v) => patch({ namePrefix: v })} />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    + 动态标号（_01、_02…）
                  </Typography.Text>
                </Space>
              )}
              <Space size={8}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  通配符（提交时自动替换）：
                </Typography.Text>
                {(['[账户ID]', '[账户备注]', '[应用名称]', '[序号]', '[日期]'] as const).map((tk) => (
                  <Typography.Link
                    key={tk}
                    style={{ fontSize: 12 }}
                    onClick={() =>
                      patch({
                        namePrefix: `${form.namePrefix}${tk}`,
                      })
                    }
                  >
                    + {tk}
                  </Typography.Link>
                ))}
              </Space>
              <Space size={8}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  动态标号起始值
                </Typography.Text>
                <InputNumber
                  style={{ width: 100 }}
                  min={1}
                  precision={0}
                  value={form.unitSeqStart}
                  onChange={(v) => patch({ unitSeqStart: v ?? 1 })}
                />
              </Space>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                示例：
                <code>{`${form.namePrefix || '前缀'}_${String(form.unitSeqStart).padStart(2, '0')}`}</code>
                。预览区会展示每条链路的实际名称。
              </Typography.Text>
            </Space>
          </FormRow>
        )}
      </Drawer>

      {/* ================= 编辑抽屉：定向 ================= */}
      <Drawer
        title="定向"
        placement="right"
        width={520}
        open={drawer === 'target'}
        onClose={closeDrawer}
        footer={
          <div style={{ textAlign: 'right' }}>
            <Button type="primary" onClick={closeDrawer}>
              完成
            </Button>
          </div>
        }
      >
        {/* —— 定向包（先建包、上计划时选择；支持保存修改 / 另存为） —— */}
        <FormRow
          label="定向包"
          tip="选包即整体套用；改过参数后可「保存」覆盖当前包，或「另存为」新包"
        >
          <Space size={8} wrap>
            <Select
              style={{ width: 260 }}
              placeholder="选择定向包"
              value={appliedPackageId ?? undefined}
              onChange={(v) => applyPackage(v ?? null)}
              options={(packagesQuery.data ?? []).map((p) => ({
                value: p.id,
                label: p.note ? `${p.name}（${p.note}）` : p.name,
              }))}
              allowClear
              loading={packagesQuery.isFetching}
            />
            {appliedPackageId != null ? (
              <>
                <Button
                  size="small"
                  loading={updatePackageMutation.isPending}
                  onClick={() => {
                    const pkg = packagesQuery.data?.find((p) => p.id === appliedPackageId);
                    if (!pkg) return;
                    const targeting = pkgFromForm();
                    if (Object.keys(targeting).length === 0) {
                      message.warning('当前没有可保存的定向参数，请先在下方配置');
                      return;
                    }
                    updatePackageMutation.mutate({ id: pkg.id, name: pkg.name, targeting });
                  }}
                >
                  保存当前模板
                </Button>
                <Button
                  size="small"
                  icon={<PlusOutlined />}
                  loading={savePackageMutation.isPending}
                  onClick={() => {
                    const pkgTargeting = pkgFromForm();
                    if (Object.keys(pkgTargeting).length === 0) {
                      message.warning('当前没有可保存的定向参数，请先在下方配置');
                      return;
                    }
                    let pkgName = '';
                    modal.confirm({
                      title: '另存为新定向包',
                      content: (
                        <Input
                          placeholder="定向包名称，如：安卓通用-不限年龄"
                          onChange={(e) => {
                            pkgName = e.target.value;
                          }}
                        />
                      ),
                      onOk: () =>
                        savePackageMutation.mutateAsync({
                          name: pkgName.trim() || `定向包 ${dayjs().format('MM-DD HH:mm')}`,
                          targeting: pkgTargeting,
                        }),
                    });
                  }}
                >
                  另存为
                </Button>
                <Button
                  size="small"
                  danger
                  onClick={() => removePackageMutation.mutate(appliedPackageId)}
                >
                  删除此包
                </Button>
              </>
            ) : (
              <Button
                size="small"
                icon={<PlusOutlined />}
                onClick={() => {
                  const pkgTargeting = pkgFromForm();
                  if (Object.keys(pkgTargeting).length === 0) {
                    message.warning('当前没有可保存的定向参数，请先在下方配置');
                    return;
                  }
                  let pkgName = '';
                  modal.confirm({
                    title: '保存为定向包',
                    content: (
                      <Input
                        placeholder="定向包名称，如：安卓通用-不限年龄"
                        onChange={(e) => {
                          pkgName = e.target.value;
                        }}
                      />
                    ),
                    onOk: () =>
                      savePackageMutation.mutateAsync({
                        name: pkgName.trim() || `定向包 ${dayjs().format('MM-DD HH:mm')}`,
                        targeting: pkgTargeting,
                      }),
                  });
                }}
              >
                保存为定向包
              </Button>
            )}
          </Space>
        </FormRow>

        {isSearchAd && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="搜索广告仅支持以下定向维度：地域、操作系统、过滤已转化、人群包排除（其余维度平台不支持，已隐藏）。官方建议搜索广告尽量少用定向以免影响拿量。"
          />
        )}
        {form.adType === 0 && (
        <FormRow label="性别">
          <ChipGroup
            value={form.gender}
            onChange={(v) => patch({ gender: v as number })}
            options={[
              { value: 0, label: '不限' },
              { value: 1, label: '女' },
              { value: 2, label: '男' },
            ]}
          />
        </FormRow>
        )}
        {form.adType === 0 && (
        <FormRow label="年龄" tip="ages_range，可多选；不选为不限">
          <Select
            mode="multiple"
            style={{ width: '100%' }}
            placeholder="不限"
            maxTagCount="responsive"
            value={form.targeting.agesRange}
            onChange={(v) =>
              patch({ targeting: { ...form.targeting, agesRange: v as number[] } })
            }
            options={AGE_OPTIONS}
            allowClear
          />
        </FormRow>
        )}
        <FormRow label="地域" tip="region：可勾选省/市，勾选父级即覆盖其下全部子级">
          <TreeSelect
            style={{ width: '100%' }}
            treeData={regionTreeData}
            treeCheckable
            showCheckedStrategy={TreeSelect.SHOW_PARENT}
            maxTagCount="responsive"
            placeholder={regionsQuery.isFetching ? '地域加载中…' : '不限'}
            loading={regionsQuery.isFetching}
            value={form.targeting.regionIds}
            onChange={(v) =>
              patch({ targeting: { ...form.targeting, regionIds: v as number[] } })
            }
            allowClear
            treeNodeFilterProp="title"
          />
        </FormRow>
        <FormRow label="操作系统" tip="platform_os">
          <ChipGroup
            value={form.platformOs}
            onChange={(v) => patch({ platformOs: v as number })}
            options={[
              { value: 0, label: '不限' },
              { value: 1, label: 'Android' },
              { value: 2, label: 'iOS' },
            ]}
          />
        </FormRow>
        {form.adType === 0 && (
        <FormRow label="网络环境" tip="network">
          <ChipGroup
            value={form.network}
            onChange={(v) => patch({ network: v as number })}
            options={[
              { value: 0, label: '不限' },
              { value: 1, label: 'WiFi' },
              { value: 2, label: '移动网络' },
            ]}
          />
        </FormRow>
        )}
        {form.adType === 0 && (
        <FormRow label="用户类型" tip="user_type：地域判定口径">
          <ChipGroup
            value={form.targeting.userType}
            onChange={(v) => patch({ targeting: { ...form.targeting, userType: v as number } })}
            options={[
              { value: 0, label: '实时' },
              { value: 1, label: '常驻' },
              { value: 2, label: '不限' },
            ]}
          />
        </FormRow>
        )}
        {form.adType === 0 && (
        <FormRow label="设备品牌" tip="device_brand_ids，可多选；iOS 定向时无效">
          <Select
            mode="multiple"
            style={{ width: '100%' }}
            placeholder="不限"
            maxTagCount="responsive"
            value={form.targeting.deviceBrands}
            onChange={(v) =>
              patch({ targeting: { ...form.targeting, deviceBrands: v as number[] } })
            }
            options={DEVICE_BRAND_OPTIONS}
            allowClear
          />
        </FormRow>
        )}
        {form.adType === 0 && (
        <FormRow label="设备价格" tip="device_price，可多选">
          <Select
            mode="multiple"
            style={{ width: '100%' }}
            placeholder="不限"
            maxTagCount="responsive"
            value={form.targeting.devicePrices}
            onChange={(v) =>
              patch({ targeting: { ...form.targeting, devicePrices: v as number[] } })
            }
            options={DEVICE_PRICE_OPTIONS}
            allowClear
          />
        </FormRow>
        )}
        {form.adType === 0 && (
        <FormRow
          label="智能定向"
          tip="inteli_extend_option：开启后系统在定向基础上智能探索优质人群（Pro 需白名单）"
        >
          <ChipGroup
            value={form.targeting.intelliExtend}
            onChange={(v) =>
              patch({ targeting: { ...form.targeting, intelliExtend: v as number } })
            }
            options={[
              { value: 0, label: '关闭' },
              { value: 1, label: '开启' },
              { value: 2, label: 'Pro', tip: '白名单功能' },
            ]}
          />
        </FormRow>
        )}
        {form.adType === 0 && (
        <FormRow
          label="行为兴趣"
          tip="behavior_type：系统优选由平台自动圈选高转化人群；自定义类目词需标签库，暂未开放"
        >
          <ChipGroup
            value={form.targeting.behaviorType}
            onChange={(v) =>
              patch({ targeting: { ...form.targeting, behaviorType: v as number } })
            }
            options={[
              { value: 0, label: '不限' },
              { value: 2, label: '系统优选' },
            ]}
          />
        </FormRow>
        )}
        <FormRow
          label="过滤已转化"
          tip="filter_converted_level：按维度过滤已转化人群（搜索/联盟广告不支持）"
        >
          <ChipGroup
            value={form.targeting.filterConvertedLevel}
            onChange={(v) =>
              patch({ targeting: { ...form.targeting, filterConvertedLevel: v as number } })
            }
            options={[
              { value: 0, label: '不限' },
              { value: 1, label: '广告组' },
              { value: 2, label: '广告计划' },
              { value: 3, label: '本账户' },
              { value: 4, label: '公司主体' },
              { value: 5, label: 'APP' },
            ]}
          />
        </FormRow>
        {form.adType === 0 && (
        <FormRow label="过滤已安装APP" tip="disable_installed_app_switch：应用类目标下过滤已安装人群">
          <ChipGroup
            value={form.targeting.disableInstalledApp}
            onChange={(v) =>
              patch({ targeting: { ...form.targeting, disableInstalledApp: v as number } })
            }
            options={[
              { value: 0, label: '过滤（默认）' },
              { value: 1, label: '不限' },
            ]}
          />
        </FormRow>
        )}
        {form.adType === 0 && (
        <FormRow label="人群包定向" tip="population：账户已生效人群包（dmp），与排除不能有交集">
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            <Select
              mode="multiple"
              style={{ width: '100%' }}
              placeholder={
                populationsQuery.isFetching
                  ? '人群包加载中…'
                  : populationOptions.length === 0
                    ? '该账户暂无已生效人群包'
                    : '不限'
              }
              loading={populationsQuery.isFetching}
              maxTagCount="responsive"
              value={form.targeting.population}
              onChange={(v) =>
                patch({ targeting: { ...form.targeting, population: v as string[] } })
              }
              options={populationOptions}
              allowClear
            />
          </Space>
        </FormRow>
        )}
        <FormRow label="人群包排除" tip="exclude_population：排除指定人群包">
          <Select
            mode="multiple"
            style={{ width: '100%' }}
            placeholder="不限"
            loading={populationsQuery.isFetching}
            maxTagCount="responsive"
            value={form.targeting.excludePopulation}
            onChange={(v) =>
              patch({ targeting: { ...form.targeting, excludePopulation: v as string[] } })
            }
            options={populationOptions}
            allowClear
          />
        </FormRow>
      </Drawer>

      {/* ================= 编辑抽屉：创意基本信息 ================= */}
      <Drawer
        title="创意基本信息"
        placement="right"
        width={520}
        open={drawer === 'creative'}
        onClose={closeDrawer}
        footer={
          <div style={{ textAlign: 'right' }}>
            <Button type="primary" onClick={closeDrawer}>
              完成
            </Button>
          </div>
        }
      >
        {/* —— 搜索快投（仅展示广告；对齐创量：需白名单，选智能优选/上下滑大屏版位后开启搜索投放） —— */}
        {form.adType === 0 && (
          <FormRow
            label="搜索快投"
            tip="组级 quick_search：选择「智能优选」或「上下滑大屏广告」版位后开启，即可获得搜索流量；需开通白名单；MAPI 暂不支持添加关键词"
          >
            <ChipGroup
              value={form.searchQuick ? 'on' : 'off'}
              onChange={(v) => patch({ searchQuick: v === 'on' })}
              options={[
                { value: 'off', label: '关闭' },
                { value: 'on', label: '开启', tip: '开启即可吃到搜索流量，无需添加关键词' },
              ]}
            />
            {form.searchQuick && (
              <div
                style={{
                  marginTop: 8,
                  fontSize: 12,
                  lineHeight: 1.7,
                  color: '#5F5E5A',
                  background: '#F7F6FE',
                  border: '1px solid rgba(127,119,221,.25)',
                  borderRadius: 6,
                  padding: '8px 10px',
                }}
              >
                已自动开启 <b>智能扩词</b>（extend_search）—— 平台强制要求：开启搜索快投
                必须同时开启智能扩词，否则创建会被拒（401000「搜索快投必须开启智能扩词」）。
                无需另行设置。
              </div>
            )}
          </FormRow>
        )}

        {/* —— 搜索设置（仅搜索广告；对齐创量：智能扩词 / 否定词 / 搜索人群追投） —— */}
        {form.adType === 1 && (
          <>
            <FormRow label="智能扩词" tip="extend_search：系统自动扩展高相关搜索词，扩大流量">
              <Switch
                size="small"
                checked={form.searchExtend}
                onChange={(on) => patch({ searchExtend: on })}
              />
            </FormRow>
            <FormRow
              label="否定词（选填）"
              tip="命中否词广告不展现；短语否定词与精确否定词各支持 200 个"
            >
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                <Input.TextArea
                  rows={2}
                  value={form.searchNegPhraseText}
                  onChange={(e) => patch({ searchNegPhraseText: e.target.value })}
                  onBlur={() => pushHistory('plan.negPhrase', form.searchNegPhraseText)}
                  placeholder="短语否定词（搜索词中包含该词即不展现），一行一个"
                />
                <HistoryDropdown
                  histKey="plan.negPhrase"
                  onPick={(v) => patch({ searchNegPhraseText: v })}
                />
                <Input.TextArea
                  rows={2}
                  value={form.searchNegExactText}
                  onChange={(e) => patch({ searchNegExactText: e.target.value })}
                  onBlur={() => pushHistory('plan.negExact', form.searchNegExactText)}
                  placeholder="精确否定词（搜索词与该词完全一致才不展现），一行一个"
                />
                <HistoryDropdown
                  histKey="plan.negExact"
                  onPick={(v) => patch({ searchNegExactText: v })}
                />
              </Space>
            </FormRow>
            <FormRow
              label="搜索人群追投"
              tip="target_explore：在搜索场景追投定向人群以外的优质人群"
            >
              <ChipGroup
                value={form.searchExplore ? 'on' : 'off'}
                onChange={(v) => patch({ searchExplore: v === 'on' })}
                options={[
                  { value: 'off', label: '关闭' },
                  { value: 'on', label: '开启' },
                ]}
              />
            </FormRow>
          </>
        )}

        {/* —— 原生广告投放（对齐 mobgi：开启后出授权类型/选择方式/快手号） —— */}
        <FormRow label="原生广告投放" tip="开启后可使用原生样式，突破流量限制获得额外原生流量">
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <ChipGroup
              value={form.nativeAd ? 'on' : 'off'}
              onChange={(v) => patch({ nativeAd: v === 'on' })}
              options={[
                { value: 'off', label: '关闭' },
                { value: 'on', label: '开启' },
              ]}
            />
            {form.nativeAd && (
              <>
                <FormRow label="授权类型">
                  <Space direction="vertical" size={4} style={{ width: '100%' }}>
                    <ChipGroup
                      value={form.nativeAuthType}
                      onChange={(v) =>
                        patch({
                          nativeAuthType: v as number,
                          // 授权类型切换后，原快手号多半不属于新类型，清掉重选
                          nativeKwaiUserId: null,
                        })
                      }
                      options={[
                        { value: 1, label: '服务号授权' },
                        { value: 2, label: '达人视频授权' },
                        { value: 3, label: '普通快手号' },
                      ]}
                    />
                  </Space>
                </FormRow>
                <FormRow label="选择快手号" tip="从当前账户已授权的快手号中拉取（统一配置）">
                  <Space direction="vertical" size={4} style={{ width: '100%' }}>
                    <Space.Compact style={{ width: '100%' }}>
                      <Select
                        style={{ width: '100%' }}
                        allowClear
                        showSearch
                        optionFilterProp="label"
                        placeholder={
                          !form.advertiserId
                            ? '请先选择投放账户'
                            : nativeUsersQuery.isError
                              ? '拉取失败，可重试'
                              : nativeUsers.length === 0
                                ? '该账户暂无此类已授权快手号'
                                : '选择快手号'
                        }
                        loading={nativeUsersQuery.isFetching}
                        value={form.nativeKwaiUserId ?? undefined}
                        onChange={(v) => patch({ nativeKwaiUserId: v ?? null })}
                        options={nativeUsers.map((u) => ({
                          value: u.userId,
                          label: `${u.userName}（${u.userId}）`,
                        }))}
                        notFoundContent={
                          nativeUsersQuery.isError ? (
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              拉取失败：{(nativeUsersQuery.error as Error)?.message?.slice(0, 80)}
                            </Typography.Text>
                          ) : (
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              {form.nativeAd
                                ? '该账户暂无此类已授权快手号，请先在快手平台「资产-快手号授权」完成绑定'
                                : '先开启原生广告投放'}
                            </Typography.Text>
                          )
                        }
                      />
                      <Button
                        icon={<ReloadOutlined />}
                        onClick={() => nativeUsersQuery.refetch()}
                        title="重新拉取已授权快手号"
                      />
                    </Space.Compact>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      从当前账户（{form.advertiserId || '未选'}）已授权的快手号中拉取并选择，创建创意时随 kol_user_type / kol_user_id 下发。
                    </Typography.Text>
                  </Space>
                </FormRow>
              </>
            )}
          </Space>
        </FormRow>

        {/* —— PLC 描述语（对齐 mobgi；下发 recommendation 字段） —— */}
        <FormRow label="PLC 描述语" tip="直达链接上的贴片描述文案，13 字以内，创建创意时随 recommendation 字段下发">
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <ChipGroup
              value={form.plcMode}
              onChange={(v) => patch({ plcMode: v as 'unified' | 'manual' })}
              options={[
                { value: 'unified', label: '统一配置' },
                { value: 'manual', label: '手动设置禁用词汇' },
              ]}
            />
            {form.plcMode === 'unified' ? (
              <Space size={6} style={{ width: '100%' }}>
                <Input
                  allowClear
                  showCount
                  maxLength={13}
                  style={{ width: 300 }}
                  placeholder="填写 PLC 描述语（不填则不下发）"
                  value={form.plcText}
                  onChange={(e) => patch({ plcText: e.target.value })}
                  onBlur={() => pushHistory('plan.plcText', form.plcText)}
                />
                <HistoryDropdown histKey="plan.plcText" onPick={(v) => patch({ plcText: v })} />
              </Space>
            ) : null}
          </Space>
        </FormRow>

        {/* —— 推荐理由（对齐 mobgi；下发 new_expose_tag，官方最多 2 个） —— */}
        <FormRow label="推荐理由" tip="最多选 2 个，创建创意时随 new_expose_tag 字段下发">
          <Space size={6} wrap>
            {['新游上线', '版本更新', '限时福利'].map((r) => {
              const on = form.recommendReasons.includes(r);
              return (
                <Tag.CheckableTag
                  key={r}
                  checked={on}
                  onChange={() => {
                    if (!on && form.recommendReasons.length >= 2) return;
                    patch({
                      recommendReasons: on
                        ? form.recommendReasons.filter((x) => x !== r)
                        : [...form.recommendReasons, r],
                    });
                  }}
                  style={
                    on
                      ? { background: '#FF4F00', color: '#fff', padding: '3px 10px' }
                      : {
                          padding: '3px 10px',
                          border: '1px solid #E5E2DA',
                          cursor: !on && form.recommendReasons.length >= 2 ? 'not-allowed' : 'pointer',
                          opacity: !on && form.recommendReasons.length >= 2 ? 0.5 : 1,
                        }
                  }
                >
                  {r}
                </Tag.CheckableTag>
              );
            })}
          </Space>
        </FormRow>

        <FormRow
          label="行动号召"
          rowId="fld-actionBarText"
          flash={flashField === 'actionBarText'}
        >
          <Select
            style={{ width: 220 }}
            showSearch
            value={form.actionBarText}
            onChange={(v) => patch({ actionBarText: v })}
            options={ACTION_BAR_TEXT_OPTIONS.map((t) => ({ value: t, label: t }))}
          />
        </FormRow>

        <FormRow
          label="创意分类"
          tip="从平台创意分类树中选叶子类目（官方要求：分类与标签要么都传要么都不传，只填其一时工作台会自动忽略）"
        >
          <TreeSelect
            style={{ width: '100%' }}
            treeData={categoryTreeData as never}
            showSearch
            treeNodeFilterProp="title"
            treeDefaultExpandAll={false}
            maxTagCount="responsive"
            placeholder={
              categoriesQuery.isFetching ? '创意分类加载中…' : '不限（选叶子类目）'
            }
            loading={categoriesQuery.isFetching}
            value={form.creativeCategory ?? undefined}
            onChange={(v) => patch({ creativeCategory: (v as number) ?? null })}
            allowClear
          />
        </FormRow>

        <FormRow
          label="创意标签"
          tip="空格分隔，最多十个，每个不超过10个字"
          rowId="fld-creativeTags"
          flash={flashField === 'creativeTags'}
        >
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Space size={8} wrap>
              <Input
                style={{ width: 240 }}
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onPressEnter={(e) => addTags((e.target as HTMLInputElement).value)}
                placeholder="输入后回车添加"
                maxLength={30}
                disabled={form.creativeTags.length >= 10}
              />
              <Typography.Link style={{ fontSize: 12 }} onClick={() => addTags(tagInput)}>
                添加（回车键）
              </Typography.Link>
              <HistoryDropdown histKey="plan.creativeTags" onPick={(v) => addTags(v)} />
              <Typography.Link style={{ fontSize: 12 }} onClick={quoteLastTags}>
                引用上次内容
              </Typography.Link>
              {form.creativeTags.length > 0 && (
                <Typography.Link
                  style={{ fontSize: 12 }}
                  onClick={() => patch({ creativeTags: [] })}
                >
                  清空
                </Typography.Link>
              )}
            </Space>
            {form.creativeTags.length > 0 && (
              <Space size={6} wrap>
                {form.creativeTags.map((t) => (
                  <Tag
                    key={t}
                    closable
                    closeIcon={<CloseOutlined style={{ fontSize: 10 }} />}
                    onClose={() =>
                      patch({ creativeTags: form.creativeTags.filter((x) => x !== t) })
                    }
                  >
                    {t}
                  </Tag>
                ))}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {form.creativeTags.length}/10
                </Typography.Text>
              </Space>
            )}
          </Space>
        </FormRow>

        <FormRow label="创意名称" tip="与广告组同名，组内自动追加「-创01…-创N」；名称超长自动截断（100 字上限）">
          <Space size={8}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              动态标号起始值
            </Typography.Text>
            <InputNumber
              style={{ width: 100 }}
              min={1}
              precision={0}
              value={form.creativeSeqStart}
              onChange={(v) => patch({ creativeSeqStart: v ?? 1 })}
            />
          </Space>
        </FormRow>
      </Drawer>

      {/* ================= 编辑抽屉：转化路径 ================= */}
      <Drawer
        title={campaignType === 5 ? '应用和监测（落地页）' : '应用和监测（应用）'}
        placement="right"
        width={560}
        open={drawer === 'conversion'}
        onClose={closeDrawer}
        footer={
          <div style={{ textAlign: 'right' }}>
            <Button type="primary" onClick={closeDrawer}>
              完成
            </Button>
          </div>
        }
      >
        {campaignType === 5 ? (
          <>
            <FormRow
              label="落地页形态"
              rowId="fld-webUriType"
              flash={flashField === 'webUriType'}
            >
              <ChipGroup
                value={form.webUriType}
                onChange={(v) => patch({ webUriType: v as number })}
                options={Object.entries(WEB_URI_TYPE_META)
                  .filter(([k]) => Number(k) <= 2)
                  .map(([k, v]) => ({ value: Number(k), label: v.label }))}
              />
            </FormRow>
            {form.webUriType === 1 ? (
              <FormRow
                label="投放链接"
                rowId="fld-url"
                flash={flashField === 'url'}
              >
                <Space size={6} style={{ width: '100%' }}>
                  <Input
                    style={{ maxWidth: 380 }}
                    value={form.url}
                    onChange={(e) => patch({ url: e.target.value })}
                    onBlur={() => pushHistory('plan.url', form.url)}
                    placeholder="https://…"
                  />
                  <HistoryDropdown histKey="plan.url" onPick={(v) => patch({ url: v })} />
                </Space>
              </FormRow>
            ) : (
              <FormRow
                label="建站落地页"
                rowId="fld-siteId"
                flash={flashField === 'siteId'}
              >
                <Space size={8} wrap>
                  <div
                    onClick={() => setLpModalOpen(true)}
                    style={{
                      minWidth: 280,
                      maxWidth: 420,
                      padding: '5px 12px',
                      border: '1px solid #E8E6E1',
                      borderRadius: 6,
                      fontSize: 13,
                      cursor: 'pointer',
                      color: form.siteId ? '#37352F' : '#B8B5AC',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                    }}
                  >
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {form.siteId
                        ? lpPages.find((p) => p.id === form.siteId)?.name || form.siteId
                        : '点此打开落地页选择窗'}
                    </span>
                    <RightOutlined style={{ fontSize: 10, color: '#B8B5AC' }} />
                  </div>
                  <Button
                    size="small"
                    icon={<ReloadOutlined />}
                    loading={lpQuery.isFetching}
                    onClick={() => refreshAssets('lp')}
                    disabled={!form.advertiserId}
                  >
                    同步落地页
                  </Button>
                </Space>
              </FormRow>
            )}
          </>
        ) : (
          <>
            {apps.length === 0 && (
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 12 }}
                message="该账户没有可用应用（含共享应用，可点「同步应用」重试）。如确实没有，请到磁力智投「资产-应用中心」绑定，或让应用方在「应用共享」里共享给本账户，无需手填 ID。"
              />
            )}
            <FormRow
              label="推广应用"
              tip="从应用中心同步（含「共享给我的」应用），选中自动带上应用包 ID"
              rowId="fld-appId"
              flash={flashField === 'appId' || flashField === 'packageId'}
            >
              <Space size={8} wrap>
                <Select
                  style={{ width: 300 }}
                  showSearch
                  optionFilterProp="label"
                  placeholder="选应用"
                  value={form.appId ?? undefined}
                  onChange={(v) => {
                    // 选中应用时顺手把 package_id 带上（新版应用中心投放必填）
                    const app = apps.find((a) => a.id === v);
                    const pkg = app?.raw?.package_id;
                    patch({ appId: v, packageId: pkg != null ? String(pkg) : null });
                  }}
                  options={apps.map((a) => ({
                    value: a.id,
                    label:
                      a.raw?.source_type === 2
                        ? `${a.name || a.id}（共享）`
                        : a.name || a.id,
                  }))}
                  notFoundContent={
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {appsQuery.isFetching
                        ? '应用加载中…'
                        : '该账户没有可用应用（含共享应用）'}
                    </Typography.Text>
                  }
                />
                <Button size="small" icon={<ReloadOutlined />} onClick={() => refreshAssets('apps')}>
                  同步应用
                </Button>
              </Space>
            </FormRow>
          </>
        )}

        {/* —— 监测链接包（命名资产：选择即整体套用，支持保存/另存为/删除） —— */}
        <FormRow label="监测链接" tip="可把当前填写的链接存为命名资产，多账户上计划时直接选用">
          <Space size={8} wrap>
            <Select
              style={{ width: 260 }}
              placeholder="选择监测链接"
              value={appliedMonitorId ?? undefined}
              onChange={(v) => applyMonitorPackage(v ?? null)}
              options={(monitorPackagesQuery.data ?? []).map((p) => ({
                value: p.id,
                label: p.note ? `${p.name}（${p.note}）` : p.name,
              }))}
              allowClear
              loading={monitorPackagesQuery.isFetching}
            />
            {appliedMonitorId != null ? (
              <>
                <Button size="small" onClick={updateMonitorCurrent} loading={updateMonitorMutation.isPending}>
                  保存当前
                </Button>
                <Button size="small" onClick={renameMonitor}>
                  重命名
                </Button>
                <Button size="small" onClick={saveMonitorAs}>
                  另存为
                </Button>
                <Button size="small" danger onClick={() => removeMonitorMutation.mutate(appliedMonitorId)}>
                  删除
                </Button>
              </>
            ) : (
              <Button size="small" icon={<PlusOutlined />} onClick={saveMonitorAs}>
                保存为监测链接
              </Button>
            )}
          </Space>
        </FormRow>

        {/* —— 第三方监测链接（创意层下发；优化目标为激活且未接 SDK 时官方必填） —— */}
        <FormRow
          label="点击监测链接"
          tip="第三方点击监测，激活优化目标且未接快手 SDK 时必填；支持 MAC/IMEI/IDFA/IP/TS/CALLBACK 等占位符"
          rowId="fld-clickMonitorUrl"
          flash={flashField === 'clickMonitorUrl'}
        >
          <Space size={6} style={{ width: '100%' }}>
            <Input
              style={{ maxWidth: 380 }}
              value={form.clickMonitorUrl}
              onChange={(e) => patch({ clickMonitorUrl: e.target.value })}
              onBlur={() => pushHistory('plan.clickMonitorUrl', form.clickMonitorUrl)}
              placeholder="https://…（必须 https 开头且含占位符）"
            />
            <HistoryDropdown histKey="plan.clickMonitorUrl" onPick={(v) => patch({ clickMonitorUrl: v })} />
          </Space>
        </FormRow>
        <FormRow
          label="展示监测链接"
          tip="第三方开始播放监测（工作台用常规自定义创意，随 impression_url 下发）"
          rowId="fld-impressionMonitorUrl"
          flash={flashField === 'impressionMonitorUrl'}
        >
          <Space size={6} style={{ width: '100%' }}>
            <Input
              style={{ maxWidth: 380 }}
              value={form.impressionMonitorUrl}
              onChange={(e) => patch({ impressionMonitorUrl: e.target.value })}
              onBlur={() => pushHistory('plan.impressionMonitorUrl', form.impressionMonitorUrl)}
              placeholder="https://…"
            />
            <HistoryDropdown histKey="plan.impressionMonitorUrl" onPick={(v) => patch({ impressionMonitorUrl: v })} />
          </Space>
        </FormRow>
      </Drawer>

      {/* ================= 弹窗区 ================= */}

      {/* 素材选择弹窗 */}
      <VideoPickerModal
        open={videoModalOpen}
        onClose={() => setVideoModalOpen(false)}
        videos={videos}
        loading={videosQuery.isLoading}
        selected={selectedVideos}
        onChange={setSelectedVideos}
      />

      {/* 落地页选择弹窗（销售线索建站页） */}
      <LpPickerModal
        open={lpModalOpen}
        onClose={() => setLpModalOpen(false)}
        pages={lpPages}
        loading={lpQuery.isLoading}
        value={form.siteId}
        onOk={(id) => {
          patch({ siteId: id });
          setLpModalOpen(false);
        }}
      />

      {/* 下载中间页选择弹窗（应用落地页下载） */}
      <LpPickerModal
        open={downloadLpOpen}
        onClose={() => setDownloadLpOpen(false)}
        pages={lpPages}
        loading={lpQuery.isLoading}
        value={form.downloadSiteId}
        onOk={(id) => {
          patch({ downloadSiteId: id });
          setDownloadLpOpen(false);
        }}
      />

      {/* 文案添加弹窗 */}
      <Modal
        title="添加文案"
        open={copyModalOpen}
        onCancel={() => setCopyModalOpen(false)}
        onOk={addCopies}
        okText="添加"
        width={520}
      >
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Space size={6} style={{ width: '100%' }} wrap>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              文案包：
            </Typography.Text>
            <Select
              style={{ width: 220 }}
              placeholder="载入文案包"
              onChange={(id) => {
                const pkg = (copyPackagesQuery.data ?? []).find((p) => p.id === id);
                if (pkg?.titles?.length) setCopyText(pkg.titles.join('\n'));
              }}
              options={(copyPackagesQuery.data ?? []).map((p) => ({
                value: p.id,
                label: `${p.name}（${p.titles.length} 条）`,
              }))}
              allowClear
              value={undefined}
              loading={copyPackagesQuery.isFetching}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              历史：
            </Typography.Text>
            <HistoryDropdown
              histKey="plan.copies"
              onPick={(v) => setCopyText((prev) => (prev ? `${prev}\n${v}` : v))}
            />
          </Space>
          <Input.TextArea
            rows={5}
            value={copyText}
            onChange={(e) => setCopyText(e.target.value)}
            placeholder={'一行一条，每条不超过 30 字\n今日开服，限时福利\n新手礼包免费领'}
            maxLength={2000}
          />
          <Checkbox
            checked={copyFromNames}
            disabled={selectedVideoItems.length === 0}
            onChange={(e) => setCopyFromNames(e.target.checked)}
          >
            同时使用素材名作为文案（已选 {selectedVideoItems.length} 个素材）
          </Checkbox>
        </Space>
      </Modal>

      {/* 预览弹窗：纯文字紧凑清单，无需下滑即可见提交按钮 */}
      <Modal
        title={
          <Space size={12}>
            <span>预览广告组</span>
            <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
              {previewRows.length} 计划 ·{' '}
              {previewRows.reduce(
                (n, r) => n + (r.units?.length ?? Math.max(r.unitsPerCampaign ?? 1, 1)),
                0,
              )}{' '}
              组 ·{' '}
              {previewRows.reduce(
                (n, r) =>
                  n +
                  (r.units
                    ? r.units.reduce((m, u) => m + u.videos.length, 0)
                    : (r.unitsPerCampaign ?? 1) * (r.creativeVideos?.length ?? 1)),
                0,
              )}{' '}
              创意
            </Typography.Text>
          </Space>
        }
        open={previewOpen}
        onCancel={() => setPreviewOpen(false)}
        width={640}
        styles={{ body: { maxHeight: '56vh', overflowY: 'auto', paddingBlock: 8 } }}
        footer={
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              创建后计划为暂停状态（组和创意默认开启，不会消耗；平台上开启计划即投放）
            </Typography.Text>
            <div style={{ flex: 1 }} />
            <Button onClick={() => setPreviewOpen(false)}>返回修改</Button>
            <Button type="primary" onClick={confirmGenerate} style={{ marginLeft: 8 }}>
              确认生成
            </Button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {previewRows.map((row, i) => {
            const creativeCount = row.units
              ? row.units.reduce((n, u) => n + u.videos.length, 0)
              : (row.creativeVideos?.length ?? 1);
            const unitLabel = row.units?.length
              ? row.units.map((u) => u.unitName).join('、')
              : row.unitName;
            return (
              <div
                key={i}
                style={{
                  fontSize: 12.5,
                  lineHeight: '20px',
                  padding: '5px 8px',
                  borderRadius: 6,
                  background: i % 2 === 0 ? '#FAF9F6' : 'transparent',
                }}
              >
                <div>
                  <b>#{i + 1}</b> 计划：{row.campaignName}
                  {accounts.length > 1 && (
                    <span style={{ color: BRAND }}>
                      {' '}· {accounts.find((a) => a.advertiserId === row.advertiserId)?.accountName ?? row.advertiserId}
                    </span>
                  )}
                  <span style={{ color: '#888780' }}>
                    {' '}· 预算 {row.campaignDayBudgetYuan ? `${row.campaignDayBudgetYuan} 元/天` : '不限'}
                  </span>
                </div>
                <div style={{ color: '#888780', fontSize: 12 }}>
                  组：{unitLabel}
                  {' '}· 出价：
                  <span style={{ color: BRAND }}>
                    {row.bidType === 12
                      ? '最大转化'
                      : row.bidType === 2
                        ? `CPC ${row.bidYuan ?? '?'} 元`
                        : `oCPM ${row.cpaBidYuan ?? '?'} 元`}
                  </span>
                  {ocpxLabel && ` · 优化目标：${ocpxLabel}`}
                  {` · ${creativeCount} 创意`}
                </div>
              </div>
            );
          })}
        </div>
      </Modal>
    </div>
  );
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 官方式分区卡片：标题带左侧色条，正文行距统一 */
function SectionCard(props: {
  title: string;
  extra?: React.ReactNode;
  children: React.ReactNode;
  /** 错误定位锚点（如 fld-description） */
  rowId?: string;
  flash?: boolean;
}) {
  const { title, extra, children, rowId, flash } = props;
  return (
    <Card
      size="small"
      id={rowId}
      style={{
        borderRadius: 10,
        marginBottom: 10,
        ...(flash
          ? { border: `1px solid ${BRAND}`, boxShadow: '0 0 0 2px rgba(255,79,0,0.25)' }
          : {}),
      }}
      styles={{ body: { paddingTop: 10 } }}
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              width: 3,
              height: 14,
              borderRadius: 2,
              background: BRAND,
              display: 'inline-block',
            }}
          />
          <span style={{ fontSize: 14 }}>{title}</span>
        </div>
      }
      extra={extra}
    >
      {children}
    </Card>
  );
}

/** mobgi 式摘要卡：两列「键：值」小字 + 右上角编辑按钮 */
function SummaryCard(props: {
  title: string;
  onEdit: () => void;
  children: React.ReactNode;
}) {
  const { title, onEdit, children } = props;
  return (
    <Card
      size="small"
      style={{ borderRadius: 10, marginBottom: 12 }}
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              width: 3,
              height: 14,
              borderRadius: 2,
              background: BRAND,
              display: 'inline-block',
            }}
          />
          <span style={{ fontSize: 14 }}>{title}</span>
        </div>
      }
      extra={
        <Button size="small" icon={<EditOutlined />} onClick={onEdit}>
          编辑
        </Button>
      }
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          columnGap: 24,
          rowGap: 2,
        }}
      >
        {children}
      </div>
    </Card>
  );
}

/** 摘要行：左灰标签 + 右值（超长省略，悬停可见全文靠外层 Tooltip 场景） */
function SumItem(props: { k: string; v: string }) {
  const { k, v } = props;
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', minWidth: 0, padding: '2px 0' }}>
      <span
        style={{
          width: 76,
          flexShrink: 0,
          fontSize: 12,
          color: '#888780',
        }}
      >
        {k}
      </span>
      <Tooltip title={v}>
        <span
          style={{
            fontSize: 12.5,
            color: '#37352F',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {v}
        </span>
      </Tooltip>
    </div>
  );
}

function defaultPrefix(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `批量_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/** 命名规则通配符快捷插入（对齐 mobgi 磁力通配符：序号/日期/时间） */
function NameTplChips(props: { tpl: string; onChange: (next: string) => void }) {
  return (
    <Space size={8} wrap>
      {(['[序号]', '[日期]', '[时间]'] as const).map((tk) => (
        <Tag
          key={tk}
          style={{ cursor: 'pointer' }}
          onClick={() => props.onChange(`${props.tpl}${tk}`)}
        >
          + {tk.slice(1, -1)}
        </Tag>
      ))}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        提交时自动替换：序号按链路递增，日期取排期开始日，时间取生成时刻
      </Typography.Text>
    </Space>
  );
}
