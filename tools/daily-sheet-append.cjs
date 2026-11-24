/* eslint-disable */
/**
 * 盼之电竞信息流投放日报表 —— 每日自动填行。
 *
 *   node tools/daily-sheet-append.cjs                 # 填昨日完整数据（daemon 09:35 触发）
 *   node tools/daily-sheet-append.cjs --date today    # 填当日（daemon 23:30 触发，次日会被覆盖成落定值）
 *   node tools/daily-sheet-append.cjs --date 2026-11-23
 *
 * 幂等：表格里已有该日期行 → 整行覆盖更新；没有 → 末尾追加。
 * 口径（与盯盘一致）：展示数=素材曝光（aclick），行为数=点击（bclick），行为率=行为数/展示数。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'monitor.config.json'), 'utf8'));
const DWS_JS = path.join(
  process.env.USERPROFILE || '',
  '.workbuddy',
  'binaries',
  'node',
  'cli-connector-packages',
  'node_modules',
  'dingtalk-workspace-cli',
  'bin',
  'dws.js',
);
const SHEET = CFG.dailySheet || {};
const log = (m) => console.log(`[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${m}`);

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dws(args) {
  const r = spawnSync(process.execPath, [DWS_JS, 'sheet', ...args, '--format', 'json'], {
    encoding: 'utf-8',
    timeout: 60000,
  });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  try {
    return JSON.parse(out);
  } catch {
    return { __raw: out.slice(0, 300) };
  }
}

const api = async (p, body) => {
  const res = await fetch(`${CFG.api}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
};

const f2 = (v) => Math.round(Number(v || 0) * 100) / 100;

/** 组一行日报数据；无投放数据返回 null */
async function buildRow(dateStr) {
  const r = await api('/api/report/level/account', {
    advertiserId: SHEET.advertiserId,
    startDate: dateStr,
    endDate: dateStr,
    page: 1,
    pageSize: 20,
  });
  const rows = r.rows || [];
  const row = rows.find((x) => Number(x.statHour) === 0) || rows.sort((a, b) => Number(b.charge || 0) - Number(a.charge || 0))[0];
  if (!row || Number(row.charge || 0) === 0 && Number(row.show || 0) === 0) return null;

  const show = Number(row.show || 0);
  const charge = Number(row.charge || 0);
  const kds =
    row.impression1kCost != null && Number(row.impression1kCost) > 0
      ? Number(row.impression1kCost)
      : show > 0
        ? (charge / show) * 1000
        : 0;
  const acts = Number(row.bclick || 0);
  const actRatio = row.actionRatio != null ? Number(row.actionRatio) : acts > 0 && show > 0 ? acts / show : 0;
  return [
    dateStr,
    f2(charge),
    show,
    f2(kds),
    acts,
    (actRatio * 100).toFixed(2) + '%',
    // 「注册」口径 = 激活：我们把注册当激活回传（ocpx180），所以这里取 activation 而非 registerCount
    Number(row.activation || 0),
    f2(row.activationCost),
    Number(row.payCount || 0),
    f2(row.payCost),
  ];
}

/** A 列找日期所在行（兼容 2026-11-23 / 2026/11/23 / 带时间后缀）；找不到返回 0 */
function findRow(dateStr) {
  const r = dws(['range', 'read', '--node', SHEET.nodeId, '--sheet-id', SHEET.sheetId, '--range', 'A2:A2000']);
  const cells = r.cells || [];
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i] && cells[i][0];
    const v = c && c.value;
    if (v == null) continue;
    const s = String(v instanceof Date ? ymd(v) : v).replace(/\//g, '-');
    if (s.startsWith(dateStr)) return i + 2;
  }
  return 0;
}

function updateRow(rowNo, values) {
  const vals = values.map((v) => ({ type: 'text', text: String(v) }));
  return dws(['range', 'update', '--node', SHEET.nodeId, '--sheet-id', SHEET.sheetId, '--range', `A${rowNo}:J${rowNo}`, '--values', JSON.stringify([vals])]);
}

/**
 * 末尾追加一行。不用 sheet append 命令（它会把数字写成文本，SUM 求和全为 0），
 * 改为定位末尾空行后用 range update 写入：text 数字服务端自动识别为真数字。
 * 汇总行固定在第 2 行，数据行从第 3 行起。
 */
function appendRow(values) {
  const r = dws(['range', 'read', '--node', SHEET.nodeId, '--sheet-id', SHEET.sheetId, '--range', 'A1:A2000']);
  const cells = r.cells || [];
  let last = 1;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i] && cells[i][0];
    if (c && c.value != null && String(c.value).trim() !== '') last = i + 1;
  }
  const rowNo = Math.max(last + 1, 3);
  const vals = values.map((v) => ({ type: 'text', text: String(v) }));
  return dws(['range', 'update', '--node', SHEET.nodeId, '--sheet-id', SHEET.sheetId, '--range', `A${rowNo}:J${rowNo}`, '--values', JSON.stringify([vals])]);
}

(async () => {
  if (!SHEET.enabled || !SHEET.nodeId || !SHEET.sheetId) {
    log('dailySheet 未配置或未启用，跳过');
    return;
  }
  const argIdx = process.argv.indexOf('--date');
  let date = argIdx >= 0 ? process.argv[argIdx + 1] : ymd(new Date(Date.now() - 86400000));
  if (date === 'today') date = ymd(new Date());

  const row = await buildRow(date);
  if (!row) {
    log(`${date} 无投放数据，不填表`);
    return;
  }
  const existing = findRow(date);
  if (existing > 0) {
    const r = updateRow(existing, row);
    log(`${date} 已有第 ${existing} 行 → 覆盖更新 ${r.__raw ? 'FAIL ' + r.__raw : 'OK'}`);
  } else {
    const r = appendRow(row);
    log(`${date} 末尾追加一行 ${r.__raw ? 'FAIL ' + r.__raw : 'OK'}`);
  }
})().catch((e) => {
  log(`填表失败：${e.message}`);
  process.exitCode = 1;
});
