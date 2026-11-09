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

async function creativeRows(accId, dateStr) {
  const rows = [];
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

/** 计划 ID → 计划名（平台报表不带计划名，从本地任务库回填，缓存 24h） */
async function loadCampaignNames() {
  const cachePath = path.join(RUNTIME, 'campaign-names.json');
  try {
    const st = fs.statSync(cachePath);
    if (Date.now() - st.mtimeMs < 86400000) {
      return new Map(Object.entries(JSON.parse(fs.readFileSync(cachePath, 'utf-8'))));
    }
  } catch {
    /* 缓存不存在或损坏，重建 */
  }
  const map = new Map();
  try {
    const { PrismaClient } = require(path.join(ROOT, 'node_modules/@prisma/client'));
    const dbFile = path.join(process.env.APPDATA || process.env.HOME || '', '快手投放工作台', 'app.db');
    const prisma = new PrismaClient({ datasources: { db: { url: 'file:' + dbFile } } });
    const items = await prisma.batchTaskItem.findMany({
      where: { level: 'CAMPAIGN', platformId: { not: null } },
      select: { platformId: true, displayName: true },
    });
    for (const it of items) if (it.platformId) map.set(String(it.platformId), String(it.displayName));
    await prisma.$disconnect();
    fs.writeFileSync(cachePath, JSON.stringify(Object.fromEntries(map), null, 1));
  } catch (e) {
    log(`计划名缓存失败：${e.message}`);
  }
  return map;
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
function evalCampaignCost(accTag, row, name) {
  const out = [];
  const charge = Number(row.charge || 0);
  const act = Number(row.activation || 0);
  const cpa = act > 0 && row.activationCost != null ? Number(row.activationCost) : null;
  const cid = String(row.campaignId || '');
  const stage = stageOf(act);

  // 空耗：任何阶段都判（不是成本问题，是完全不转化）
  if (act === 0 && charge >= L.emptySpendCharge) {
    out.push({ key: `P0-${cid}`, sev: 'YEL', code: 'P0', w: charge, text: `${accTag}「${name}」消耗 ${yuan(charge)} 仍 0 激活 → 建议关停（${L.emptySpendCharge} 元空耗线）` });
    return out;
  }
  if (cpa == null) return out;

  if (stage === 'OBSERVE') {
    // 观察期：只记录，不下成本结论
    return out;
  }
  if (stage === 'RAMP') {
    if (cpa > L.cpaRampHard && charge >= L.cpaRampHardMinCharge) {
      out.push({ key: `P3-${cid}`, sev: 'YEL', code: 'P3', w: charge, text: `${accTag}「${name}」爬坡期成本偏高：CPA ${yuan(cpa)} > ${L.cpaRampHard}（激活 ${act}/${L.rampMaxAct}）→ 再观察到 ${L.rampMaxAct} 个激活，暂不关停` });
    } else if (cpa > L.cpaRampWarn) {
      out.push({ key: `P2-${cid}`, sev: 'GOOD', code: 'P2', w: 0, text: `${accTag}「${name}」爬坡期：CPA ${yuan(cpa)}（激活 ${act}），容忍线 ${L.cpaRampWarn}，继续观察` });
    }
    return out;
  }
  // 成熟期：恢复正常红线
  if (cpa > L.cpaMatureRed && charge >= L.cpaMatureRedMinCharge) {
    out.push({ key: `P5-${cid}`, sev: 'RED', code: 'P5', w: charge, text: `${accTag}「${name}」成熟期成本超标：CPA ${yuan(cpa)} > ${L.cpaMatureRed}（激活 ${act}，消耗 ${yuan(charge)}）→ 降出价 10% 或关停` });
  } else if (cpa > L.cpaMatureWarn) {
    out.push({ key: `P4-${cid}`, sev: 'YEL', code: 'P4', w: charge, text: `${accTag}「${name}」成熟期成本偏高：CPA ${yuan(cpa)} > ${L.cpaMatureWarn}（激活 ${act}）→ 降出价 10%` });
  }
  return out;
}

function evalAccount(a, budgetYuan, hour, pace) {
  const alerts = [];
  const expCharge = budgetYuan * pace;
  if (a.error) {
    alerts.push({ key: `A0-${a.tag}`, sev: 'RED', code: 'A0', text: `${a.tag} 数据拉取失败：${a.error}${netHint(a.error)}` });
    return alerts;
  }
  // A5 回传异常（持续判定）
  if (a.bclick >= T.clickNoConvCount && a.activation === 0 && hour >= 10) {
    const key = `A5-${a.tag}`;
    if (!state.firstSeen[key]) state.firstSeen[key] = Date.now();
    const mins = (Date.now() - state.firstSeen[key]) / 60000;
    if (mins >= T.clickNoConvMinutes) {
      alerts.push({ key, sev: 'RED', code: 'A5', text: `${a.tag} 回传异常：点击 ${a.bclick} 但激活 0，已持续 ${Math.round(mins)} 分钟` });
    }
  } else {
    delete state.firstSeen[`A5-${a.tag}`];
  }
  // A4 账户级空耗（整户 60 元仍 0 激活才算异常）
  if (a.charge >= L.accountEmptySpendCharge && a.activation === 0) {
    alerts.push({ key: `A4-${a.tag}`, sev: 'RED', code: 'A4', text: `${a.tag} 全户空耗：消耗 ${yuan(a.charge)} 元仍 0 激活` });
  }
  // A3 账户级成本：只做提示，真正的判定在计划级别（账户里混着老计划，不能一刀切）
  if (stageOf(a.activation) !== 'OBSERVE' && a.cpa != null && a.cpa > L.cpaMatureWarn) {
    alerts.push({ key: `A3-${a.tag}`, sev: 'YEL', code: 'A3', text: `${a.tag} 账户综合 CPA ${yuan(a.cpa)}（激活 ${a.activation}）——仅提示，成本判定看计划级` });
  }
  // A1 / A2 消耗进度（账户没跑起来时不算「滞后」，单列 A1b）
  if (hour >= 12) {
    if (a.charge === 0) {
      alerts.push({ key: `A1b-${a.tag}`, sev: 'RED', code: 'A1', text: `${a.tag} 全天 0 消耗，计划可能未开启/被拒/出价过低` });
    } else if (a.charge >= CFG.bidYuan * 3) {
      const ratio = a.charge / Math.max(expCharge, 1);
      if (ratio < T.paceLow) {
        alerts.push({ key: `A1-${a.tag}`, sev: 'YEL', code: 'A1', text: `${a.tag} 消耗滞后：已花 ${yuan(a.charge)}，按进度应花 ${yuan(expCharge)}（${Math.round(ratio * 100)}%）` });
      }
      if (ratio > T.paceHigh) {
        alerts.push({ key: `A2-${a.tag}`, sev: 'YEL', code: 'A2', text: `${a.tag} 消耗偏快：已花 ${yuan(a.charge)}，进度应花 ${yuan(expCharge)}（${Math.round(ratio * 100)}%）` });
      }
    }
  }
  if (hour < T.budgetHitAt && a.charge >= budgetYuan * 0.95) {
    alerts.push({ key: `A2b-${a.tag}`, sev: 'RED', code: 'A2', text: `${a.tag} 预算将撞线：已花 ${yuan(a.charge)} / ${budgetYuan}，现在才 ${hm()}` });
  }
  return alerts;
}

function evalCreatives(accTag, rows, nameMap) {
  const alerts = [];
  const hour = now().getHours();
  for (const r of rows) {
    const cid = String(r.creativeId || '');
    const name = String(nameMap.get(cid) || r.creativeName || r.name || cid).slice(0, 26);
    const charge = Number(r.charge || 0);
    const act = Number(r.activation || 0);
    const cpa = act > 0 && r.activationCost != null ? Number(r.activationCost) : null;
    const show = Number(r.show || 0);
    const ctr = r.actionRatio != null ? Number(r.actionRatio) : null;

    if (charge >= L.emptySpendCharge && act === 0) {
      alerts.push({ key: `C1-${cid}`, sev: 'YEL', code: 'C1', text: `${accTag}「${name}」消耗 ${yuan(charge)} 仍 0 激活 → 建议关停（${L.emptySpendCharge} 元空耗线）`, w: charge });
    } else if (charge >= L.emptySpendCharge && cpa != null && cpa > L.cpaRampHard) {
      alerts.push({ key: `C2-${cid}`, sev: 'YEL', code: 'C2', text: `${accTag}「${name}」消耗 ${yuan(charge)}，CPA ${yuan(cpa)} 超爬坡容忍线 → 建议关停`, w: charge });
    }
    // 曝光不足：只在「已经在花钱却拿不到量」时才算问题，避免历史死创意刷屏
    if (hour >= T.c3MinHour && charge >= 3 && show > 0 && show < T.c3MinShow) {
      alerts.push({ key: `C3-${cid}`, sev: 'YEL', code: 'C3', text: `${accTag}「${name}」曝光不足：花 ${yuan(charge)} 只拿到 ${show} 展示 → 提价 20% 或换素材`, w: charge });
    }
    if (show >= T.c4MinShow && ctr != null && ctr < T.c4MaxCtr) {
      alerts.push({ key: `C4-${cid}`, sev: 'YEL', code: 'C4', text: `${accTag}「${name}」点击率 ${pct(ctr)} < ${pct(T.c4MaxCtr)} → 素材钩子弱，停止复投`, w: charge });
    }
    if (act >= T.c5MinAct && cpa != null && cpa <= T.c5MaxCpa) {
      alerts.push({ key: `C5-${cid}`, sev: 'GOOD', code: 'C5', text: `${accTag}「${name}」高潜：CPA ${yuan(cpa)}（激活 ${act}）→ 今晚复投两户`, w: 0 });
    }
  }
  return alerts;
}

/* ---------------- 卡片 ---------------- */
const SEV_ICON = { RED: '🔴', YEL: '🟡', GOOD: '🟢' };
const CODE_ACTION = {
  A0: '检查后端 7801 是否在线 / 授权是否失效',
  A1: '查审核与出价：给最弱计划提价 10–20%，或换素材',
  A2: '降出价 / 关停 CPA 最差创意；必要时申请加预算',
  A3: '账户综合成本仅作参考，具体看计划级判定',
  A4: '整户 0 激活：先查监测链接回传，再查落地页',
  A5: '核监测链接 channel_tag 与回调签名，先确认不是回传问题',
  A6: '重新授权 / 充值',
  P0: '计划级空耗（36 元 0 激活）→ 关停该计划，素材转投他计划',
  P2: '爬坡期成本在容忍范围内，继续观察，别动',
  P3: '爬坡期超 2.5×：不关停，等到 20 个激活再看；可小幅降出价 5%',
  P4: '成熟期超 1.5×：出价降 10%',
  P5: '成熟期超红线：降出价 10%，仍不达标就关停',
  C1: '关停该创意（消耗已超 36 元且 0 激活，属空耗不属成本）',
  C2: '关停该创意（CPA 已超爬坡容忍线且消耗 ≥36 元）',
  C3: '提价 17% 抢量，拿到 5000 展示后回调 9 元',
  C4: '进淘汰池，不再复投；同素材换钩子文案再试',
  C5: '今晚复投到两户新计划，主力吃量',
};

function metricsLine(a) {
  if (a.error) return `${a.tag} · 数据异常（${a.error.slice(0, 40)}）`;
  return `${a.tag} · 消耗 ${yuan(a.charge)}/${CFG.dailyBudgetYuan}（${((a.charge / CFG.dailyBudgetYuan) * 100).toFixed(1)}%）· 激活 ${a.activation} · CPA ${a.cpa == null ? '—' : yuan(a.cpa)} · 展示 ${a.show} · 点击率 ${pct(a.ctr)}`;
}

function buildWatchCard(alerts, metrics, observeCount = 0) {
  const reds = alerts.filter((x) => x.sev === 'RED');
  const yels = alerts.filter((x) => x.sev === 'YEL');
  const goods = alerts.filter((x) => x.sev === 'GOOD');
  const head = `### 【快手盯盘】${md()} ${hm()} · 🔴${reds.length} 🟡${yels.length}${goods.length ? ` 🟢${goods.length}` : ''}`;
  const lines = [head, ''];
  for (const m of metrics) lines.push(metricsLine(m));
  if (observeCount > 0) lines.push(`_观察期计划 ${observeCount} 条（激活 <${L.observeMaxAct}，成本不判定）_`);
  if (alerts.length) {
    lines.push('', '---');
    for (const a of [...reds, ...yels, ...goods]) lines.push(`${SEV_ICON[a.sev]} ${a.text}`);
    const actions = [...new Set(alerts.filter((a) => a.sev !== 'GOOD').map((a) => CODE_ACTION[a.code]).filter(Boolean))];
    if (actions.length) {
      lines.push('', '**建议动作**');
      for (const x of actions) lines.push(`· ${x}`);
    }
  }
  lines.push('', `[打开工作台](http://127.0.0.1:7801)`);
  return lines.join('\n');
}

function buildHeartbeatCard(metrics) {
  const total = metrics.reduce((s, m) => s + (m.charge || 0), 0);
  const act = metrics.reduce((s, m) => s + (m.activation || 0), 0);
  const cpa = act > 0 ? total / act : null;
  const lines = [`### 【快手盯盘】${md()} ${hm()} · 平稳`, '', `合计消耗 ${yuan(total)} 元 · 激活 ${act} · CPA ${cpa == null ? '—' : yuan(cpa)}`];
  for (const m of metrics) lines.push(metricsLine(m));
  return lines.join('\n');
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
  const res = spawnSync(
    process.execPath,
    [DWS_JS, 'chat', '+send-to-group', '--group', CFG.dingtalk.group, '--content', card, '--yes', '--format', 'json'],
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
  const budgets = {};
  for (const a of CFG.accounts) budgets[a.id] = await budgetOf(a.id);

  let alerts = [];
  for (const m of metrics) alerts = alerts.concat(evalAccount(m, budgets[m.id] || CFG.dailyBudgetYuan, hour, pace));

  // 授权状态
  const grants = await grantsStatus();
  if (grants) {
    for (const g of grants) {
      if (g.status && String(g.status).toUpperCase() !== 'ACTIVE') {
        alerts.push({ key: `A6-g${g.id}`, sev: 'RED', code: 'A6', text: `授权 #${g.id} 状态 ${g.status}${g.lastError ? `（${String(g.lastError).slice(0, 60)}）` : ''} → 需重新授权` });
      }
    }
  }

  // 计划层：成本判定下放到这里（账户级只做提示）
  const cnameMap = await loadCampaignNames();
  let observeCount = 0;
  for (const acc of CFG.accounts) {
    try {
      const rows = await campaignRows(acc.id, date);
      for (const r of rows) {
        const act = Number(r.activation || 0);
        if (Number(r.charge || 0) > 0 && stageOf(act) === 'OBSERVE') observeCount += 1;
        const cname = cnameMap.get(String(r.campaignId)) || `计划${String(r.campaignId).slice(-6)}`;
        alerts = alerts.concat(evalCampaignCost(acc.tag, r, cname));
      }
    } catch (e) {
      alerts.push({ key: `A0p-${acc.tag}`, sev: 'YEL', code: 'A0', text: `${acc.tag} 计划数据拉取失败：${String(e.message).slice(0, 120)}${netHint(e.message)}` });
    }
  }

  // 创意层
  const nameMaps = {};
  for (const acc of CFG.accounts) nameMaps[acc.id] = await creativeNameMap(acc.id);
  const perAccount = [];
  for (const acc of CFG.accounts) {
    const pa = { acc, creativeRows: [], unitRows: [] };
    try {
      pa.creativeRows = await creativeRows(acc.id, date);
      alerts = alerts.concat(evalCreatives(acc.tag, pa.creativeRows, nameMaps[acc.id]));
    } catch (e) {
      alerts.push({ key: `A0c-${acc.tag}`, sev: 'YEL', code: 'A0', text: `${acc.tag} 创意数据拉取失败：${String(e.message).slice(0, 120)}` });
    }
    try {
      const ju = await api('/api/report/level/unit', { advertiserId: acc.id, startDate: date, endDate: date, page: 1, pageSize: 200 });
      pa.unitRows = ju.rows || [];
    } catch (e) {
      log(`${acc.tag} 组数据拉取失败（不影响告警）：${e.message}`);
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
  if (reds.length || yels.length || goods.length) {
    const fresh = dedupe([...reds, ...yels, ...goods]);
    if (fresh.length === 0) {
      log(`本轮 ${alerts.length} 项均在 ${CFG.dedupeMinutes} 分钟去重窗口内，不重复推送`);
      saveState();
      return;
    }
    card = buildWatchCard(fresh, metrics, observeCount);
    const r = pushDingtalk(card);
    pushed = !r.skipped;
    console.log(card);
    if (r.out) console.log('\n[dws] ' + r.out.replace(/\s+/g, ' ').slice(0, 300));
  } else if (CFG.heartbeat && now().getMinutes() < 30 && hour % 2 === 0) {
    card = buildHeartbeatCard(metrics);
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
  const lines = [
    `### 【快手日报】${md(y)} 复盘 + 今日基建`,
    '',
    `合计消耗 ${yuan(total)} 元 · 激活 ${act} · 均价 ${act ? yuan(total / act) : '—'}`,
  ];
  for (const m of metrics) lines.push(metricsLine(m));
  lines.push('', '---', '**今日复投池（CPA ≤ 11，昨日/近 7 天达标）**');
  if (repool.length) repool.forEach((m, i) => lines.push(`${i + 1}. ${m.name} · 消耗 ${yuan(m.charge)} · EXP ${m.activation} · CPA ${yuan(m.cpa)}`));
  else lines.push('· 暂无达标素材，今日以测新为主');
  if (kill.length) {
    lines.push('', '**建议停止复投**');
    kill.forEach((m) => lines.push(`· ${m.name} · 消耗 ${yuan(m.charge)} · 0 激活`));
  }
  lines.push('', `**今日动作**：每户上 2 条计划 —— 跑量复投 8–10 条（可用上面名单，重复没关系）+ 新素材 3–5 条；版位只投上下滑大屏，出价 9 元。`);
  // 效果台账：昨日/前日已执行动作的 24h 回看汇总
  try {
    const fx = autoEffects.recentLines(2);
    if (fx.length) {
      lines.push('', '---', '**近 2 日操作效果回看（24h 窗口，只摆事实）**');
      fx.slice(0, 10).forEach((l) => lines.push(`· ${l}`));
    }
  } catch (e) {
    log(`效果台账读取失败：${e.message}`);
  }
  const dkey = MODE + '-' + ymd();
  if (state.sent[dkey]) { log(dkey + " 今日已推送过，跳过"); return; }
  state.sent[dkey] = Date.now();
  const card = lines.join('\n');
  const r = pushDingtalk(card);
  console.log(card);
  if (r.out) console.log('\n[dws] ' + r.out.replace(/\s+/g, ' ').slice(0, 300));
  saveState();
  log(`daily 完成：${r.ok ? '已推送' : '推送失败'}`);
}

async function eod() {
  const date = ymd();
  const metrics = await accountMetrics(date);
  const total = metrics.reduce((s, m) => s + (m.charge || 0), 0);
  const act = metrics.reduce((s, m) => s + (m.activation || 0), 0);
  const lines = [
    `### 【快手日终】${md()} 小结`,
    '',
    `合计消耗 ${yuan(total)} 元 · 激活 ${act} · 均价 ${act ? yuan(total / act) : '—'} · 预算执行 ${((total / (CFG.dailyBudgetYuan * CFG.accounts.length)) * 100).toFixed(1)}%`,
  ];
  for (const m of metrics) lines.push(metricsLine(m));
  lines.push('', '明日 09:30 出复盘与基建清单。');
  const card = lines.join('\n');
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
    if (MODE === 'daily') await daily();
    else if (MODE === 'eod') await eod();
    else await watch();
  } catch (e) {
    log(`执行失败：${e.stack || e.message}`);
    console.error('执行失败：', e.message);
    process.exit(1);
  }
})();
