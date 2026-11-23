/* eslint-disable */
/**
 * 后端自愈（2026-11-11）
 * 巡检 / 建计划脚本在跑业务前先调用 ensureBackend()：
 *   7801 不在线 → 直接 detached 拉起 tools/web-launch.cjs，等它就绪（最长 60s）。
 * 这样即使后端半夜挂了，下一次定时任务（每小时巡检 / 09:40 复投 / 14:00 测新 / 19:30 晚高峰）会自己把它拉回来。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUNTIME = path.join(ROOT, '.runtime');
const PROBE = 'http://127.0.0.1:7801/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pluginLog(msg) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  const line = `[${ts}] [ensure-backend] ${msg}`;
  console.log(line);
  try {
    if (!fs.existsSync(RUNTIME)) fs.mkdirSync(RUNTIME, { recursive: true });
    fs.appendFileSync(path.join(RUNTIME, 'backend-restarts.log'), line + '\n');
  } catch {
    /* ignore */
  }
}

async function probe() {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 4000);
  try {
    const r = await fetch(PROBE, { signal: ac.signal });
    clearTimeout(timer);
    return r.status < 500;
  } catch {
    clearTimeout(timer);
    return false;
  }
}

async function ensureBackend({ waitSeconds = 60 } = {}) {
  if (await probe()) return true;
  pluginLog('7801 不在线，自动拉起 web-launch');
  try {
    const out = fs.openSync(path.join(RUNTIME, 'server.log'), 'a');
    const p = spawn(process.execPath, [path.join(ROOT, 'tools', 'web-launch.cjs')], {
      cwd: ROOT,
      detached: true,
      stdio: ['ignore', out, out],
      env: process.env,
      windowsHide: true,
    });
    p.unref();
    pluginLog(`已拉起 pid=${p.pid}，等待就绪`);
  } catch (e) {
    pluginLog(`拉起失败：${e.message}`);
    return false;
  }
  const rounds = Math.ceil(waitSeconds / 3);
  for (let i = 0; i < rounds; i++) {
    await sleep(3000);
    if (await probe()) {
      pluginLog(`✅ 后端已恢复（约 ${(i + 1) * 3}s）`);
      return true;
    }
  }
  pluginLog(`❌ ${waitSeconds}s 内仍未就绪`);
  return false;
}

module.exports = { ensureBackend, probe, ensureWatchdog };

/**
 * 让分钟级守护常驻：定时任务每次跑都检查一遍，没在跑就 detached 拉起。
 * 这样即使守护本身被回收，下一个小时的巡检会把它重新装上。
 */
function ensureWatchdog() {
  const pidFile = path.join(RUNTIME, 'watchdog.pid');
  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf-8').trim());
    if (pid > 0) {
      process.kill(pid, 0); // 存活则直接返回
      return true;
    }
  } catch {
    /* 不存在或已退出 → 重启 */
  }
  try {
    const out = fs.openSync(path.join(RUNTIME, 'watchdog.out.log'), 'a');
    const p = spawn(process.execPath, [path.join(ROOT, 'tools', 'watchdog.cjs')], {
      cwd: ROOT,
      detached: true,
      stdio: ['ignore', out, out],
      env: process.env,
      windowsHide: true,
    });
    p.unref();
    pluginLog(`守护进程未运行，已拉起 pid=${p.pid}`);
    return true;
  } catch (e) {
    pluginLog(`守护拉起失败：${e.message}`);
    return false;
  }
}
