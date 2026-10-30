import { PlanRow } from '@wkbd/shared';

/**
 * 创编行的默认值。
 *
 * 抽成独立模块的原因：默认值不只被表格用，粘贴解析、行复制也都要用，
 * 而它们对「什么算合理默认」必须完全一致——否则粘贴进来的行与手工新增的行
 * 会出现隐蔽差异（比如 ocpxActionType 一个有一个没有），排查起来很痛苦。
 */
export function tomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 当天日期（长期投放的开始日期每次打开取当天，避免写死过期） */
export function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 营销目标的默认优化目标——不同目标下可选项不同，给一个合理起点 */
function defaultOcpxActionType(campaignType: number): number {
  if (campaignType === 2) return 180; // 激活数
  if (campaignType === 7) return 324; // 唤起应用
  return 53; // 表单数（销售线索）
}

export function defaultRow(
  campaignType: number,
  advertiserId: string,
  rowNo: number,
): PlanRow {
  return {
    rowNo,
    advertiserId,
    campaignName: '',
    campaignType,
    adType: 0,
    campaignDayBudgetYuan: null,
    campaignBidType: 0,
    unitName: '',
    bidType: 10,
    bidYuan: null,
    cpaBidYuan: null,
    ocpxActionType: defaultOcpxActionType(campaignType),
    sceneIds: [1],
    unitType: 4,
    beginTime: tomorrow(),
    endTime: null,
    unitDayBudgetYuan: null,
    region: [],
    gender: 0,
    agesRange: null,
    platformOs: 0,
    network: 0,
    appId: null,
    packageId: null,
    webUriType: campaignType === 5 ? 1 : null,
    url: null,
    siteId: null,
    groupId: null,
    schemaUri: null,
    creativeName: '',
    materialType: 1,
    photoId: null,
    imageToken: null,
    imageTokens: null,
    actionBarText: campaignType === 2 ? '立即下载' : '了解详情',
    description: null,
  };
}

/* ------------------------------------------------------------------
 * 从 Excel 粘贴的解析
 *
 * 这一段的复杂度全部来自现实：投手从 Excel 复制出来的内容，
 * 列顺序、列数量、有没有表头都不确定。所以策略是：
 *   1. 第一行只要有任何一格能对上列名别名 → 视为表头，按列名映射
 *   2. 否则按固定列序映射（并在界面上把这个顺序明确写给用户看）
 *   3. 空单元格一律「跳过」而不是写空值——跳过会用默认值，
 *      写空值会把默认值覆盖成空，反而让用户拿到一堆校验错误
 * ---------------------------------------------------------------- */
const HEADER_ALIASES: Record<string, keyof PlanRow> = {
  账户: 'advertiserId',
  账户id: 'advertiserId',
  advertiser_id: 'advertiserId',
  计划名: 'campaignName',
  计划名称: 'campaignName',
  campaign_name: 'campaignName',
  组名: 'unitName',
  广告组名称: 'unitName',
  unit_name: 'unitName',
  创意名: 'creativeName',
  创意名称: 'creativeName',
  creative_name: 'creativeName',
  出价类型: 'bidType',
  bid_type: 'bidType',
  出价: 'cpaBidYuan',
  出价元: 'cpaBidYuan',
  优化目标: 'ocpxActionType',
  ocpx_action_type: 'ocpxActionType',
  开始日期: 'beginTime',
  begin_time: 'beginTime',
  组预算: 'unitDayBudgetYuan',
  组预算元: 'unitDayBudgetYuan',
  应用id: 'appId',
  app_id: 'appId',
  应用包id: 'packageId',
  落地页形态: 'webUriType',
  链接: 'url',
  投放链接: 'url',
  建站id: 'siteId',
  素材类型: 'materialType',
  素材id: 'photoId',
  行动号召: 'actionBarText',
  广告语: 'description',
};

/** 无表头时的列序（会展示在界面上，改动必须同步 UI 文案） */
export function pasteColumnOrder(campaignType: number): Array<keyof PlanRow> {
  return [
    'advertiserId',
    'campaignName',
    'unitName',
    'creativeName',
    'bidType',
    'cpaBidYuan',
    'ocpxActionType',
    'beginTime',
    'unitDayBudgetYuan',
    campaignType === 5 ? 'webUriType' : 'appId',
    campaignType === 5 ? 'url' : 'packageId',
    'materialType',
    'photoId',
    'actionBarText',
  ];
}

const TEXT_FIELDS = new Set<keyof PlanRow>([
  'advertiserId',
  'campaignName',
  'unitName',
  'creativeName',
  'beginTime',
  'url',
  'siteId',
  'appId',
  'packageId',
  'photoId',
  'actionBarText',
  'description',
]);

const NUMBER_FIELDS = new Set<keyof PlanRow>([
  'bidType',
  'ocpxActionType',
  'webUriType',
  'materialType',
  'adType',
]);

const MONEY_FIELDS = new Set<keyof PlanRow>([
  'cpaBidYuan',
  'unitDayBudgetYuan',
  'campaignDayBudgetYuan',
]);

/**
 * 解析粘贴文本为行数据。
 * @param text 粘贴内容（TSV / 制表符分隔）
 * @param campaignType 当前营销目标，决定链路列
 * @param defaultAccount 未填账户时的兜底账户
 */
export function parsePasted(
  text: string,
  campaignType: number,
  defaultAccount: string,
): PlanRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  const splitLine = (line: string) => line.split('\t').map((c) => c.trim());
  const first = splitLine(lines[0]);
  const hasHeader = first.some((c) => HEADER_ALIASES[c.toLowerCase()] !== undefined);
  const body = hasHeader ? lines.slice(1) : lines;

  const order = hasHeader
    ? first.map((c) => HEADER_ALIASES[c.toLowerCase()]).filter((f): f is keyof PlanRow => Boolean(f))
    : pasteColumnOrder(campaignType);

  const num = (v: string): number | null => {
    if (v === '' || v === undefined || v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  return body.map((line, index) => {
    const cells = splitLine(line);
    const row = defaultRow(campaignType, defaultAccount, index + 1);
    // PlanRow 是强类型，这里是动态赋值的场景，集中做一次受控写入
    const setField = (field: keyof PlanRow, value: unknown) => {
      (row as unknown as Record<string, unknown>)[field] = value;
    };

    order.forEach((field, i) => {
      const raw = cells[i] ?? '';
      if (raw === '') return;
      if (TEXT_FIELDS.has(field)) setField(field, raw);
      else if (NUMBER_FIELDS.has(field)) setField(field, num(raw) ?? row[field]);
      else if (MONEY_FIELDS.has(field)) setField(field, num(raw));
    });

    return row;
  });
}
