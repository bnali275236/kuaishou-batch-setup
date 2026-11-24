/* eslint-disable */
/**
 * 后端守护进程（2026-11-11）
 *
 * 为什么需要它：会话里拉起的 node 进程会随会话/沙箱回收，定时任务只能发现掉线、没法自己把进程拉起来。
 * 这个守护独立运行（建议开机自启）：
 *   - 每 60 秒探测 http://127.0.0.1:7801/
 *   - 连续 2 次探测失败 → 用 node 拉起 tools/web-launch.cjs（detached，与本进程解耦）
 *   - 拉起后 15 秒复检，仍失败则 3 分钟后再试（指数退避，最多 5 分钟）
 *   - 每日重启上限 30 次，防止无脑循环
 *   - 日志：.runtime/watchdog.log，后端输出：.runtime/server.log
 *
 * 用法：node tools/watchdog.cjs  （或双击仓库根目录 启动守护.cmd）
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUNTIME = path.join(ROOT, '.runtime');
const LOG = path.join(RUNTIME, 'watchdog.log');
const SERVER_LOG = path.join(RUNTIME, 'server.log');
const PROBE = 'http://127.0.0.1:7801/';
const INTERVAL = 60 * 1000;
const PROBE_TIMEOUT = 6000;
const MAX_RESTART_PER_DAY = 30;

if (!fs.existsSync(RUNTIME)) fs.mkdirSync(RUNTIME, { recursive: true });

/* 单实例保护：已有守护在跑就退出，避免多个守护抢着拉后端。
 * 注意：不能只看「pid 存活」——Windows 会复用 PID，旧 pid 文件会误判成「已有守护」，
 * 导致双击 启动守护.cmd 后新进程立刻退出（2026-11-11 用户遇到的就是这个）。
 * 判据改为：pid 存活 且 心跳文件在 3 分钟内更新过。 */
const PID_FILE = path.join(RUNTIME, 'watchdog.pid');
const BEAT_FILE = path.join(RUNTIME, 'watchdog.beat');
try {
  const old = Number(fs.readFileSync(PID_FILE, 'utf-8').trim());
  if (old && old !== process.pid) {
    let alive = false;
    try {
      process.kill(old, 0);
      alive = true;
    } catch {
      /* 进程不存在 */
    }
    let beatFresh = false;
    try {
      const bt = Number(fs.readFileSync(BEAT_FILE, 'utf-8').trim());
      beatFresh = bt > 0 && Date.now() - bt < 3 * 60 * 1000;
    } catch {
      /* 没有心跳文件 */
    }
    if (alive && beatFresh) {
      console.log(`[watchdog] 已有守护在运行 pid=${old}，本次退出`);
      process.exit(0);
    }
    console.log(`[watchdog] 旧记录 pid=${old}（存活=${alive}，心跳新鲜=${beatFresh}），本次接管`);
  }
} catch {
  /* 旧进程不存在，继续 */
}
fs.writeFileSync(PID_FILE, String(process.pid));
try {
  fs.writeFileSync(BEAT_FILE, String(Date.now()));
} catch {
  /* ignore */
}

