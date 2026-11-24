/* eslint-disable */
/**
 * 快手投放 · 盯盘巡检 + 钉钉推送
 *
 *   node tools/monitor.cjs            # 巡检一次（异常才推，含 2 小时心跳）
 *   node tools/monitor.cjs --dry      # 只打印卡片，不推送
 *   node tools/monitor.cjs --daily    # 09:30 昨日复盘 + 今日基建清单
 *   node tools/monitor.cjs --eod      # 23:30 日终小结
 *
 * 只报警为主；自动执行（关停/调价）按 config.autoExecute 授权档位由 auto-exec.cjs 执行。数据全部取自本地 7801 后端（同源事实）。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const autoExec = require('./auto-exec.cjs');
const autoBudget = require('./auto-budget.cjs');
const { ensureBackend, ensureWatchdog } = require('./ensure-backend.cjs');
const autoEffects = require('./auto-effects.cjs');

const ROOT = path.join(__dirname, '..');
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'monitor.config.json'), 'utf-8'));
const RUNTIME = path.join(ROOT, '.runtime');
const STATE_FILE = path.join(RUNTIME, 'monitor-state.json');
const LOG_FILE = path.join(RUNTIME, 'monitor.log');

if (!fs.existsSync(RUNTIME)) fs.mkdirSync(RUNTIME, { recursive: true });

const MODE = process.argv.includes('--daily') ? 'daily' : process.argv.includes('--eod') ? 'eod' : 'watch';
const DRY = process.argv.includes('--dry');

/* ---------------- 基础工具 ---------------- */
const now = () => new Date();
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d = now()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d = now()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const md = (d = now()) => `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const yuan = (n) => (n == null ? '-' : Number(n).toFixed(2));
const pct = (n) => (n == null ? '-' : (Number(n) * 100).toFixed(2) + '%');

function log(line) {
  const text = `[${ymd()} ${hm()}:${pad(now().getSeconds())}] ${line}`;
  fs.appendFileSync(LOG_FILE, text + '\n');
}

async function api(p, body) {
  const res = await fetch(CFG.api + p, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`${p} → HTTP ${res.status} ${txt.slice(0, 200)}`);
  try {
    return JSON.parse(txt);
  } catch {
    throw new Error(`${p} → 非 JSON 响应`);
  }
}

/* ---------------- 状态（去重 / 持续时长） ---------------- */
const state = fs.existsSync(STATE_FILE)
  ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'))
  : { sent: {}, firstSeen: {} };
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));

/* ---------------- 数据拉取 ---------------- */
// 快手信息流分时段消费权重（0-23 点，经验曲线，用于判断消耗进度是否正常）
const HOUR_WEIGHT = [2, 1.2, 0.8, 0.6, 0.5, 0.6, 1, 1.8, 2.8, 3.8, 4.8, 5.2, 5.5, 5.4, 5, 4.8, 4.8, 5, 5.4, 5.8, 6.2, 6.4, 6.2, 5.8];
const WEIGHT_SUM = HOUR_WEIGHT.reduce((a, b) => a + b, 0);
function paceExpected(hour) {
  let s = 0;
  for (let i = 0; i <= Math.min(hour, 23); i += 1) s += HOUR_WEIGHT[i];
  return s / WEIGHT_SUM;
}

async function accountMetrics(dateStr) {
  const out = [];
  for (const acc of CFG.accounts) {
    try {
      const r = await api('/api/report/level/account', {
        advertiserId: acc.id,
        startDate: dateStr,
        endDate: dateStr,
        page: 1,
        pageSize: 5,
      });
      const row = (r.rows || [])[0] || {};
      out.push({
        ...acc,
        charge: Number(row.charge || 0),
        show: Number(row.show || 0),
        aclick: Number(row.aclick || 0),
        bclick: Number(row.bclick || 0),
        activation: Number(row.activation || 0),
        cpa: Number(row.activation || 0) > 0 && row.activationCost != null ? Number(row.activationCost) : null,
        ctr: row.actionRatio != null ? Number(row.actionRatio) : null,
        cpm: row.impression1kCost != null ? Number(row.impression1kCost) : null,
      });
    } catch (e) {
      out.push({ ...acc, error: String(e.message).slice(0, 160) });
    }
  }
  return out;
}

/** 账户 ID → 平台账户名（报告里一律用账户名，不用内部代号） */
let _accNames = null;
async function accountNameMap() {
  if (_accNames) return _accNames;
  const map = new Map();
  try {
    const r = await api('/api/oauth/accounts');
    const list = Array.isArray(r) ? r : r.items || r.accounts || [];
    for (const a of list) {
      const id = a.advertiserId || a.id;
      if (id) map.set(String(id), String(a.accountName || a.name || id));
    }
  } catch (e) {
    log(`账户名拉取失败（退回代号）：${e.message}`);
  }
  _accNames = map;
  return map;
}

/**
 * 给 metrics 挂名字：
 *   m.name     = 短显示名（配置 shortName 优先；没配就用平台账户名，再退化到代号）
 *   m.fullName = 平台完整账户名（只作追溯，不进卡片，避免标题过长）
 */
function applyAccountNames(metrics, names) {
  const short = new Map(CFG.accounts.map((a) => [String(a.id), a.shortName]));
  for (const m of metrics) {
    const full = names.get(String(m.id)) || '';
    m.fullName = full;
    m.name = short.get(String(m.id)) || full || m.tag || m.id;
  }
  return metrics;
}

/**
 * 计划详情：名称 / 日预算 / 出价方式 / 投放状态。
 * 平台列表接口必须带 ids，所以先用「本地任务库 + 今日有消耗的计划」拼出 ids 再回读。
 */
async function loadCampaignBrief(accId, extraIds = []) {
  const map = new Map();
  const ids = new Set(extraIds.map(String));
  try {
    const { PrismaClient } = require(path.join(ROOT, 'node_modules/@prisma/client'));
    const dbFile = path.join(process.env.APPDATA || process.env.HOME || '', '快手投放工作台', 'app.db');
    const prisma = new PrismaClient({ datasources: { db: { url: 'file:' + dbFile } } });
    try {
      const items = await prisma.batchTaskItem.findMany({
        where: {
          advertiserId: String(accId),
          level: 'CAMPAIGN',
          platformId: { not: null },
          createdAt: { gte: new Date(Date.now() - 14 * 86400e3) },
        },
        select: { platformId: true, displayName: true },
      });
      for (const it of items) if (it.platformId) ids.add(String(it.platformId));
    } finally {
      await prisma.$disconnect();
    }
  } catch (e) {
    log(`本地计划清单读取失败：${e.message}`);
  }
  if (!ids.size) return map;
  try {
    const rows = await api('/api/manage/structure/by-ids', {
      advertiserId: String(accId),
      level: 'campaign',
      ids: [...ids],
    });
    for (const r of rows || []) {
      const raw = r.raw || {};
      const bidType = r.bidType == null ? null : Number(r.bidType);
      const bidYuan = Number(r.bidYuan || 0);
      const dayBudget = Number(r.dayBudgetYuan || 0);
      map.set(String(r.id), {
        id: String(r.id),
        name: String(r.name || '').trim() || `计划${String(r.id).slice(-6)}`,
        putStatus: r.putStatus,
        putStatusText: r.putStatusText || (r.putStatus === 1 ? '投放中' : '暂停'),
        dayBudgetYuan: dayBudget,
        bidType,
        bidYuan,
        createTime: raw.create_time || null,
        // 最大转化（MCB）：无出价，靠预算控成本；bid_type 1/12 或「预算>0 且出价=0」
        isMcb: [1, 12].includes(bidType) || (bidYuan === 0 && dayBudget > 0),
      });
    }
  } catch (e) {
    log(`计划详情回读失败：${e.message}`);
  }
  return map;
}

async function creativeRows(accId, dateStr) {  const rows = [];
  for (let page = 1; page <= 20; page += 1) {
    const r = await api('/api/report/level/creative', {
      advertiserId: accId,
      startDate: dateStr,
      endDate: dateStr,
      page,
      pageSize: 200,
    });
    const batch = r.rows || [];
    rows.push(...batch);
    if (rows.length >= (r.totalCount || 0) || batch.length === 0) break;
  }
  return rows;
}

async function budgetOf(accId) {
  try {
    const r = await api('/api/manage/advertiser-budget/get', { advertiserId: accId });
    return Number(r.day_budget || 0) / 1000; // 厘 → 元（1 元 = 1000 厘）
  } catch {
    return CFG.dailyBudgetYuan;
  }
}

/** 创意 ID → 创意名（平台报表不带名字，靠层级列表补齐） */
async function creativeNameMap(accId) {
  const map = new Map();
  try {
    const r = await api('/api/manage/structure', { advertiserId: accId, level: 'CAMPAIGN' });
    const items = r.items || r || [];
    for (const it of items) if (it.id && it.name) map.set(String(it.id), String(it.name));
  } catch {
    /* 拿不到名字就退化成 ID，不影响规则判定 */
  }
  return map;
}

async function grantsStatus() {
  try {
    const r = await api('/api/oauth/grants');
    const list = Array.isArray(r) ? r : r.grants || r.items || [];
    return list.map((g) => ({ id: g.id, status: g.status, lastError: g.lastError }));
  } catch {
    return null;
  }
}

/** 近 N 天报表里出现过的计划 ID（用来补「今天零消耗但仍在投」的计划） */
async function recentCampaignIds(accId, days = 3, endDate = ymd()) {
  const ids = new Set();
  try {
    const start = ymd(new Date(Date.now() - days * 86400e3));
    const r = await api('/api/report/level/campaign', {
      advertiserId: accId,
      startDate: start,
      endDate,
      page: 1,
      pageSize: 200,
    });
    for (const x of r.rows || []) if (x.campaignId) ids.add(String(x.campaignId));
  } catch (e) {
    log(`近 ${days} 天计划 ID 拉取失败：${e.message}`);
  }
  return [...ids];
}

async function campaignRows(accId, dateStr) {
  const rows = [];
  for (let page = 1; page <= 10; page += 1) {
    const r = await api('/api/report/level/campaign', {
      advertiserId: accId,
      startDate: dateStr,
      endDate: dateStr,
      page,
      pageSize: 200,
    });
    const batch = r.rows || [];
    rows.push(...batch);
    if (rows.length >= (r.totalCount || 0) || batch.length === 0) break;
  }
  return rows;
}

/* ---------------- 规则引擎 ---------------- */
const T = CFG.thresholds;
const L = CFG.learning;

/** oCPX 学习期分级：靠累计激活数判断，不看挂了多少小时 */
function stageOf(act) {
  if (act < L.observeMaxAct) return 'OBSERVE';
  if (act < L.rampMaxAct) return 'RAMP';
  return 'MATURE';
}
const STAGE_TEXT = { OBSERVE: '观察期', RAMP: '爬坡期', MATURE: '成熟期' };

/** 网络类错误提示：区分「代理劫持」和「授权失效」 */
function netHint(msg) {
  return /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|timeout/i.test(String(msg))
    ? '（平台域名不可达：多半是代理/VPN 劫持 DNS，解析到了 198.18.x.x 假地址）'
    : '';
}

/** 计划级成本判定（真正的成本结论只下在计划级别，不下在账户级别） */
function evalCampaignCost(accName, row, name, brief = {}) {
  const out = [];
  const charge = Number(row.charge || 0);
  const act = Number(row.activation || 0);
  const cpa = act > 0 && row.activationCost != null ? Number(row.activationCost) : null;
  const cid = String(row.campaignId || '');
  const stage = stageOf(act);
  // 最大转化计划没有出价，任何「调价」建议都不成立，只能动预算/素材/开关
  const priceHint = brief.isMcb ? '降预算 10%~20%' : '降出价 10%';

  // 空耗：任何阶段都判（不是成本问题，是完全不转化）
  if (act === 0 && charge >= L.emptySpendCharge) {
    out.push({ key: `P0-${cid}`, sev: 'YEL', code: 'P0', mcb: !!brief.isMcb, w: charge, text: `「${name}」消耗 ${yuan(charge)} 仍 0 激活 → 建议关停（${L.emptySpendCharge} 元空耗线）` });
    return out;
  }
  if (cpa == null) return out;

  if (stage === 'OBSERVE') {
    // 观察期：只记录，不下成本结论
    return out;
  }
  if (stage === 'RAMP') {
    if (cpa > L.cpaRampHard && charge >= L.cpaRampHardMinCharge) {
      out.push({ key: `P3-${cid}`, sev: 'YEL', code: 'P3', mcb: !!brief.isMcb, w: charge, text: `「${name}」爬坡期成本偏高：CPA ${yuan(cpa)} > ${L.cpaRampHard}（激活 ${act}/${L.rampMaxAct}）→ 再观察到 ${L.rampMaxAct} 个激活，暂不关停` });
    } else if (cpa > L.cpaRampWarn) {
      out.push({ key: `P2-${cid}`, sev: 'GOOD', code: 'P2', mcb: !!brief.isMcb, w: 0, text: `「${name}」爬坡期：CPA ${yuan(cpa)}（激活 ${act}），容忍线 ${L.cpaRampWarn}，继续观察` });
    }
    return out;
  }
  // 成熟期：恢复正常红线
  if (cpa > L.cpaMatureRed && charge >= L.cpaMatureRedMinCharge) {
    out.push({ key: `P5-${cid}`, sev: 'RED', code: 'P5', mcb: !!brief.isMcb, w: charge, text: `「${name}」成熟期成本超标：CPA ${yuan(cpa)} > ${L.cpaMatureRed}（激活 ${act}，消耗 ${yuan(charge)}）→ ${priceHint}，仍不达标就关停` });
  } else if (cpa > L.cpaMatureWarn) {
    out.push({ key: `P4-${cid}`, sev: 'YEL', code: 'P4', mcb: !!brief.isMcb, w: charge, text: `「${name}」成熟期成本偏高：CPA ${yuan(cpa)} > ${L.cpaMatureWarn}（激活 ${act}）→ ${priceHint}` });
  }
  return out;
}

function evalAccount(a, budgetYuan, hour, pace, opts = {}) {
  const alerts = [];
  const who = a.name || a.tag;
  const mcb = !!opts.mcb; // 账户主力是最大转化计划 → 不提「出价」
  const expCharge = budgetYuan * pace;
  if (a.error) {
    alerts.push({ key: `A0-${a.id}`, sev: 'RED', code: 'A0', mcb, text: `${who} 数据拉取失败：${a.error}${netHint(a.error)}` });
    return alerts;
  }
  // A5 回传异常（持续判定）
  if (a.bclick >= T.clickNoConvCount && a.activation === 0 && hour >= 10) {
    const key = `A5-${a.id}`;
    if (!state.firstSeen[key]) state.firstSeen[key] = Date.now();
    const mins = (Date.now() - state.firstSeen[key]) / 60000;
    if (mins >= T.clickNoConvMinutes) {
      alerts.push({ key, sev: 'RED', code: 'A5', mcb, text: `回传异常：点击 ${a.bclick} 但激活 0，已持续 ${Math.round(mins)} 分钟` });
    }
  } else {
    delete state.firstSeen[`A5-${a.id}`];
  }
  // A4 账户级空耗（整户 60 元仍 0 激活才算异常）
  if (a.charge >= L.accountEmptySpendCharge && a.activation === 0) {
    alerts.push({ key: `A4-${a.id}`, sev: 'RED', code: 'A4', mcb, text: `全户空耗：消耗 ${yuan(a.charge)} 元仍 0 激活` });
  }
  // A3 账户级成本：只做提示，真正的判定在计划级别（账户里混着老计划，不能一刀切）
  if (stageOf(a.activation) !== 'OBSERVE' && a.cpa != null && a.cpa > L.cpaMatureWarn) {
    alerts.push({ key: `A3-${a.id}`, sev: 'YEL', code: 'A3', mcb, text: `账户综合 CPA ${yuan(a.cpa)}（激活 ${a.activation}）——仅提示，成本判定看计划级` });
  }
  // A1 / A2 消耗进度（账户没跑起来时不算「滞后」，单列 A1b）
  if (hour >= 12) {
    if (a.charge === 0) {
      alerts.push({ key: `A1b-${a.id}`, sev: 'RED', code: 'A1', mcb, text: `全天 0 消耗：计划可能未开启/审核未过/素材被拒` });
    } else if (a.charge >= CFG.bidYuan * 3 && budgetYuan > 0) {
      const ratio = a.charge / Math.max(expCharge, 1);
      if (ratio < T.paceLow && !mcb) {
        // 最大转化由系统控速，节奏慢不是异常，也不提任何「加价」——干脆不报
        alerts.push({ key: `A1-${a.id}`, sev: 'YEL', code: 'A1', mcb, text: `投放节奏偏慢：已花 ${yuan(a.charge)}，按进度应花 ${yuan(expCharge)}（${Math.round(ratio * 100)}%）` });
      }
      if (ratio > T.paceHigh) {
        alerts.push({ key: `A2-${a.id}`, sev: 'YEL', code: 'A2', mcb, text: `消耗偏快：已花 ${yuan(a.charge)}，进度应花 ${yuan(expCharge)}（${Math.round(ratio * 100)}%）` });
      }
    }
  }
  if (hour < T.budgetHitAt && budgetYuan > 0 && a.charge >= budgetYuan * 0.95) {
    alerts.push({ key: `A2b-${a.id}`, sev: 'RED', code: 'A2', mcb, text: `计划池将用尽：已花 ${yuan(a.charge)} / ${yuan(budgetYuan)}，现在才 ${hm()}` });
  }
  return alerts;
}

/**
 * 账户级预算只看「合计 5000」，单户额度可调拨（2026-11-10 用户口径）。
 * 单户 2500 只是初始切分，不是硬约束；撞线但合计还有额度 → 提示调拨，不报警停投。
 */
function allocOf(accId) {
  const plan = { ...(CFG.budgetPlan || {}), ...autoBudget.currentPlan() };
  return Number(plan[accId] || CFG.dailyBudgetYuan);
}

function evalTotal(metrics, budgets, hour, pace) {
  const alerts = [];
  // 单账户不存在「跨户调拨」这回事，合计口径会和账户口径重复（用户明确要求别再造一个总预算）
  if (CFG.accounts.length < 2) return alerts;
  const TOTAL = Number(CFG.totalBudgetYuan || CFG.dailyBudgetYuan * CFG.accounts.length);
  const ok = metrics.filter((m) => !m.error);
  if (!ok.length) return alerts;
  const total = ok.reduce((s, m) => s + (m.charge || 0), 0);
  const exp = TOTAL * pace;

  // T1 合计进度（12 点后、量跑起来才判）
  if (hour >= 12 && total >= CFG.bidYuan * 3) {
    const ratio = total / Math.max(exp, 1);
    if (ratio > T.paceHigh) {
      alerts.push({ key: 'AT-fast', sev: 'YEL', code: 'A2', text: `合计消耗偏快：${yuan(total)} / 进度应花 ${yuan(exp)}（${Math.round(ratio * 100)}%）· 总预算 ${TOTAL}` });
    } else if (ratio < T.paceLow) {
      alerts.push({ key: 'AT-slow', sev: 'YEL', code: 'A1', text: `合计消耗滞后：${yuan(total)} / 进度应花 ${yuan(exp)}（${Math.round(ratio * 100)}%）· 总预算 ${TOTAL}` });
    }
  }
  // T2 合计撞线
  if (hour < T.budgetHitAt && total >= TOTAL * 0.95) {
    alerts.push({ key: 'AT-hit', sev: 'RED', code: 'A2', text: `合计预算将撞线：${yuan(total)} / ${TOTAL}，现在才 ${hm()}——要放量得加总预算，单户调拨已无用` });
  }

  // T3 单户撞线但合计还有额度 → 建议调拨（不是异常，是结构问题）
  for (const m of ok) {
    const b = Number(budgets[m.id] || allocOf(m.id));
    if (hour < T.budgetHitAt && b > 0 && m.charge >= b * 0.95 && total < TOTAL * 0.9) {
      const others = ok.filter((x) => x.id !== m.id);
      const otherCharge = others.reduce((s, x) => s + (x.charge || 0), 0);
      const slack = Math.max(0, Math.round((TOTAL - total) / 100) * 100);
      alerts.push({
        key: `AT-perhit-${m.id}`, sev: 'RED', code: 'A7',
        text: `${m.name || m.tag} 单户额度将用尽（${yuan(m.charge)}/${b}），但合计只花了 ${yuan(total)}/${TOTAL}（另一户 ${yuan(otherCharge)}）→ 可把额度从另一户调 ${slack} 元过来，不用停投`,
      });
    }
  }

  // T4 结构性失衡：消耗占比 vs 额度占比 偏离过大 → 给出具体调拨方案
  const allocSum = ok.reduce((s, m) => s + allocOf(m.id), 0) || 1;
  if (total >= 200 && hour >= 11) {
    const dev = ok
      .map((m) => ({ m, spendShare: (m.charge || 0) / total, allocShare: allocOf(m.id) / allocSum }))
      .sort((x, y) => y.spendShare - x.spendShare);
    const top = dev[0];
    const bottom = dev[dev.length - 1];
    const gap = top.spendShare - top.allocShare;
    if (dev.length > 1 && gap >= 0.2) {
      const suggest = ok.map((m) => {
        const raw = total > 0 ? ((m.charge || 0) / total) * TOTAL : TOTAL / ok.length;
        const v = Math.min(4500, Math.max(500, Math.round(raw / 100) * 100));
        return { name: m.name || m.tag, v };
      });
      const sum = suggest.reduce((s, x) => s + x.v, 0);
      if (sum !== TOTAL) suggest[0].v += TOTAL - sum; // 凑齐合计
      alerts.push({
        key: 'AT-alloc', sev: 'YEL', code: 'A7',
        text: `预算切分与消耗结构不匹配：${top.m.name || top.m.tag} 消耗占 ${Math.round(top.spendShare * 100)}%、额度只占 ${Math.round(top.allocShare * 100)}%（${bottom.m.name || bottom.m.tag} 反之）→ 建议调成 ${suggest.map((s) => `${s.name} ${s.v}`).join(' / ')}（合计仍 ${TOTAL}）`,
      });
    }
  }
  return alerts;
}

function evalCreatives(accName, rows, nameMap, campMap = new Map()) {
  const alerts = [];
  const hour = now().getHours();
  for (const r of rows) {
    const cid = String(r.creativeId || '');
    const name = String(nameMap.get(cid) || r.creativeName || r.name || cid).slice(0, 30);
    const charge = Number(r.charge || 0);
    const act = Number(r.activation || 0);
    const cpa = act > 0 && r.activationCost != null ? Number(r.activationCost) : null;
    const show = Number(r.show || 0);
    const ctr = r.actionRatio != null ? Number(r.actionRatio) : null;
    const brief = campMap.get(String(r.campaignId || '')) || {};
    const mcb = !!brief.isMcb;

    if (charge >= L.emptySpendCharge && act === 0) {
      alerts.push({ key: `C1-${cid}`, sev: 'YEL', code: 'C1', mcb, w: charge, text: `「${name}」消耗 ${yuan(charge)} 仍 0 激活 → 关掉这条创意` });
    } else if (charge >= L.emptySpendCharge && cpa != null && cpa > L.cpaRampHard) {
      alerts.push({ key: `C2-${cid}`, sev: 'YEL', code: 'C2', mcb, w: charge, text: `「${name}」消耗 ${yuan(charge)}，CPA ${yuan(cpa)} 超爬坡容忍线 → 关掉这条创意` });
    }
    // 曝光不足：只在「已经在花钱却拿不到量」时才算问题，避免历史死创意刷屏
    if (hour >= T.c3MinHour && charge >= 3 && show > 0 && show < T.c3MinShow) {
      const hint = mcb ? '最大转化无出价，换封面/首 3 秒或换素材' : '提价 20% 或换素材';
      alerts.push({ key: `C3-${cid}`, sev: 'YEL', code: 'C3', mcb, w: charge, text: `「${name}」曝光不足：花 ${yuan(charge)} 只拿到 ${show} 展示 → ${hint}` });
    }
    if (show >= T.c4MinShow && ctr != null && ctr < T.c4MaxCtr) {
      alerts.push({ key: `C4-${cid}`, sev: 'YEL', code: 'C4', mcb, w: charge, text: `「${name}」点击率 ${pct(ctr)} < ${pct(T.c4MaxCtr)} → 素材钩子弱，进淘汰池` });
    }
    if (act >= T.c5MinAct && cpa != null && cpa <= T.c5MaxCpa) {
      alerts.push({ key: `C5-${cid}`, sev: 'GOOD', code: 'C5', mcb, w: 0, text: `「${name}」高潜：CPA ${yuan(cpa)}（激活 ${act}）→ 值得复投放大` });
    }
  }
  return alerts;
}

/* ---------------- 卡片 ---------------- */
const SEV_ICON = { RED: '🔴', YEL: '🟡', GOOD: '🟢' };

/** 动作建议：最大转化（MCB）没有出价，任何「调价」都是胡说 */
function actionOf(a) {
  const mcb = !!a.mcb;
  switch (a.code) {
    case 'A0': return '先确认后端 7801 在线、授权未失效';
    case 'A1': return mcb ? '最大转化不看出价：查审核与素材质量；要抢量只能加计划预算或换素材' : '新素材出价可提到 9 元（上限），复投保持 8';
    case 'A2': return mcb ? '消耗偏快：盯住 CPA，超线就下调计划预算' : '降出价（基准 8 元）或关停 CPA 最差的创意';
    case 'A3': return '账户综合成本只作参考，结论看计划级';
    case 'A4': return '整户 0 激活：先查监测链接回传，再查落地页';
    case 'A5': return '核 channel_tag 与回调签名，先排除回传问题';
    case 'A6': return '重新授权';
    case 'A7': return '按建议调拨额度（合计不变）';
    case 'A8': return '新计划被暂停已自动重开；若是你手动暂停的，回复我加进豁免名单';
    case 'P0': return '关停该计划，素材转投其他计划';
    case 'P2': return '在容忍范围内，别动';
    case 'P3': return mcb ? '不关停，等到 20 个激活再看；急可下调计划预算 5%' : '不关停，等到 20 个激活再看；可降出价 5%';
    case 'P4': return mcb ? '成本偏高：计划预算降 10%~20%' : '成本偏高：出价降 10%';
    case 'P5': return mcb ? '成本超红线：计划预算降 20%，仍不达标就关停' : '成本超红线：出价降 10%，仍不达标就关停';
    case 'C1': return '关掉这条创意（0 激活空耗）';
    case 'C2': return '关掉这条创意（CPA 超爬坡容忍线）';
    case 'C3': return mcb ? '最大转化无出价：换封面 / 前 3 秒，或直接换素材' : '提价 20% 抢量，跑起来后回调 8 元';
    case 'C4': return '进淘汰池不再复投；同素材换钩子再试';
    case 'C5': return '复投放大，主力吃量';
    default: return null;
  }
}

/** 计划所处阶段（按激活数，不看挂了多久） */
function stageText(act, charge) {
  if (!act && !charge) return '还没起量（无消耗）';
  if (act < L.observeMaxAct) return `学习期：激活 ${act}/${L.observeMaxAct} → 成本暂不判定`;
  if (act < L.rampMaxAct) return `爬坡期：激活 ${act}/${L.rampMaxAct} → 容忍 CPA ${L.cpaRampWarn}~${L.cpaRampHard}`;
  return `成熟期：激活 ${act} → 红线 CPA ${L.cpaMatureWarn}/${L.cpaMatureRed}`;
}

function planBlock(plans) {
  const out = [];
  plans.forEach((p, i) => {
    const b = p.brief;
    const row = p.row || {};
    const act = Number(row.activation || 0);
    const charge = Number(row.charge || 0);
    const cpa = act > 0 && row.activationCost != null ? Number(row.activationCost) : null;
    const mode = b.isMcb ? '最大转化（无出价）' : `oCPX${b.bidYuan ? ' ' + yuan(b.bidYuan) + ' 元' : '（无出价）'}`;
    out.push(`**${i + 1}. ${b.name}**`);
    out.push(
      `　${b.putStatusText}｜${mode}｜日预算 ${b.dayBudgetYuan ? Math.round(b.dayBudgetYuan) + ' 元' : '不限'}｜消耗 ${yuan(charge)}｜激活 ${act}｜CPA ${cpa == null ? '—' : yuan(cpa)}｜展示 ${Number(row.show || 0)}｜CTR ${pct(row.actionRatio)}`,
    );
    out.push(`　${stageText(act, charge)}`);
  });
  return out;
}

function accountBlock(m, planBudget, acctBudget) {
  if (m.error) return [`**${m.name || m.tag}（${m.id}）**`, `　数据异常：${m.error.slice(0, 60)}`];
  const used = planBudget > 0 ? (m.charge / planBudget) * 100 : 0;
  // 短显示名下不再重复挂 ID（标题已经够短，账户名放在末行追溯）
  const shorted = !!(m.fullName && m.name && m.name !== m.fullName);
  const head = shorted ? `**${m.name}**` : `**${m.name || m.tag}（${m.id}）**`;
  const out = [
    head,
    `　消耗 ${yuan(m.charge)} / ${planBudget > 0 ? Math.round(planBudget) + `（${used.toFixed(1)}%）` : '—'}｜激活 ${m.activation}｜CPA ${m.cpa == null ? '—' : yuan(m.cpa)}｜展示 ${m.show}｜CTR ${pct(m.ctr)}${m.cpm == null ? '' : `｜千展 ${yuan(m.cpm)}`}`,
    `　账户日预算 ${Math.round(acctBudget)} 元（外层上限）${shorted ? `｜${m.fullName}` : ''}`,
  ];
  return out;
}

/** 摘要一句：保留名字，去掉「→ 动作」部分 */
function shortOf(text) {
  const t = String(text).trim();
  const cut = t.split('→')[0].trim();
  return cut.length > 62 ? cut.slice(0, 62) + '…' : cut;
}

/** 钉钉 Markdown 单换行不生效，必须空行分段；顺手丢掉占位空行，避免出现连续多空行 */
const cardJoin = (lines) => lines.filter((x) => x !== '').join('\n\n');

/** 同类告警合并：8 条「曝光不足」堆在一起只会让人抓不到重点 */
function compactTodo(todo) {
  const byCode = new Map();
  for (const a of todo) {
    const g = byCode.get(a.code) || [];
    g.push(a);
    byCode.set(a.code, g);
  }
  const out = [];
  for (const [, list] of byCode) {
    if (list[0].code === 'C3' && list.length >= 3) {
      const charge = list.reduce((s, a) => s + (a.w || 0), 0);
      out.push({
        ...list[0],
        key: 'C3-group',
        text: `${list.length} 条创意曝光不足（合计花 ${yuan(charge)}，单条展示都不到 ${T.c3MinShow}）→ 换封面 / 前 3 秒，或直接换素材`,
      });
    } else {
      out.push(...list);
    }
  }
  return out;
}

function buildWatchCard(alerts, ctx) {
  const { metrics, plans, planBudget, acctBudget, observeCount = 0 } = ctx;
  const reds = alerts.filter((x) => x.sev === 'RED');
  const yels = alerts.filter((x) => x.sev === 'YEL');
  const goods = alerts.filter((x) => x.sev === 'GOOD');
  const accNames = metrics.map((m) => m.name || m.tag).filter(Boolean);
  const title = accNames.length === 1 ? accNames[0] : '多账户';
  // 待处理先合并，badge 用合并后的数量（否则「8 项观察」下面只有 1 条，读起来对不上）
  const todo = compactTodo([...reds, ...yels]);
  const badge = [
    todo.some((a) => a.sev === 'RED') ? `🔴 ${todo.filter((a) => a.sev === 'RED').length} 项待处理` : '✅ 无红警',
    yels.length ? `🟡 ${todo.filter((a) => a.sev === 'YEL').length} 项观察` : '',
    goods.length ? `🟢 ${goods.length} 项提示` : '',
  ].filter(Boolean);
  const lines = [`### ${title} · 盯盘 ${md()} ${hm()}`, `**${badge.join('　｜　')}**`, ''];

  const totalCharge = metrics.reduce((s, m) => s + (m.charge || 0), 0);
  const totalAct = metrics.reduce((s, m) => s + (m.activation || 0), 0);
  const cpaAll = totalAct > 0 ? totalCharge / totalAct : null;
  const poolAll = Object.values(planBudget).reduce((s, v) => s + Number(v || 0), 0);
  const allObserve = plans.length > 0 && plans.every((p) => Number((p.row || {}).activation || 0) < L.observeMaxAct);
  const stat = `花 ${yuan(totalCharge)}/${poolAll > 0 ? Math.round(poolAll) : '—'}（${poolAll > 0 ? ((totalCharge / poolAll) * 100).toFixed(1) : '0'}%）· 激活 ${totalAct} · 均价 ${cpaAll == null ? '—' : yuan(cpaAll)}${allObserve ? '（学习期，成本暂不判）' : ''}`;

  const verdict = todo.length
    ? `**结论**：${todo.some((a) => a.sev === 'RED') ? '有红警' : '无红警'}。${stat}。${todo.length} 项待处理，最要紧的：${shortOf(todo[0].text)}`
    : `**结论**：${stat}，各项正常`;
  lines.push(verdict, '', '---', '');

  // 账户 + 计划
  for (const m of metrics) lines.push(...accountBlock(m, planBudget[m.id] || 0, acctBudget[m.id] || 0));
  if (metrics.length > 1) {
    lines.push(`**合计**：消耗 ${yuan(totalCharge)}　激活 ${totalAct}　均价 ${cpaAll == null ? '—' : yuan(cpaAll)}`);
  }
  lines.push('');
  const allPlans = [...plans].sort((a, b) => Number((b.row || {}).charge || 0) - Number((a.row || {}).charge || 0));
  if (allPlans.length) {
    lines.push(`**计划 · ${allPlans.length} 条**`);
    lines.push(...planBlock(allPlans));
  } else {
    lines.push('**计划**：今日无投放中的计划');
  }
  if (observeCount > 0 && !allObserve) lines.push(`_其中 ${observeCount} 条在学习期（激活 <${L.observeMaxAct}），成本不下结论_`);

  // 待处理（todo 已在上方合并好）
  if (todo.length) {
    lines.push('', '---', '', `**待处理 · ${todo.length} 项**`);
    todo.forEach((a, i) => lines.push(`${i + 1}. ${SEV_ICON[a.sev]} ${a.text}`));
  }
  if (goods.length) {
    lines.push('', `**提示 · ${goods.length} 项**`);
    for (const a of goods) lines.push(`· ${SEV_ICON[a.sev]} ${a.text}`);
  }

  // 建议：只针对待处理项，去重后最多 4 条，避免「提示」类凑数
  const actions = [];
  for (const a of todo) {
    const t = actionOf(a);
    if (t && !actions.includes(t)) actions.push(t);
  }
  if (actions.length) {
    lines.push('', '**建议动作**');
    actions.slice(0, 4).forEach((x) => lines.push(`· ${x}`));
  }
  lines.push('', `[打开工作台](http://127.0.0.1:7801)`);
  return cardJoin(lines);
}

