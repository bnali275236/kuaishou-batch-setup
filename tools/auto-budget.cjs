/* eslint-disable */
/**
 * 账户日预算动态调拨（2026-11-10 用户口径）
 *
 * 规则：
 *  - 两户合计固定 totalBudgetYuan（5000），单户额度可互倒；
 *  - 目标：每户 日预算 ≥ 2×已消耗（即消耗利用率 ≤50%），不让任何一户跑到 50% 以上；
 *  - 富余额度按当前消耗占比分配（花得快的户拿更多余量）；
 *  - 求和恒等于 5000。
 *
 * 护栏：
 *  - 只在 09:00–23:00 动作；变更幅度 <200 元不动（防抖）；
 *  - 新额度必须 ≥ 当前消耗 +300（绝不把户压到立刻停投）；
 *  - 单户 2 小时内最多改一次，但「剩余额度 <300」属紧急情况可立即改；
 *  - 每次动作写 .runtime/budget-state.json + 推钉钉。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'monitor.config.json'), 'utf-8'));
const STATE_FILE = path.join(__dirname, '..', '.runtime', 'budget-state.json');
const PLAN_FILE = path.join(__dirname, '..', '.runtime', 'budget-plan.json');
const DWS_JS =
  process.env.DWS_JS ||
  path.join(
    process.env.USERPROFILE || process.env.HOME || '',
    '.workbuddy/binaries/node/cli-connector-packages/node_modules/dingtalk-workspace-cli/bin/dws.js',
  );
const log = (m) => console.log(`[budget] ${m}`);
const yuan = (n) => (Math.round(Number(n || 0) * 100) / 100).toFixed(2);

function loadState() {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    if (s.date === today) return s;
  } catch {
    /* ignore */
  }
  return { date: today, last: {}, log: [] };
}
function saveState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 1));
}
function savePlan(plan) {
  fs.mkdirSync(path.dirname(PLAN_FILE), { recursive: true });
  fs.writeFileSync(PLAN_FILE, JSON.stringify({ at: new Date().toISOString(), plan }, null, 1));
}

/** 当前生效的单户额度（.runtime 覆盖 config） */
function currentPlan() {
  try {
    return JSON.parse(fs.readFileSync(PLAN_FILE, 'utf-8')).plan || {};
  } catch {
    return { ...(CFG.budgetPlan || {}) };
  }
}

const r100 = (n) => Math.round(n / 100) * 100;

/** 计算目标切分 */
function computePlan(metrics, total) {
  const ok = metrics.filter((m) => !m.error);
  if (!ok.length) return []; // 全部取数失败（例如后端掉线）→ 不调拨
  const base = ok.map((m) => {
    const charge = Number(m.charge || 0);
    return { id: m.id, tag: m.tag, charge, need: Math.max(600, r100(charge * 2)) };
  });
  const sumNeed = base.reduce((s, x) => s + x.need, 0);
  let out;
  if (sumNeed <= total) {
    const spare = total - sumNeed;
    const spent = base.reduce((s, x) => s + x.charge, 0);
    out = base.map((x) => ({
      ...x,
      v: x.need + (spent > 0 ? r100(spare * (x.charge / spent)) : r100(spare / base.length)),
    }));
  } else {
    out = base.map((x) => ({ ...x, v: Math.max(600, Math.floor((x.need * total) / sumNeed / 100) * 100) }));
  }
  // 强制合计 = total
  if (!out.length) return [];
  let diff = total - out.reduce((s, x) => s + x.v, 0);
  if (diff !== 0) {
    const t = out.slice().sort((a, b) => b.charge - a.charge)[0];
    if (t) t.v += diff;
  }
  return out;
}

async function api(p, body) {
  const res = await fetch(CFG.api + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`${p} HTTP ${res.status} ${t.slice(0, 150)}`);
  return JSON.parse(t);
}