function log(m) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  const line = `[${ts}] ${m}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG, line + '\n');
    // 日志超 2MB 自动截断，避免无限增长
    if (fs.statSync(LOG).size > 2 * 1024 * 1024) {
      const keep = fs.readFileSync(LOG, 'utf-8').split('\n').slice(-800).join('\n');
      fs.writeFileSync(LOG, keep);
    }
  } catch {
    /* ignore */
  }
}

async function isUp() {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT);
  try {
    const r = await fetch(PROBE, { signal: ac.signal });
    clearTimeout(timer);
    return r.status < 500;
  } catch {
    clearTimeout(timer);
    return false;
  }
}

let restartCount = 0;
let day = new Date().toISOString().slice(0, 10);
let failStreak = 0;
let nextAllowed = 0;
let lastHeartbeat = 0;

function bumpDay() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) {
    day = today;
    restartCount = 0;
    log(`跨天，重启计数归零`);
  }
}

function startServer(reason) {
  const out = fs.openSync(SERVER_LOG, 'a');
  const p = spawn(process.execPath, [path.join(ROOT, 'tools', 'web-launch.cjs')], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
    windowsHide: true,
  });
  p.unref();
  log(`后端不在线（${reason}），已拉起 web-launch pid=${p.pid}`);
  return p;
}

/* ---------------- 盯盘守护（monitor-daemon）存活保障 ----------------
 * monitor-daemon 负责整点巡检 → 推送钉钉私群。
 * 它通常由 web-launch 拉起；这里再兜一层：心跳过期就补拉，避免「launcher 是老版本」时无人值守。
 */
const MONITOR_DAEMON = path.join(__dirname, 'monitor-daemon.cjs');
const DAEMON_BEAT = path.join(RUNTIME, 'daemon.beat');
let lastDaemonSpawn = 0;
function ensureMonitorDaemon() {
  try {
    const st = fs.statSync(DAEMON_BEAT);
    if (Date.now() - st.mtimeMs < 3 * 60 * 1000) return; // 心跳新鲜，活着
  } catch {
    /* 没有心跳文件 → 视作没在跑 */
  }
  if (Date.now() - lastDaemonSpawn < 5 * 60 * 1000) return; // 5 分钟内只补拉一次，防风暴
  lastDaemonSpawn = Date.now();
  try {
    const out = fs.openSync(path.join(RUNTIME, 'monitor-daemon.out.log'), 'a');
    const p = spawn(process.execPath, [MONITOR_DAEMON], {
      cwd: ROOT,
      detached: true,
      stdio: ['ignore', out, out],
      env: process.env,
      windowsHide: true,
    });
    p.unref();
    log(`盯盘守护未在跑，已拉起 pid=${p.pid}`);
  } catch (e) {
    log(`盯盘守护拉起失败：${e.message}`);
  }
}

async function tick() {
  bumpDay();
  ensureMonitorDaemon();
  // 每轮都刷新心跳，供单实例判断使用（不做它，pid 复用时会把新守护挡在门外）
  try {
    fs.writeFileSync(BEAT_FILE, String(Date.now()));
  } catch {
    /* ignore */
  }
  const up = await isUp();
  if (up) {
    if (failStreak > 0) log(`后端恢复（探测成功），失败计数清零`);
    failStreak = 0;
    // 每 2 小时写一条心跳，便于确认守护本身活着
    if (Date.now() - lastHeartbeat > 2 * 3600 * 1000) {
      lastHeartbeat = Date.now();
      log(`心跳：7801 正常，今日已重启 ${restartCount}/${MAX_RESTART_PER_DAY} 次`);
    }
    return;
  }

  failStreak += 1;
  if (failStreak < 2) {
    log(`探测失败 1 次，下一轮复检`);
    return;
  }
  if (Date.now() < nextAllowed) {
    log(`后端仍不在线，退避中（${Math.ceil((nextAllowed - Date.now()) / 1000)}s 后重试）`);
    return;
  }
  if (restartCount >= MAX_RESTART_PER_DAY) {
    log(`⚠ 今日已重启 ${restartCount} 次，达上限，停止自动拉起——请检查数据库/端口/授权`);
    return;
  }

  restartCount += 1;
  try {
    startServer(`连续 ${failStreak} 次探测失败`);
  } catch (e) {
    log(`拉起失败：${e.message}`);
  }
  // 给后端 15 秒启动时间再复检
  setTimeout(async () => {
    if (await isUp()) {
      log(`✅ 后端已恢复（本次拉起成功）`);
      failStreak = 0;
      nextAllowed = 0;
    } else {
      const wait = Math.min(5 * 60 * 1000, 60 * 1000 * Math.pow(2, Math.min(restartCount - 1, 3)));
      nextAllowed = Date.now() + wait;
      log(`❌ 拉起后仍不可用，${Math.round(wait / 1000)}s 后再试`);
    }
  }, 15000);
}

log(`守护启动 pid=${process.pid}，探测 ${PROBE}，间隔 ${INTERVAL / 1000}s，日志 ${LOG}`);
tick();
setInterval(tick, INTERVAL);

process.on('SIGINT', () => {
  log('守护收到中断，退出');
  process.exit(0);
});
process.on('uncaughtException', (e) => log(`未捕获异常：${e.message}`));