function buildHeartbeatCard(metrics, ctx = {}) {
  const { planBudget = {}, acctBudget = {}, plans = [] } = ctx;
  const total = metrics.reduce((s, m) => s + (m.charge || 0), 0);
  const act = metrics.reduce((s, m) => s + (m.activation || 0), 0);
  const lines = [`### 盼之电竞 · 盯盘 ${md()} ${hm()}`, '**✅ 无异常（心跳）**', ''];
  for (const m of metrics) lines.push(...accountBlock(m, planBudget[m.id] || 0, acctBudget[m.id] || 0));
  if (metrics.length > 1) lines.push(`**合计**：消耗 ${yuan(total)}　激活 ${act}　均价 ${act ? yuan(total / act) : '—'}`);
  if (plans.length) {
    lines.push('', `**计划 · ${plans.length} 条**`);
    lines.push(...planBlock(plans));
  }
  lines.push('', `[打开工作台](http://127.0.0.1:7801)`);
  return cardJoin(lines);
}

/* ---------------- 推送 ---------------- */
/**
 * 钉钉推送。
 * 注意：不能用 shell 传参——卡片是多行 Markdown，走 shell 会被截断/转义搞坏。
 * 这里直接 node 调 dws 的 JS 入口，argv 原样传递。
 */
const DWS_JS =
  process.env.DWS_JS ||
  path.join(
    process.env.USERPROFILE || process.env.HOME || '',
    '.workbuddy/binaries/node/cli-connector-packages/node_modules/dingtalk-workspace-cli/bin/dws.js',
  );

