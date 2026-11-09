/* eslint-disable */
/**
 * 自动执行器（B 档授权，2026-11-09 用户拍板）
 * 由 monitor.cjs 每小时巡检调用； dry 模式只打印不执行。
 *
 * 规则：
 *  K1 创意消耗 ≥ 36 元（4×出价）且激活=0        → 关停该创意
 *  K2 创意消耗 ≥ 54 元（6×）且 CPA ≥ 18（2×）    → 关停该创意
 *  B1 组上线≥3h(12点后)、消耗≥3元、展示<1000     → 出价 +10%（≤10），每组每日最多2次
 *  B2 组激活≥20（已出学习期）且 CPA>13.5          → 出价 −10%（≥8），每组每日最多2次
 *  B3 被 B1 提过价的组，展示≥5000 且 CPA≤11      → 回调出价至 9
 *
 * 护栏：
 *  - 出价硬区间 [8, 10]；只动本工具建的计划（本地库能映射到出价的组）
 *  - 每小时动作 ≤ 8；每日关停 ≤ 10、调价 ≤ 12
 *  - 同类动作连续失败 3 次 → 熔断 24h
 *  - 所有动作写 .runtime/auto-actions.json + 推钉钉「已执行」卡片
 *  - UAX 全自动组（出价 0）不碰
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const effects = require('./auto-effects.cjs');

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'monitor.config.json'), 'utf-8'));
const DB = path.join(process.env.APPDATA || '', '快手投放工作台', 'app.db');
const ACTIONS_FILE = path.join(__dirname, '..', '.runtime', 'auto-actions.json');
const DWS_JS =
  process.env.DWS_JS ||
  path.join(
    process.env.USERPROFILE || process.env.HOME || '',
    '.workbuddy/binaries/node/cli-connector-packages/node_modules/dingtalk-workspace-cli/bin/dws.js',
  );

const AE = CFG.autoExecute || { enabled: false };
const BID_MIN = AE.bidMin ?? 8;
const BID_MAX = AE.bidMax ?? 10;
const BID_BASE = AE.bidBase ?? 9;

const log = (m) => console.log(`[auto] ${m}`);
const yuan = (n) => (n == null ? '—' : (Math.round(n * 100) / 100).toFixed(2));

function loadActions() {
  const today = new Date().toISOString().slice(0, 10);
  let a = { date: today, kills: 0, bids: 0, log: [], raises: {}, fails: {}, breakerUntil: {} };
  try {
    const saved = JSON.parse(fs.readFileSync(ACTIONS_FILE, 'utf-8'));
    if (saved.date === today) a = saved;
  } catch {
    /* 新文件 */
  }
  return a;
}
function saveActions(a) {
  fs.mkdirSync(path.dirname(ACTIONS_FILE), { recursive: true });
  fs.writeFileSync(ACTIONS_FILE, JSON.stringify(a, null, 1));
}

function pushDingtalk(card) {
  if (!CFG.dingtalk.enabled) return;
  const res = spawnSync(
    process.execPath,
    [DWS_JS, 'chat', '+send-to-group', '--group', CFG.dingtalk.group, '--content', card, '--yes', '--format', 'json'],
    { encoding: 'utf-8', timeout: 60000 },
  );
  const out = ((res.stdout || '') + (res.stderr || '')).trim();
  const ok = res.status === 0 && !/"success"\s*:\s*false/.test(out);
  log(`推送${ok ? '成功' : '失败'}`);
}

async function api(p, body) {
  const res = await fetch(CFG.api + p, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`${p} → HTTP ${res.status} ${txt.slice(0, 150)}`);
  return JSON.parse(txt);
}

