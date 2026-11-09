/* eslint-disable */
/**
 * 盯盘常驻调度器。
 *
 *   node tools/monitor-daemon.cjs          # 常驻（由启动网页版.cmd 自动拉起）
 *   node tools/monitor-daemon.cjs --once    # 只跑一次巡检（调试用）
 *
 * 节奏：
 *   · 每 30 分钟（:00 / :30）巡检一次，09:00–23:30 之外不巡检
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
const MONITOR = path.join(__dirname, 'monitor.cjs');

if (!fs.existsSync(RUNTIME)) fs.mkdirSync(RUNTIME, { recursive: true });
const say = (m) => {
  const d = new Date();const line = `[${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}] ${m}`;
  fs.appendFileSync(LOG, line + '\n');
  console.log(line);
};

// 单实例：已有存活守护进程就直接退出
try {
  if (fs.existsSync(PID_FILE)) {
    const old = Number(fs.readFileSync(PID_FILE, 'utf-8'));
    if (old && old !== process.pid) {
      process.kill(old, 0);
      say(`已有守护进程 PID ${old} 在跑，本进程退出`);
      process.exit(0);
    }
  }
} catch {
  /* 旧 PID 已失效，继续 */
}
fs.writeFileSync(PID_FILE, String(process.pid));

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

function slotKey(d) {
  return `${d.getFullYear()}${d.getMonth() + 1}${d.getDate()}-${d.getHours()}-${d.getMinutes()}`;
}
let lastSlot = '';

function tick() {
  const d = new Date();
  const h = d.getHours();
  const m = d.getMinutes();
  // 只在整点/半点触发，且 08:55–23:35 区间
  if (!(m === 0 || m === 30)) return;
  const inWindow = (h > 9 || (h === 9 && m >= 0)) && (h < 23 || (h === 23 && m <= 30));
  if (!inWindow) return;
  const key = slotKey(d);
  if (key === lastSlot) return;
  lastSlot = key;

  if (h === 9 && m === 30) run('daily');
  else if (h === 23 && m === 30) run('eod');
  else run('watch');
}

if (process.argv.includes('--once')) {
  run('watch');
  process.exit(0);
}

say(`守护进程启动 PID ${process.pid}，30 分钟一巡检（09:00–23:30）`);
setInterval(tick, 20000);
tick();

process.on('SIGINT', () => {
  say('守护进程退出');
  process.exit(0);
});