function pushDingtalk(card) {
  if (DRY || !CFG.dingtalk.enabled) {
    console.log('--- 未推送（dry/enabled=false）---');
    return { ok: true, skipped: true };
  }
  // 优先用 openConversationId：稳定 ID 不走群名解析，避免重名/改名推错群
  const target = CFG.dingtalk.groupId || CFG.dingtalk.group;
  const res = spawnSync(
    process.execPath,
    [DWS_JS, 'chat', '+send-to-group', '--group', target, '--content', card, '--yes', '--format', 'json'],
    { encoding: 'utf-8', timeout: 60000 },
  );
  const out = ((res.stdout || '') + (res.stderr || '')).trim();
  const ok = res.status === 0 && !/"success"\s*:\s*false/.test(out);
  log(`推送${ok ? '成功' : '失败'}：${out.replace(/\s+/g, ' ').slice(0, 300)}`);
  return { ok, out };
}

/* ---------------- 投放状态自查（防「创建后暂停」复发） ---------------- */
const PAUSE_EXEMPT_FILE = path.join(RUNTIME, 'pause-exempt.json');

function loadPauseExempt() {
  try {
    const j = JSON.parse(fs.readFileSync(PAUSE_EXEMPT_FILE, 'utf-8'));
    return new Set(j.ids || []);
  } catch {
    return new Set();
  }
}

