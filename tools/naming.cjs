/**
 * 统一命名规则（2026-11-23 用户拍板）
 *
 *   计划/组名 = PZ<户号>-<素材批次>-<出价方式>-<投放类型>-<转化目标>-<MMDD>
 *   例：PZ618-新素材-最大转化-常规-激活-1123
 *
 * 为什么这么长：报表和平台后台都按名字排序/筛选，标题里缺维度就得回平台一条条点开看，
 * 所以出价方式、投放类型、转化目标必须写进名字。
 *
 * 标签表在下面，改词只改这里，三个建计划脚本自动跟着变。
 */

const BID_MODE = {
  /** bid_type 1 / 12：最大转化出价（MCB），不设目标成本 */
  MCB: '最大转化',
  /** bid_type 2 / 10：按目标转化成本出价（cpa_bid） */
  OCPX: '出价',
};

const DELIVERY = {
  /** 常规广告（站内信息流，版位 [6] 上下滑大屏） */
  NORMAL: '常规',
  /** UAX 自动搭建（auto_build=1） */
  UAX: 'UAX',
};

/** 转化目标：ocpx_action_type → 名称 */
const ACTION = {
  180: '激活',
  190: '付费',
  346: '次留',
  324: '唤起应用',
  2: '点击',
};

/**
 * 拼计划/组名。
 * @param {object} o
 * @param {string|number} o.tag     户号尾号（386 / 387 / 618）
 * @param {string} o.batch          素材批次：新素材 / 跑量复投 / 晚高峰
 * @param {'MCB'|'OCPX'} [o.bidMode] 出价方式，默认 MCB
 * @param {'NORMAL'|'UAX'} [o.delivery] 投放类型，默认 NORMAL
 * @param {number|string} [o.action] 转化目标（ocpx_action_type 或中文），默认 180 激活
 * @param {string} o.date           日期戳 MMDD
 */
function planName({ tag, batch, bidMode = 'MCB', delivery = 'NORMAL', action = 180, date }) {
  const parts = [
    `PZ${tag}`,
    batch,
    BID_MODE[bidMode] || String(bidMode),
    DELIVERY[delivery] || String(delivery),
    ACTION[Number(action)] || String(action),
    date,
  ];
  return parts.filter(Boolean).join('-');
}

/**
 * 同计划下多个组：第 1 个用主名，第 2 个起加 -02 / -03。
 * @param {string} base 计划名（= 主组名）
 * @param {number} index 0-based
 */
function unitName(base, index = 0) {
  if (!index) return base;
  return `${base}-${String(index + 1).padStart(2, '0')}`;
}

/** 创意名 = 素材名去扩展名（便于报表按素材归因） */
function creativeName(materialName) {
  return String(materialName || '')
    .replace(/\.(mp4|mov|m4v|avi|mkv)$/i, '')
    .trim();
}

module.exports = { planName, unitName, creativeName, BID_MODE, DELIVERY, ACTION };
