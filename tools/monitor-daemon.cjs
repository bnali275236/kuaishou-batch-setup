/* eslint-disable */
/**
 * 盯盘常驻调度器。
 *
 *   node tools/monitor-daemon.cjs          # 常驻（由启动网页版.cmd 自动拉起）
 *   node tools/monitor-daemon.cjs --once    # 只跑一次巡检（调试用）
 *
 * 节奏（2026-11-23 用户要求：1 小时一次）：
 *   · 每个整点（09:00–23:00）巡检一次
 *   · 09:30 改为「昨日复盘 + 今日基建清单」
 *   · 23:30 改为「日终小结」
 * 只报警、不执行任何写操作。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUNTIME = path.join(ROOT, '.runtime');
const LOG = path.join(RUNTIME, 'daemon.log');
const PID_FILE = path.join(RUNTIME, 'daemon.pid');
const BEAT_FILE = path.join(RUNTIME, 'daemon.beat');
const MONITOR = path.join(__dirname, 'monitor.cjs');
const SHEET_SCRIPT = path.join(__dirname, 'daily-sheet-append.cjs');

if (!fs.existsSync(RUNTIME)) fs.mkdirSync(RUNTIME, { recursive: true });
const say = (m) => {
  const d = new Date();const line = `[${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}] ${m}`;
  fs.appendFileSync(LOG, line + '\n');
  console.log(line);
};

// 单实例：pid 存活 **且** 心跳 3 分钟内更新，才算真在跑。
// 只看 pid 会踩 Windows PID 复用（上一个进程死了，pid 被别的进程占用）→ 误判「已在跑」→ 静默不起。
function beatingRecently() {
  try {
    const st = fs.statSync(BEAT_FILE);
    return Date.now() - st.mtimeMs < 3 * 60 * 1000;
  } catch {
    return false;
  }
}
try {
  if (fs.existsSync(PID_FILE)) {
    const old = Number(fs.readFileSync(PID_FILE, 'utf-8'));
    if (old && old !== process.pid && beatingRecently()) {
      try {
        process.kill(old, 0);
        say(`已有守护进程 PID ${old} 在跑（心跳正常），本进程退出`);
        process.exit(0);
      } catch {
        /* pid 已失效，继续 */
      }
    }
  }
} catch {
  /* 旧 PID 已失效，继续 */
}
fs.writeFileSync(PID_FILE, String(process.pid));
fs.writeFileSync(BEAT_FILE, new Date().toISOString());
setInterval(() => {
  try {
    fs.writeFileSync(BEAT_FILE, new Date().toISOString());
  } catch {
    /* ignore */
  }
}, 30 * 1000);

function run(mode) {
  const args = [MONITOR];
  if (mode === 'daily') args.push('--daily');
  if (mode === 'eod') args.push('--eod');
  const t0 = Date.now();
  const r = spawnSync(process.execPath, args, { encoding: 'utf-8', timeout: 10 * 60000 });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const tail = ((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-1)[0] || '';
  say(`${mode} 完成 ${secs}s ${r.status === 0 ? 'OK' : 'ERR'} ${tail.slice(0, 160)}`);
}

/** 钉钉日报表填行：09:35 填昨日落定值；23:30 填当日准实时（次日 09:35 会被覆盖成最终值） */
function runSheet(dateArg) {
  const args = [SHEET_SCRIPT];
  if (dateArg) args.push('--date', dateArg);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, args, { encoding: 'utf-8', timeout: 120000 });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const tail = ((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-1)[0] || '';
  say(`sheet 完成 ${secs}s ${r.status === 0 ? 'OK' : 'ERR'} ${tail.slice(0, 160)}`);
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function slotKey(d) {
  return `${d.getFullYear()}${d.getMonth() + 1}${d.getDate()}-${d.getHours()}-${d.getMinutes()}`;
}
let lastSlot = '';

function tick() {
  const d = new Date();
  const h = d.getHours();
  const m = d.getMinutes();
  // 整点巡检（1 小时一次）；09:30 / 23:30 两个半点专项
  const isSpecial = m === 30 && (h === 9 || h === 23);
  if (!(m === 0 || isSpecial)) return;
  const inWindow = (h > 9 || (h === 9 && m >= 0)) && (h < 23 || (h === 23 && m <= 30));
  if (!inWindow) return;
  const key = slotKey(d);
  if (key === lastSlot) return;
  lastSlot = key;

  if (h === 9 && m === 30) {
    run('daily');
    runSheet(); // 昨日落定值
  } else if (h === 23 && m === 30) {
    run('eod');
    runSheet('today'); // 当日准实时，次日覆盖成最终值
  } else run('watch');
}

if (process.argv.includes('--once')) {
  run('watch');
  process.exit(0);
}

say(`守护进程启动 PID ${process.pid}，1 小时一巡检（整点，09:00–23:00）`);
setInterval(tick, 20000);
tick();

process.on('SIGINT', () => {
  say('守护进程退出');
  process.exit(0);
});