/** 近 36h 工具建的计划必须投放中；发现暂停的立即重开并告警。
 *  返回告警数组（code A8，RED）。若是用户手动暂停的，回复后加入豁免名单。 */
async function ensureRunning() {
  const exempt = loadPauseExempt();
  const { PrismaClient } = require('@prisma/client');
  const DB = path.join(process.env.APPDATA || '', '快手投放工作台', 'app.db');
  const p = new PrismaClient({ datasources: { db: { url: 'file:' + DB } } });
  let items = [];
  try {
    items = await p.batchTaskItem.findMany({
      where: {
        level: 'CAMPAIGN',
        platformId: { not: null },
        createdAt: { gte: new Date(Date.now() - 36 * 3600e3) },
      },
      select: { advertiserId: true, platformId: true, displayName: true },
      orderBy: { createdAt: 'desc' },
    });
  } finally {
    await p.$disconnect();
  }
  if (!items.length) return [];

  // 按账户去重（同一计划可能出现在多个任务里）
  const byAcc = new Map();
  const nameOf = new Map();
  for (const it of items) {
    const key = `${it.advertiserId}:${it.platformId}`;
    if (byAcc.has(key)) continue;
    byAcc.set(key, it);
    nameOf.set(String(it.platformId), it.displayName || String(it.platformId));
  }
  const groups = new Map();
  for (const it of byAcc.values()) {
    if (exempt.has(String(it.platformId))) continue;
    const g = groups.get(it.advertiserId) || [];
    g.push(String(it.platformId));
    groups.set(it.advertiserId, g);
  }

  const alerts = [];
  for (const [advertiserId, ids] of groups) {
    let rows = [];
    try {
      rows = await api('/api/manage/structure/by-ids', { advertiserId, level: 'campaign', ids });
    } catch (e) {
      log(`状态自查拉取失败 ${advertiserId}：${e.message}`);
      continue;
    }
    const stMap = new Map(rows.map((r) => [String(r.id), r.putStatus]));
    const paused = ids.filter((id) => stMap.get(id) != null && stMap.get(id) !== 1);
    const unknown = ids.filter((id) => !stMap.has(id));
    if (unknown.length) {
      alerts.push({ key: `A8u-${advertiserId}`, sev: 'YEL', code: 'A8', text: `${advertiserId} 有 ${unknown.length} 条新计划平台查不到（可能还在审核）：${unknown.map((i) => nameOf.get(i)).join('、')}` });
    }
    if (!paused.length) continue;
    // 立即重开
    const runResults = [];
    for (const id of paused) {
      try {
        const rr = await api('/api/manage/status', { advertiserId, level: 'campaign', ids: [id], action: 'RUN' });
        const ok = rr.succeeded && rr.succeeded.includes(id);
        runResults.push({ id, ok, name: nameOf.get(id) });
        log(`自查重开 ${advertiserId} 计划 ${id} ${ok ? '成功' : '失败'}`);
      } catch (e) {
        runResults.push({ id, ok: false, name: nameOf.get(id), err: e.message });
      }
    }
    const opened = runResults.filter((x) => x.ok);
    const failed = runResults.filter((x) => !x.ok);
    if (opened.length) {
      alerts.push({ key: `A8-${opened[0].id}`, sev: 'RED', code: 'A8', text: `⚠ 发现 ${paused.length} 条新计划被暂停，已自动重开：${opened.map((x) => x.name).join('、')}。如是你手动暂停的，回复我加入豁免名单。` });
    }
    if (failed.length) {
      alerts.push({ key: `A8f-${failed[0].id}`, sev: 'RED', code: 'A8', text: `❌ 新计划重开失败：${failed.map((x) => `${x.name}(${(x.err || '平台拒绝').slice(0, 60)})`).join('、')} —— 需人工处理` });
    }
  }
  return alerts;
}