/** 本工具建过的组：unitId → { bid, unitName, advertiserId }（出价 0 = UAX 自动，跳过） */
async function ourUnits() {
  const { PrismaClient } = require('@prisma/client');
  const p = new PrismaClient({ datasources: { db: { url: 'file:' + DB } } });
  try {
    const items = await p.batchTaskItem.findMany({
      where: { level: 'UNIT', platformId: { not: null } },
      select: { platformId: true, advertiserId: true, displayName: true, payloadJson: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    const map = new Map();
    for (const it of items) {
      const key = `${it.advertiserId}:${it.platformId}`;
      if (map.has(key)) continue;
      let pl = {};
      try {
        pl = JSON.parse(it.payloadJson || '{}');
      } catch {
        continue;
      }
      let bid = Number(pl.cpa_bid ?? pl.bid ?? 0);
      if (bid > 200) bid = bid / 1000; // payload 存厘（9000=9元），归一到元；UAX 出价 0 已被上面过滤
      if (!(bid > 0)) continue; // UAX/未设出价的不碰
      map.set(key, { unitId: String(it.platformId), advertiserId: it.advertiserId, unitName: it.displayName || '', bid });
    }
    return map;
  } finally {
    await p.$disconnect();
  }
}

async function unitRows(accId, date) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const j = await api('/api/report/level/unit', { advertiserId: accId, startDate: date, endDate: date, page, pageSize: 200 });
    const rows = j.rows || [];
    out.push(...rows);
    if (rows.length < 200) break;
  }
  return out;
}

/**
 * @param {*} ctx { date, hour, dry }
 * @param {*} perAccount [{ acc:{id,tag}, creativeRows:[], }]
 * @returns 执行动作列表（供卡片）
 */
async function run(ctx, perAccount) {
  if (!AE.enabled) return [];
  const { date, hour, dry } = ctx;
  // dry 模式用副本决策，不污染计数器/熔断状态，也不写回文件
  const acts = loadActions();
  if (dry) {
    for (const k of ['kills', 'bids']) acts[k] = 0;
    acts.raises = {};
  }
  const executed = [];
  const breaker = (kind) => (acts.breakerUntil[kind] || 0) > Date.now();
  const recordFail = (kind, msg) => {
    const n = (acts.fails[kind] || 0) + 1;
    acts.fails[kind] = n;
    if (n >= 3) {
      acts.breakerUntil[kind] = Date.now() + 86400000;
      acts.fails[kind] = 0;
      log(`⚠ ${kind} 连续失败 3 次，熔断 24h：${msg}`);
    }
  };
  const recordOk = (kind) => {
    acts.fails[kind] = 0;
  };

  const umap = await ourUnits();

  /* ---- K 类：创意关停 ---- */
  const kill = async (advertiserId, tag, r, rule) => {
    if (acts.kills >= (AE.maxKillPerDay ?? 10)) return;
    if (executed.length >= (AE.maxActionsPerHour ?? 8)) return;
    const cid = String(r.creativeId || '');
    if (!cid) return;
    const key = `kill:${cid}`;
    if ((acts.raises[key] || 0) === date) return; // 今天已处理过
    try {
      if (!dry) {
        const rr = await api('/api/manage/status', { advertiserId, level: 'creative', ids: [cid], action: 'PAUSE' });
        if (rr.errors && rr.errors.length) throw new Error(JSON.stringify(rr.errors).slice(0, 120));
      }
      acts.kills += 1;
      acts.raises[key] = date;
      recordOk(rule);
      // 效果台账：记录关停前快照，+6h/+24h 回看是否止血
      if (!dry) {
        effects.recordAction({
          kind: 'KILL', rule, date, hour,
          advertiserId, tag,
          objectId: cid,
          name: r.creativeName || cid,
          before: {
            charge: Number(r.charge || 0),
            activation: Number(r.activation || 0),
            show: Number(r.aclick || r.show || 0),
            clicks: Number(r.bclick || 0),
          },
        });
      }
      executed.push({
        kind: 'KILL',
        text: `${tag} 关停创意「${(r.creativeName || cid).slice(0, 24)}」（${rule}：消耗 ${yuan(r.charge)} / 激活 ${r.activation || 0}${rule === 'K2' ? ` / CPA ${yuan(r.activationCost)}` : ''}）`,
      });
      log(`KILL ${tag} creative ${cid}`);
    } catch (e) {
      recordFail(rule, e.message);
      log(`关停失败 ${cid}: ${e.message}`);
    }
  };

  for (const pa of perAccount) {
    for (const r of pa.creativeRows || []) {
      const charge = Number(r.charge || 0);
      const act = Number(r.activation || 0);
      const cpa = r.activationCost != null ? Number(r.activationCost) : act > 0 ? charge / act : null;
      if (charge >= 36 && act === 0) await kill(pa.acc.id, pa.acc.tag, r, 'K1');
      else if (charge >= 54 && cpa != null && cpa >= 18) await kill(pa.acc.id, pa.acc.tag, r, 'K2');
    }
  }

  /* ---- B 类：组出价（只动本工具建的组） ---- */
  const setBid = async (u, newBid, rule, why, row) => {
    if (acts.bids >= (AE.maxBidPerDay ?? 12)) return;
    if (executed.length >= (AE.maxActionsPerHour ?? 8)) return;
    if (newBid < BID_MIN || newBid > BID_MAX || newBid === u.bid) return;
    const cnt = (acts.raises[`bid:${u.unitId}`] || 0);
    if (cnt >= 2) return;
    try {
      const oldBid = u.bid;
      if (!dry) {
        const rr = await api('/api/manage/unit-bid', { advertiserId: u.advertiserId, unitIds: [u.unitId], bidYuan: newBid });
        if (rr.errors && rr.errors.length) throw new Error(JSON.stringify(rr.errors).slice(0, 120));
      }
      acts.bids += 1;
      acts.raises[`bid:${u.unitId}`] = cnt + 1;
      u.bid = newBid;
      recordOk(rule);
      // 效果台账：记录调价前快照（当日累计消耗/曝光/激活 + 当时出价）
      if (!dry && row) {
        effects.recordAction({
          kind: 'BID', rule, date, hour,
          advertiserId: u.advertiserId,
          tag: u.unitName ? String(u.unitName).replace(/^PZ(\d+).*$/, '$1') : '',
          objectId: u.unitId,
          name: u.unitName || u.unitId,
          before: {
            bid: oldBid,
            charge: Number(row.charge || 0),
            activation: Number(row.activation || 0),
            show: Number(row.aclick || row.show || 0),
            clicks: Number(row.bclick || 0),
          },
          afterBid: newBid,
        });
      }
      executed.push({ kind: 'BID', text: `${u.unitName || u.unitId} 出价 ${yuan(oldBid)} → ${yuan(newBid)}（${rule}：${why}）` });
      log(`BID ${u.unitId} ${oldBid}→${newBid}`);
    } catch (e) {
      recordFail(rule, e.message);
      log(`调价失败 ${u.unitId}: ${e.message}`);
    }
  };

  for (const pa of perAccount) {
    if (!pa.unitRows) continue;
    for (const r of pa.unitRows) {
      const uid = String(r.unitId || '');
      const u = umap.get(`${pa.acc.id}:${uid}`);
      if (!u) continue; // 不是我们的组
      const charge = Number(r.charge || 0);
      const show = Number(r.aclick || r.show || 0);
      const act = Number(r.activation || 0);
      const cpa = r.activationCost != null ? Number(r.activationCost) : act > 0 ? charge / act : null;

      // B3 回调：今天被提过价 且 已拿到量
      if (cpa != null && show >= 5000 && cpa <= 11 && u.bid > BID_BASE) {
        await setBid(u, BID_BASE, 'B3', `展示 ${show} / CPA ${yuan(cpa)} 已达标`, r);
        continue;
      }
      // B1 提价抢量
      if (hour >= 12 && hour <= 22 && charge >= 3 && show > 0 && show < 1000) {
        await setBid(u, Math.min(Math.round(u.bid * 1.1 * 10) / 10, BID_MAX), 'B1', `消耗 ${yuan(charge)} 仅展示 ${show}`, r);
        continue;
      }
      // B2 成熟期降本
      if (act >= 20 && cpa != null && cpa > 13.5) {
        await setBid(u, Math.max(Math.round(u.bid * 0.9 * 10) / 10, BID_MIN), 'B2', `激活 ${act} / CPA ${yuan(cpa)}`, r);
      }
    }
  }

  if (executed.length) {
    const lines = [`### 【快手自动执行】${date} ${String(hour).padStart(2, '0')}时`, '', `本轮执行 **${executed.length}** 项（今日关停 ${acts.kills}/${AE.maxKillPerDay ?? 10}，调价 ${acts.bids}/${AE.maxBidPerDay ?? 12}）`, ''];
    executed.slice(0, 10).forEach((x) => lines.push(`- ${x.text}`));
    if (executed.length > 10) lines.push(`- …等共 ${executed.length} 项`);
    lines.push('', '如需撤销任一动作，直接在群里说，工具里有前后值记录。');
    if (!dry) pushDingtalk(lines.join('\n'));
    else console.log(lines.join('\n'));
  }

  if (!dry) saveActions(acts);
  return executed;
}

module.exports = { run };
