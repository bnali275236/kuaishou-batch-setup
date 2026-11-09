/* eslint-disable */
/**
 * 自动操作效果追踪台账（2026-11-09 用户要求）
 * 原则：记录每个自动动作的前后数据变化，用宽松窗口评估，不做严格及格线。
 *  - 每个动作在执行时记录 before 快照（当日累计 消耗/激活/展示/点击/出价）
 *  - +6h 回看一次（同日内），+24h 用 T-1 定稿数据再回看一次；数据不足标「继续观察」，最长追 48h
 *  - 评估只陈述事实（Δ消耗/Δ激活/ΔCPA/Δ展示），不下"成功/失败"结论，人工判断
 *
 * 文件：.runtime/auto-effects.json  { entries: [...] }
 * 由 auto-exec.cjs（KILL/BID 时）与三个建计划脚本（BUILD 时）调用 recordAction；
 * monitor.cjs 每小时巡检调用 sweep()，产生新评估就推钉钉卡片。
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '.runtime', 'auto-effects.json');
const MAX_ENTRIES = 600; // 约两个月的动作量，防止文件无限膨胀

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
    if (Array.isArray(j.entries)) return j;
  } catch {
    /* 新文件 */
  }
  return { entries: [] };
}
function save(db) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  if (db.entries.length > MAX_ENTRIES) db.entries = db.entries.slice(-MAX_ENTRIES);
  fs.writeFileSync(FILE, JSON.stringify(db, null, 1));
}

const yuan = (n) => (n == null || isNaN(n) ? '—' : (Math.round(n * 100) / 100).toFixed(2));
const pct = (a, b) => (b > 0 ? `${a > b ? '+' : ''}${Math.round(((a - b) / b) * 100)}%` : '—');

/** 记录一个动作的 before 快照。kind: KILL | BID | BUILD */
function recordAction(e) {
  const db = load();
  db.entries.push({
    id: `${e.kind}-${e.objectId}-${Date.now()}`,
    ts: Date.now(),
    date: e.date,
    hour: e.hour,
    kind: e.kind,
    rule: e.rule || '',
    advertiserId: e.advertiserId,
    tag: e.tag || '',
    objectId: String(e.objectId),
    name: (e.name || '').slice(0, 40),
    before: e.before || {},
    evals: {}, // h6 / h24
    createdAt: new Date().toISOString(),
  });
  save(db);
  return db.entries[db.entries.length - 1].id;
}