/* ---------------- 主流程 ---------------- */
function dedupe(alerts) {
  const cutoff = Date.now() - CFG.dedupeMinutes * 60000;
  const fresh = [];
  for (const a of alerts) {
    const last = state.sent[a.key] || 0;
    if (last > cutoff) continue;
    if (!DRY) state.sent[a.key] = Date.now(); // 干跑不污染去重状态
    fresh.push(a);
  }
  // 清理过老的记录，避免状态文件膨胀
  for (const k of Object.keys(state.sent)) if (state.sent[k] < cutoff - 86400000) delete state.sent[k];
  return fresh;
}

async function watch() {
  const hour = now().getHours();
  // 巡检时段 09:00–23:59，之外静默（定时任务可能全天触发）
  if (hour < 9) { log("巡检时段外，跳过"); return; }
  const date = ymd();
  const pace = paceExpected(hour);
  const metrics = await accountMetrics(date);
  // 报告里一律用账户名，不用内部代号
  const names = await accountNameMap();
  applyAccountNames(metrics, names);

  const acctBudget = {};
  for (const a of CFG.accounts) acctBudget[a.id] = await budgetOf(a.id);

  let alerts = [];
  // 预算动态调拨只在多户时才有意义（单户没有「互倒」这回事，别去动人家预算）
  if (CFG.accounts.length > 1) {
    try {
      const budgetActs = await autoBudget.rebalance(metrics, acctBudget, { hour, dry: DRY });
      if (budgetActs.length) {
        for (const a of CFG.accounts) acctBudget[a.id] = await budgetOf(a.id);
        for (const b of budgetActs) {
          alerts.push({ key: `AB-${b.tag}`, sev: 'GOOD', code: 'A7', text: `${b.tag} 日预算已调 ${b.from} → ${b.to} 元（${b.why}）` });
        }
      }
    } catch (e) {
      log(`预算调拨失败：${e.message}`);
    }
  }

  // 计划层：拉计划清单（本地库 + 今日有消耗）→ 名称/预算/出价方式，再判定成本
  const plans = [];
  const planBudget = {};
  let observeCount = 0;
  for (const acc of CFG.accounts) {
    const accName = acc.name || names.get(String(acc.id)) || acc.tag;
    let rows = [];
    try {
      rows = await campaignRows(acc.id, date);
    } catch (e) {
      alerts.push({ key: `A0p-${acc.id}`, sev: 'YEL', code: 'A0', text: `${accName} 计划数据拉取失败：${String(e.message).slice(0, 120)}${netHint(e.message)}` });
    }
    // 计划清单：今日报表 + 近 3 天报表（含今天零消耗但仍在投的计划）+ 本地任务库
    const briefs = await loadCampaignBrief(acc.id, [...rows.map((r) => r.campaignId), ...(await recentCampaignIds(acc.id, 3))]);
    const rowMap = new Map(rows.map((r) => [String(r.campaignId), r]));

    // 计划池 = 在投计划日预算之和（账户预算是外层上限，不是今天能花完的钱）
    let pool = 0;
    for (const b of briefs.values()) if (b.putStatus !== 2 && b.dayBudgetYuan > 0) pool += b.dayBudgetYuan;
    planBudget[acc.id] = pool;

    for (const b of briefs.values()) plans.push({ brief: b, row: rowMap.get(b.id) || null, accId: acc.id });
    // 报表里有、本地库没有的计划（手建的），照样列出来
    for (const r of rows) {
      if (briefs.has(String(r.campaignId))) continue;
      const act = Number(r.activation || 0);
      if (Number(r.charge || 0) <= 0) continue;
      plans.push({
        accId: acc.id,
        row: r,
        brief: { id: String(r.campaignId), name: `计划${String(r.campaignId).slice(-6)}`, putStatus: 1, putStatusText: '投放中', dayBudgetYuan: 0, bidYuan: 0, bidType: null, isMcb: false },
      });
    }

    for (const r of rows) {
      const act = Number(r.activation || 0);
      if (Number(r.charge || 0) > 0 && stageOf(act) === 'OBSERVE') observeCount += 1;
      const brief = briefs.get(String(r.campaignId)) || {};
      const cname = brief.name || `计划${String(r.campaignId).slice(-6)}`;
      alerts = alerts.concat(evalCampaignCost(accName, r, cname, brief));
    }
    // 账户进度按计划池判定（不是账户预算）
    const m = metrics.find((x) => String(x.id) === String(acc.id));
    const hasMcb = [...briefs.values()].some((b) => b.isMcb && b.putStatus !== 2);
    if (m) alerts = alerts.concat(evalAccount(m, pool || acctBudget[acc.id] || 0, hour, pace, { mcb: hasMcb }));
  }
  // 多户才有合计口径
  alerts = alerts.concat(evalTotal(metrics, acctBudget, hour, pace));

  // 授权状态
  const grants = await grantsStatus();
  if (grants) {
    for (const g of grants) {
      if (g.status && String(g.status).toUpperCase() !== 'ACTIVE') {
        alerts.push({ key: `A6-g${g.id}`, sev: 'RED', code: 'A6', text: `授权 #${g.id} 状态 ${g.status}${g.lastError ? `（${String(g.lastError).slice(0, 60)}）` : ''} → 需重新授权` });
      }
    }
  }

  // 创意层
  const nameMaps = {};
  for (const acc of CFG.accounts) nameMaps[acc.id] = await creativeNameMap(acc.id);
  const perAccount = [];
  for (const acc of CFG.accounts) {
    const accName = acc.name || names.get(String(acc.id)) || acc.tag;
    const campMap = new Map();
    for (const p of plans) if (String(p.accId) === String(acc.id)) campMap.set(String(p.brief.id), p.brief);
    const pa = { acc, creativeRows: [], unitRows: [] };
    try {
      pa.creativeRows = await creativeRows(acc.id, date);
      alerts = alerts.concat(evalCreatives(accName, pa.creativeRows, nameMaps[acc.id], campMap));
    } catch (e) {
      alerts.push({ key: `A0c-${acc.id}`, sev: 'YEL', code: 'A0', text: `${accName} 创意数据拉取失败：${String(e.message).slice(0, 120)}` });
    }
    try {
      const ju = await api('/api/report/level/unit', { advertiserId: acc.id, startDate: date, endDate: date, page: 1, pageSize: 200 });
      pa.unitRows = ju.rows || [];
    } catch (e) {
      log(`${accName} 组数据拉取失败（不影响告警）：${e.message}`);
    }
    perAccount.push(pa);
  }

  // 自动执行（B 档授权：K1/K2 关停 + B1/B2/B3 调价，护栏在 auto-exec 内）
  try {
    const done = await autoExec.run({ date, hour, dry: DRY }, perAccount);
    if (done.length) log(`自动执行 ${done.length} 项`);
  } catch (e) {
    log(`自动执行异常（不影响告警）：${e.message}`);
  }

  // 效果追踪扫描：对已执行动作做 +6h / +24h 回看，有新评估就推卡
  try {
    const lines = await autoEffects.sweep();
    if (lines.length) {
      const fxCard = [
        `### 【快手操作效果追踪】${date} ${hm()}`,
        '',
        ...lines.slice(0, 12),
        '',
        '口径：只摆事实不下结论；样本不足的继续观察（最长追 48h）。',
      ].join('\n');
      if (DRY) console.log(fxCard);
      else pushDingtalk(fxCard);
      console.log(fxCard);
    }
  } catch (e) {
    log(`效果追踪异常（不影响告警）：${e.message}`);
  }

  // 投放状态自查：近 36h 新建计划必须投放中，发现暂停立即重开（A8）
  try {
    const reopenAlerts = await ensureRunning();
    alerts.push(...reopenAlerts);
    if (reopenAlerts.length) log(`状态自查发现 ${reopenAlerts.length} 条异常`);
  } catch (e) {
    log(`投放状态自查异常（不影响告警）：${e.message}`);
  }

  // 分桶限流：账户类全留；计划类按严重度+消耗取 6 条；创意类取 8 条
  const rank = { RED: 0, YEL: 1, GOOD: 2 };
  const byWeight = (a, b) => rank[a.sev] - rank[b.sev] || (b.w || 0) - (a.w || 0);
  const accountLevel = alerts.filter((a) => /^A/.test(a.code));
  const campaignLevel = alerts.filter((a) => /^P/.test(a.code)).sort(byWeight).slice(0, 6);
  const creativeLevel = alerts.filter((a) => /^C/.test(a.code)).sort(byWeight).slice(0, 8);
  alerts = accountLevel.concat(campaignLevel, creativeLevel);

  const reds = alerts.filter((a) => a.sev === 'RED');
  const yels = alerts.filter((a) => a.sev === 'YEL');
  const goods = alerts.filter((a) => a.sev === 'GOOD');

  let card;
  let pushed = false;
  const ctx = { metrics, plans, planBudget, acctBudget, observeCount };
  if (reds.length || yels.length || goods.length) {
    const fresh = dedupe([...reds, ...yels, ...goods]);
    if (fresh.length === 0) {
      log(`本轮 ${alerts.length} 项均在 ${CFG.dedupeMinutes} 分钟去重窗口内，不重复推送`);
      saveState();
      return;
    }
    card = buildWatchCard(fresh, ctx);
    const r = pushDingtalk(card);
    pushed = !r.skipped;
    console.log(card);
    if (r.out) console.log('\n[dws] ' + r.out.replace(/\s+/g, ' ').slice(0, 300));
  } else if (CFG.heartbeat && now().getMinutes() < 30 && hour % 2 === 0) {
    card = buildHeartbeatCard(metrics, ctx);
    const r = pushDingtalk(card);
    pushed = !r.skipped;
    console.log(card);
    if (r.out) console.log('\n[dws] ' + r.out.replace(/\s+/g, ' ').slice(0, 300));
  } else {
    log('巡检正常，无异常无心跳');
  }
  saveState();
  log(`${MODE} 完成：告警 ${alerts.length}，${pushed ? '已推送' : '未推送'}`);
}