function pushDingtalk(card) {
  if (!CFG.dingtalk.enabled) return;
  const res = spawnSync(
    process.execPath,
    [DWS_JS, 'chat', '+send-to-group', '--group', CFG.dingtalk.group, '--content', card, '--yes', '--format', 'json'],
    { encoding: 'utf-8', timeout: 60000 },
  );
  const out = ((res.stdout || '') + (res.stderr || '')).trim();
  log(`推送${/"success"\s*:\s*false/.test(out) ? '失败' : '成功'}`);
}

/**
 * @param metrics 账户指标 [{id,tag,charge,...}]
 * @param current 当前平台额度 {accId: yuan}
 * @param opts {hour, dry}
 * @returns 执行过的变更 [{tag, from, to, why}]
 */
async function rebalance(metrics, current, opts = {}) {
  const hour = opts.hour ?? new Date().getHours();
  const dry = !!opts.dry;
  if (hour < 9 || hour > 23) return [];
  const total = Number(CFG.totalBudgetYuan || 5000);
  // 数据不全时不调拨：少一户口径就不对，等下一轮
  const okCount = metrics.filter((m) => !m.error).length;
  if (okCount < CFG.accounts.length) {
    log(`数据不全（${okCount}/${CFG.accounts.length}），本轮不调拨`);
    return [];
  }
  const plan = computePlan(metrics, total);
  const st = loadState();
  const acts = [];

  for (const x of plan) {
    const from = Number(current[x.id] || CFG.dailyBudgetYuan);
    const to = Number(x.v);
    const delta = to - from;
    if (Math.abs(delta) < 200) continue;
    const urgent = from - x.charge < 300; // 快撞线，允许立即改
    const lastAt = st.last[x.id]?.at || 0;
    if (!urgent && Date.now() - lastAt < 2 * 3600 * 1000) continue;
    if (to < x.charge + 300) {
      log(`${x.tag} 目标额度 ${to} 低于 消耗+300，跳过`);
      continue;
    }
    try {
      if (!dry) {
        await api('/api/manage/advertiser-budget', { advertiserId: x.id, budgetYuan: to });
        const check = await api('/api/manage/advertiser-budget/get', { advertiserId: x.id });
        const after = Number(check.day_budget || 0) / 1000;
        if (Math.abs(after - to) > 1) throw new Error(`回读不一致：期望 ${to} 实际 ${after}`);
        st.last[x.id] = { at: Date.now(), from, to };
      }
      const why = `消耗 ${yuan(x.charge)}，利用率 ${((x.charge / from) * 100).toFixed(0)}% → ${((x.charge / to) * 100).toFixed(0)}%`;
      acts.push({ tag: x.tag, from, to, why });
      log(`${dry ? '[dry] ' : ''}${x.tag} 预算 ${from} → ${to}（${why}）`);
    } catch (e) {
      log(`${x.tag} 改预算失败：${e.message}`);
    }
  }

  if (acts.length && !dry) {
    saveState(st);
    const cur = currentPlan();
    for (const a of acts) {
      const acc = metrics.find((m) => m.tag === a.tag);
      if (acc) cur[acc.id] = a.to;
    }
    savePlan(cur);
    const totalNow = Object.values(cur).reduce((s, v) => s + Number(v || 0), 0);
    const lines = [
      `### 【快手·预算调拨】${new Date().toLocaleDateString('zh-CN')} ${String(hour).padStart(2, '0')}时`,
      '',
      `口径：每户额度 ≥ 2×消耗（利用率 ≤50%），两户合计 ${total} 不变。`,
      '',
    ];
    acts.forEach((a) => lines.push(`- **${a.tag}** ${a.from} → **${a.to}** 元（${a.why}）`));
    lines.push('', `当前切分：${Object.entries(cur).map(([id, v]) => `${(CFG.accounts.find((x) => x.id === id) || {}).tag || id} ${v}`).join(' / ')}（合计 ${totalNow}）`);
    pushDingtalk(lines.join('\n'));
  }
  return acts;
}

module.exports = { rebalance, computePlan, currentPlan };