async function api(p, body) {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'monitor.config.json'), 'utf-8'));
  const res = await fetch(cfg.api + p, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${p} HTTP ${res.status}`);
  return JSON.parse(await res.text());
}

/** 拉某层级报表里指定对象的累计行（startDate..endDate），找不到返回 null */
async function fetchRow(level, advertiserId, startDate, endDate, idField, objectId) {
  for (let page = 1; page <= 6; page++) {
    const j = await api(`/api/report/level/${level}`, { advertiserId, startDate, endDate, page, pageSize: 200 });
    const rows = j.rows || [];
    const hit = rows.find((r) => String(r[idField]) === String(objectId));
    if (hit) return hit;
    if (rows.length < 200) return null;
  }
  return null;
}

const snap = (r) =>
  r
    ? {
        charge: Number(r.charge || 0),
        activation: Number(r.activation || 0),
        show: Number(r.aclick || r.show || 0),
        clicks: Number(r.bclick || 0),
      }
    : { charge: 0, activation: 0, show: 0, clicks: 0 };

const LEVEL_FIELD = { creative: ['creative', 'creativeId'], unit: ['unit', 'unitId'], campaign: ['campaign', 'campaignId'] };

/** 对单条记录做一次评估。kind=KILL 用 creative，BID 用 unit，BUILD 用 campaign */
async function evaluate(entry, stage) {
  const [level, idField] = LEVEL_FIELD[entry.kind === 'KILL' ? 'creative' : entry.kind === 'BID' ? 'unit' : 'campaign'];
  const today = new Date().toISOString().slice(0, 10);
  // 动作日至今的累计 - 动作前累计 = 动作后的增量（跨天也成立：把动作日全量加进来）
  const after = { charge: 0, activation: 0, show: 0, clicks: 0 };
  const days = [];
  if (stage === 'h6') {
    if (entry.date !== today) return { skipped: true, note: '已跨天，等 h24 用定稿数据' };
    days.push(today);
  } else {
    days.push(entry.date);
    if (today !== entry.date) days.push(today);
  }
  for (const d of days) {
    const r = await fetchRow(level, entry.advertiserId, d, d, idField, entry.objectId);
    const s = snap(r);
    after.charge += s.charge;
    after.activation += s.activation;
    after.show += s.show;
    after.clicks += s.clicks;
  }
  const b = entry.before || { charge: 0, activation: 0, show: 0, clicks: 0 };
  const dCharge = after.charge - b.charge;
  const dAct = after.activation - b.activation;
  const dShow = after.show - b.show;
  const dClicks = after.clicks - b.clicks;
  const cpaAfter = dAct > 0 ? dCharge / dAct : null;
  const cpaBefore = b.activation > 0 ? b.charge / b.activation : null;
  return { skipped: false, dCharge, dAct, dShow, dClicks, cpaAfter, cpaBefore };
}

/** 事实陈述（不判成败） */
function describe(entry, stage, ev) {
  const tag = entry.tag || entry.advertiserId;
  const nm = entry.name || entry.objectId;
  if (ev.skipped) return null;
  const L = [];
  const stageTxt = stage === 'h6' ? '6小时' : '24小时';
  if (entry.kind === 'KILL') {
    // 关停后核心问题：是否止血
    if (ev.dCharge <= 3) L.push(`✂ ${tag} 关停「${nm}」（${entry.rule}）后 ${stageTxt}：消耗 ${yuan(ev.dCharge)} 元，已止血`);
    else if (ev.dAct > 0) L.push(`✂ ${tag} 关停「${nm}」后 ${stageTxt}：仍消耗 ${yuan(ev.dCharge)} / 激活 ${ev.dAct}（CPA ${yuan(ev.cpaAfter)}）——关停可能未生效，需核查`);
    else L.push(`✂ ${tag} 关停「${nm}」后 ${stageTxt}：仍有 ${yuan(ev.dCharge)} 元消耗、0 激活——需核查是否真的停了`);
  } else if (entry.kind === 'BID') {
    if (ev.dAct >= 2) L.push(`⇅ ${tag} 调价「${nm}」（${entry.rule} ${yuan(entry.before.bid)}→${yuan(entry.afterBid || '?')}）后 ${stageTxt}：新增激活 ${ev.dAct}，增量成本 ${yuan(ev.dCharge)}（CPA ${yuan(ev.cpaAfter)}），展示 ${ev.dShow}`);
    else if (ev.dShow >= 1000) L.push(`⇅ ${tag} 调价「${nm}」后 ${stageTxt}：曝光 ${ev.dShow}、点击 ${ev.dClicks}、激活 ${ev.dAct}——量在进来，转化再观察`);
    else if (ev.dCharge <= 1) L.push(`⇅ ${tag} 调价「${nm}」后 ${stageTxt}：几乎没花出去（消耗 ${yuan(ev.dCharge)}、展示 ${ev.dShow}）——继续观察`);
    else L.push(`⇅ ${tag} 调价「${nm}」后 ${stageTxt}：消耗 ${yuan(ev.dCharge)}、展示 ${ev.dShow}、激活 ${ev.dAct}——样本尚少，继续观察`);
  } else if (entry.kind === 'BUILD') {
    if (ev.dCharge <= 0) L.push(`🆕 ${tag} 新计划「${nm}」上线 ${stageTxt}：尚无消耗（审核中或未起量，正常）`);
    else if (ev.dAct > 0) L.push(`🆕 ${tag} 新计划「${nm}」上线 ${stageTxt}：消耗 ${yuan(ev.dCharge)} / 激活 ${ev.dAct} / CPA ${yuan(ev.cpaAfter)} / 展示 ${ev.dShow}`);
    else L.push(`🆕 ${tag} 新计划「${nm}」上线 ${stageTxt}：消耗 ${yuan(ev.dCharge)}、展示 ${ev.dShow}、激活 0——起量中`);
  }
  return L.length ? L[0] : null;
}

/**
 * 扫描台账，对到期的记录做评估。
 * @returns string[] 新产生的效果描述（供推卡），无则 []
 */
async function sweep() {
  const db = load();
  const now = Date.now();
  const fresh = [];
  for (const e of db.entries) {
    try {
      if (!e.evals.h6 && now >= e.ts + 6 * 3600e3 && now < e.ts + 48 * 3600e3) {
        const ev = await evaluate(e, 'h6');
        if (ev && !ev.skipped) {
          e.evals.h6 = ev;
          const line = describe(e, 'h6', ev);
          if (line) fresh.push(line);
        } else if (ev && ev.skipped) {
          e.evals.h6 = { skipped: true };
        }
      }
      if (!e.evals.h24 && now >= e.ts + 24 * 3600e3) {
        const ev = await evaluate(e, 'h24');
        if (ev && !ev.skipped) {
          e.evals.h24 = ev;
          const line = describe(e, 'h24', ev);
          if (line) fresh.push(line);
        } else {
          e.evals.h24 = { skipped: true };
        }
      }
    } catch (err) {
      console.log(`[effects] 评估失败 ${e.id}: ${err.message}`); // 单条失败不影响其他
    }
  }
  save(db);
  return fresh;
}

/** 近 N 天已完成的 24h 评估汇总（给日报用） */
function recentLines(days = 2) {
  const db = load();
  const cutoff = Date.now() - days * 86400e3;
  const out = [];
  for (const e of db.entries) {
    if (e.ts < cutoff) continue;
    const ev = e.evals && e.evals.h24;
    if (!ev || ev.skipped) continue;
    const line = describe(e, 'h24', ev);
    if (line) out.push(line);
  }
  return out;
}

module.exports = { recordAction, sweep, recentLines };