async function daily() {
  const today = now();
  const y = new Date(today.getTime() - 86400000);
  const yStr = ymd(y);
  const metrics = await accountMetrics(yStr);
  const names = await accountNameMap();
  applyAccountNames(metrics, names);

  // 昨日计划明细：名称/出价方式/预算 + 实际消耗与转化
  const plans = [];
  const planBudget = {};
  const acctBudget = {};
  for (const acc of CFG.accounts) {
    acctBudget[acc.id] = await budgetOf(acc.id);
    let rows = [];
    try {
      rows = await campaignRows(acc.id, yStr);
    } catch (e) {
      log(`昨日计划数据拉取失败：${e.message}`);
    }
    const briefs = await loadCampaignBrief(acc.id, [...rows.map((r) => r.campaignId), ...(await recentCampaignIds(acc.id, 7))]);
    let pool = 0;
    for (const b of briefs.values()) if (b.dayBudgetYuan > 0) pool += b.dayBudgetYuan;
    planBudget[acc.id] = pool;
    const rowMap = new Map(rows.map((r) => [String(r.campaignId), r]));
    for (const b of briefs.values()) plans.push({ accId: acc.id, brief: b, row: rowMap.get(b.id) || null });
    for (const r of rows) {
      if (briefs.has(String(r.campaignId)) || Number(r.charge || 0) <= 0) continue;
      plans.push({
        accId: acc.id,
        row: r,
        brief: { id: String(r.campaignId), name: `计划${String(r.campaignId).slice(-6)}`, putStatus: 1, putStatusText: '—', dayBudgetYuan: 0, bidYuan: 0, isMcb: false },
      });
    }
  }

  // 近 7 天素材榜（罗盘全账户共享素材库，带名称）
  let mats = [];
  try {
    const start = ymd(new Date(today.getTime() - 6 * 86400000));
    const r = await api('/api/material/history', {
      startDate: start,
      endDate: yStr,
      granularity: 'TOTAL',
    });
    const raw = Array.isArray(r) ? r : r.rows || r.items || [];
    mats = raw.map((m) => {
      const charge = Number(m.charge || 0);
      const activation = Number(m.activation || 0);
      return {
        photoId: String(m.photoId || ''),
        name: m.materialName || m.name || String(m.photoId || ''),
        charge,
        activation,
        cpa: activation > 0 ? charge / activation : null,
      };
    });
  } catch (e) {
    log(`素材榜拉取失败：${e.message}`);
  }
  mats.sort((a, b) => b.charge - a.charge);
  const top = mats.slice(0, 12);
  const repool = mats
    .filter((m) => m.activation >= 3 && m.cpa != null && m.cpa <= 11)
    .sort((a, b) => b.charge - a.charge)
    .slice(0, 10);
  const kill = mats.filter((m) => m.charge >= 27 && m.activation === 0).slice(0, 5);

  const total = metrics.reduce((s, m) => s + (m.charge || 0), 0);
  const act = metrics.reduce((s, m) => s + (m.activation || 0), 0);
  const cpaAll = act > 0 ? total / act : null;
  const poolAll = Object.values(planBudget).reduce((s, v) => s + Number(v || 0), 0);

  // 昨日结论：成本差多少、量够不够
  const gap = cpaAll != null ? cpaAll - CFG.bidYuan : null;
  const noPlan = plans.length === 0 && total === 0;
  const verdict = noPlan
    ? '昨日没有任何投放记录（没有在跑的计划，或计划还没起量）'
    : act === 0
      ? `昨日 ${yuan(total)} 元零激活，先查回传与审核，别再盲目加量`
      : gap != null && gap > 3
        ? `昨日花 ${yuan(total)} 元拿到 ${act} 个激活，均价 ${yuan(cpaAll)}，比 ${CFG.bidYuan} 元目标高 ${yuan(gap)} —— 成本没守住`
        : gap != null && gap > 0
          ? `昨日均价 ${yuan(cpaAll)}，略高于 ${CFG.bidYuan} 元目标，在可接受边缘`
          : `昨日均价 ${yuan(cpaAll)}，成本达标`;

  const dailyTitle = metrics.length === 1 ? metrics[0].name || metrics[0].tag : '多账户';
  const lines = [`### ${dailyTitle} · 日报 ${md(y)}`, `**结论**：${verdict}`, '', '---', ''];

  // 账户
  for (const m of metrics) lines.push(...accountBlock(m, planBudget[m.id] || 0, acctBudget[m.id] || 0));
  if (metrics.length > 1) {
    lines.push(`**合计**：消耗 ${yuan(total)} / 计划池 ${yuan(poolAll)}　激活 ${act}　均价 ${cpaAll == null ? '—' : yuan(cpaAll)}`);
  }

  // 计划复盘
  lines.push('');
  if (plans.length) {
    lines.push(`**昨日计划 · ${plans.length} 条**`);
    lines.push(...planBlock([...plans].sort((a, b) => Number((b.row || {}).charge || 0) - Number((a.row || {}).charge || 0))));
  } else {
    lines.push('**昨日计划**：无投放记录');
  }

  // 素材
  lines.push('', '---', '', '**素材 · 近 7 天**');
  const topCpa = top.filter((m) => m.activation > 0).slice(0, 3);
  if (topCpa.length) {
    lines.push('· 跑量前 3：');
    topCpa.forEach((m) => lines.push(`　${m.name}｜消耗 ${yuan(m.charge)}｜激活 ${m.activation}｜CPA ${yuan(m.cpa)}`));
  } else {
    lines.push('· 近 7 天没有带转化的素材');
  }
  lines.push(repool.length ? `· ✅ 可复投（CPA ≤ 11）：${repool.slice(0, 5).map((m) => `${m.name}（${yuan(m.cpa)}）`).join('、')}` : '· 暂无达标可复投素材，今天以测新为主');
  if (kill.length) lines.push(`· ⛔ 建议停投（≥27 元 0 激活）：${kill.map((m) => `${m.name}（${yuan(m.charge)}）`).join('、')}`);

  // 今日动作：结合账户是否最大转化
  const mcbAccs = new Set();
  for (const p of plans) if (p.brief.isMcb && Number((p.row || {}).charge || 0) > 0) mcbAccs.add(String(p.accId));
  lines.push('', '---', '', '**今日动作**');
  lines.push(
    !plans.length
      ? `1. 昨日无投放记录：今天先确认计划已开启、审核通过，等激活到 ${L.observeMaxAct} 再看成本`
      : mcbAccs.size
        ? '1. 计划是最大转化（无出价）：不要谈提价——要量就加计划预算或加素材，要控成本就压预算/关计划'
        : `1. 计划是 oCPX：出价维持 ${CFG.bidYuan} 元，新素材最多上到 ${CFG.autoExecute.bidMax || 9} 元`,
  );
  lines.push(`2. 复投池里的素材各上 1 条新计划（同素材可重复），版位只投上下滑大屏`);
  lines.push(`3. 新素材测 3~5 条，等激活 ≥${L.observeMaxAct} 再看成本，别中途频繁改`);

  // 效果台账：昨日/前日已执行动作的 24h 回看汇总
  try {
    const fx = autoEffects.recentLines(2);
    if (fx.length) {
      lines.push('', '---', '**近 2 日操作效果回看（24h 窗口，只摆事实）**');
      fx.slice(0, 8).forEach((l) => lines.push(`· ${l}`));
    }
  } catch (e) {
    log(`效果台账读取失败：${e.message}`);
  }
  lines.push('', `[打开工作台](http://127.0.0.1:7801)`);
  const dkey = MODE + '-' + ymd();
  if (state.sent[dkey]) { log(dkey + " 今日已推送过，跳过"); return; }
  if (!DRY) state.sent[dkey] = Date.now();
  const card = cardJoin(lines);
  const r = pushDingtalk(card);
  console.log(card);
  if (r.out) console.log('\n[dws] ' + r.out.replace(/\s+/g, ' ').slice(0, 300));
  saveState();
  log(`daily 完成：${r.ok ? '已推送' : '推送失败'}`);
}

async function eod() {
  const date = ymd();
  const metrics = await accountMetrics(date);
  const names = await accountNameMap();
  applyAccountNames(metrics, names);

  const plans = [];
  const planBudget = {};
  const acctBudget = {};
  for (const acc of CFG.accounts) {
    acctBudget[acc.id] = await budgetOf(acc.id);
    let rows = [];
    try {
      rows = await campaignRows(acc.id, date);
    } catch (e) {
      log(`日终计划数据拉取失败：${e.message}`);
    }
    const briefs = await loadCampaignBrief(acc.id, [...rows.map((r) => r.campaignId), ...(await recentCampaignIds(acc.id, 7))]);
    let pool = 0;
    for (const b of briefs.values()) if (b.dayBudgetYuan > 0) pool += b.dayBudgetYuan;
    planBudget[acc.id] = pool;
    const rowMap = new Map(rows.map((r) => [String(r.campaignId), r]));
    for (const b of briefs.values()) plans.push({ accId: acc.id, brief: b, row: rowMap.get(b.id) || null });
    for (const r of rows) {
      if (briefs.has(String(r.campaignId)) || Number(r.charge || 0) <= 0) continue;
      plans.push({
        accId: acc.id,
        row: r,
        brief: { id: String(r.campaignId), name: `计划${String(r.campaignId).slice(-6)}`, putStatus: 1, putStatusText: '—', dayBudgetYuan: 0, bidYuan: 0, isMcb: false },
      });
    }
  }

  const total = metrics.reduce((s, m) => s + (m.charge || 0), 0);
  const act = metrics.reduce((s, m) => s + (m.activation || 0), 0);
  const cpaAll = act > 0 ? total / act : null;
  const poolAll = Object.values(planBudget).reduce((s, v) => s + Number(v || 0), 0);
  const used = poolAll > 0 ? (total / poolAll) * 100 : 0;

  const lines = [
    `### ${metrics.length === 1 ? metrics[0].name || metrics[0].tag : '多账户'} · 日终 ${md()}`,
    cpaAll == null
      ? `**结论**：今天花 ${yuan(total)} 元，零激活`
      : `**结论**：今天花 ${yuan(total)} 元（计划池 ${used.toFixed(1)}%），${act} 个激活，均价 ${yuan(cpaAll)}`,
    '',
    '---',
    '',
  ];
  for (const m of metrics) lines.push(...accountBlock(m, planBudget[m.id] || 0, acctBudget[m.id] || 0));
  if (plans.length) {
    lines.push('', `**计划 · ${plans.length} 条**`);
    lines.push(...planBlock([...plans].sort((a, b) => Number((b.row || {}).charge || 0) - Number((a.row || {}).charge || 0))));
  }
  lines.push('', '明天 09:30 出复盘 + 今日安排。');
  lines.push('', `[打开工作台](http://127.0.0.1:7801)`);
  const card = cardJoin(lines);
  const r = pushDingtalk(card);
  console.log(card);
  if (r.out) console.log('\n[dws] ' + r.out.replace(/\s+/g, ' ').slice(0, 300));
  saveState();
  log(`eod 完成：${r.ok ? '已推送' : '推送失败'}`);
}

(async () => {
  if (process.argv.includes('--selftest')) {
    // 离线自检：不连平台，直接喂用例验证分级判定
    const case_ = (tag, act, charge, cpa) => {
      const r = { campaignId: tag, charge, activation: act, activationCost: cpa };
      return evalCampaignCost('T', r, tag);
    };
    const checks = [
      ['观察期 2 激活 CPA 34.9 不报警', case_('obs', 2, 70, 34.9).length === 0],
      ['观察期 7 激活 CPA 30 不报警', case_('obs2', 7, 210, 30).length === 0],
      ['爬坡期 10 激活 CPA 19 只提示(非红)', case_('ramp', 10, 190, 19).every((a) => a.sev !== 'RED')],
      ['爬坡期 10 激活 CPA 24 且消耗45 黄灯', case_('ramp2', 10, 240, 24).some((a) => a.code === 'P3')],
      ['成熟期 25 激活 CPA 16 消耗120 红灯', case_('mat', 25, 400, 16).some((a) => a.sev === 'RED' && a.code === 'P5')],
      ['成熟期 25 激活 CPA 14 黄灯', case_('mat2', 25, 350, 14).some((a) => a.code === 'P4')],
      ['0 激活消耗 40 判空耗', case_('empty', 0, 40, null).some((a) => a.code === 'P0')],
      ['0 激活消耗 20 不判', case_('empty2', 0, 20, null).length === 0],
      ['成熟期 CPA 10 健康不报', case_('good', 30, 300, 10).length === 0],
    ];
    let bad = 0;
    for (const [name, ok] of checks) {
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
      if (!ok) bad += 1;
    }
    console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`);
    process.exit(bad === 0 ? 0 : 1);
  }
  try {
    // 先确保后端在线（掉线就自己拉起来），否则整轮巡检都是空的
    await ensureBackend({ waitSeconds: 60 });
    // 再确保分钟级守护常驻（被回收了就在这里重新拉起）
    ensureWatchdog();
    if (MODE === 'daily') await daily();
    else if (MODE === 'eod') await eod();
    else await watch();
  } catch (e) {
    log(`执行失败：${e.stack || e.message}`);
    console.error('执行失败：', e.message);
    process.exit(1);
  }
})();
