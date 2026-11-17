/**
 * 网页版启动器 + 内置看门狗（2026-11-11 重写）
 *
 * 为什么要有这个文件（而不是全写在 .cmd 里）：
 *   批处理在中文 Windows 下按 GBK 解析，脚本里一旦出现中文路径（%APPDATA%\快手投放工作台），
 *   经 chcp/UTF-8 组合会被读花，导致 DATA_DIR / WEB_DIST 静默失效——
 *   表现为「服务起来了，但用的是空库、前端 404」。
 *   Node 源码固定按 UTF-8 解析，中文路径放这里绝对可靠；.cmd 保持纯 ASCII 只负责调用。
 *
 * 本次改造（解决「后端掉线没人管」）：
 *   1. 接管：启动时若发现 7801 被一个「无主」进程占着（例如上个会话残留），先杀干净再启动。
 *      若已被本启动器（有 lock 记录）正常占着，则提示并退出，避免两个窗口互杀。
 *   2. 常驻看门狗：子进程无论何种原因退出都重启（带指数退避，防崩溃风暴）。
 *   3. 健康探测：每 60 秒探一次 HTTP，连续 2 次失败视为卡死 → 杀掉重启。
 *   4. 日志：.runtime/launcher.log，便于事后查「什么时候掉的、为什么掉的」。
 *
 * 用法：node tools/web-launch.cjs（或双击仓库根目录 启动网页版.cmd）
 *   服务已在运行 → 自动打开浏览器，本窗口随即退出（不会弹黑框停留）
 *   服务未在运行 → 启动服务，就绪后自动打开浏览器
 *   加 --open 参数：纯「打开网页」语义，服务没跑就顺带启动（打开工作台.cmd）
 *   关闭窗口 / Ctrl+C 才会真正停止服务。
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawnSync, spawn, execSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const serverDir = path.join(root, 'apps', 'server');
const serverEntry = path.join(serverDir, 'dist', 'main.js');
const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');

// 数据目录：与桌面版完全同源（账户、授权 token、盯盘历史都在这里）
const dataDir = path.join(appData, '快手投放工作台');
const restartMarker = path.join(dataDir, '.restart-intent');

process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'production';
process.env.PORT = process.env.PORT || '7801';
process.env.WEB_DIST = path.join(root, 'apps', 'web', 'dist');
process.env.NODE_CONFIG_DIR = '';
process.env.DATABASE_URL = `file:${path.join(dataDir, 'app.db').replace(/\\/g, '/')}`;

const PORT = Number(process.env.PORT);
const RUNTIME = path.join(root, '.runtime');
const URL = `http://127.0.0.1:${PORT}`;

/** 用系统默认浏览器打开页面（fire-and-forget，失败不影响服务） */
function openBrowser(url) {
  try {
    const c = spawn('cmd.exe', ['/c', 'start', '', url || URL], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    c.on('error', () => {});
    c.unref();
    return true;
  } catch {
    return false;
  }
}
const LOG_FILE = path.join(RUNTIME, 'launcher.log');
const LOCK_FILE = path.join(RUNTIME, `launcher-${PORT}.pid`);
const HEALTH_INTERVAL = 60 * 1000; // 健康探测间隔
const HEALTH_FAIL_LIMIT = 2; // 连续失败多少次判定卡死
const MAX_RESTART_PER_DAY = 60; // 日重启上限，防死循环

if (!fs.existsSync(RUNTIME)) fs.mkdirSync(RUNTIME, { recursive: true });

function log(msg) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
    if (fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) {
      const keep = fs.readFileSync(LOG_FILE, 'utf-8').split('\n').slice(-800).join('\n');
      fs.writeFileSync(LOG_FILE, keep);
    }
  } catch {
    /* 日志失败不影响主流程 */
  }
}

/* ---------------- 端口与进程工具 ---------------- */

function probe(timeout = 2500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/', timeout }, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(0);
    });
    req.on('error', () => resolve(0));
  });
}

/** 列出监听指定端口的 PID（不含自己） */
function pidsOnPort(port) {
  const pids = new Set();
  try {
    const out = execSync('netstat -ano -p TCP', { encoding: 'utf-8', windowsHide: true, timeout: 8000 });
    for (const line of out.split(/\r?\n/)) {
      const t = line.trim();
      if (!/LISTENING/i.test(t)) continue;
      const cols = t.split(/\s+/);
      if (cols.length < 5) continue;
      const local = cols[1] || '';
      if (!local.endsWith(`:${port}`)) continue;
      const pid = Number(cols[cols.length - 1]);
      if (pid > 0 && pid !== process.pid) pids.add(pid);
    }
  } catch {
    /* netstat 失败就当没占用 */
  }
  return [...pids];
}

function killTree(pid) {
  try {
    execSync(`taskkill /F /T /PID ${pid}`, { windowsHide: true, timeout: 8000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ---------------- 启动前：清理占用 ---------------- */

async function takeOverPort() {
  const code = await probe(1500);
  const occupants = pidsOnPort(PORT);
  if (!occupants.length) return true;

  // 先看旧实例的 lock：如果主人还活着且服务健康，就不抢，
  // 直接当作「服务已在运行」处理（调用方会打开浏览器后退出）。
  let lockPid = 0;
  try {
    lockPid = Number(fs.readFileSync(LOCK_FILE, 'utf-8').trim());
  } catch {
    /* ignore */
  }
  if (lockPid && lockPid !== process.pid && isAlive(lockPid) && code === 200) {
    log(`服务已在运行（进程 ${lockPid}），无需重复启动`);
    return 'RUNNING';
  }

  // 先宣告接管（写 lock），再动别人的进程。
  // 旧实例的守护一旦发现 lock 不是自己，就会主动让位退出，不会来抢端口。
  try {
    fs.writeFileSync(LOCK_FILE, String(process.pid));
  } catch {
    /* ignore */
  }

  if (lockPid && lockPid !== process.pid && isAlive(lockPid)) {
    log(`检测到已有实例（进程 ${lockPid}），本窗口接管：旧实例会主动让位`);
  }
  log(`端口 ${PORT} 被占用（HTTP=${code || '无响应'}，PID=${occupants.join(',')}），执行接管…`);
  for (const pid of occupants) {
    killTree(pid) ? log(`  已结束进程 ${pid}`) : log(`  结束进程 ${pid} 失败（可能已退出）`);
  }
  // 等端口真正释放，最多 15 秒
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    if (!pidsOnPort(PORT).length) {
      log('  端口已释放，开始启动服务');
      return true;
    }
  }
  log('  [警告] 端口仍被占用，继续尝试启动（可能报 EADDRINUSE）');
  return true;
}

/* ---------------- 主流程 ---------------- */

// 1) 迁移（幂等）：升级后新增字段/表必须先补，否则 Prisma 查询会报表不存在
console.log('[1/3] 应用数据库迁移...');
const prismaCli = path.join(root, 'node_modules', 'prisma', 'build', 'index.js');
const schema = path.join(serverDir, 'prisma', 'schema.prisma');
const mig = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy', '--schema', schema], {
  cwd: serverDir,
  env: process.env,
  stdio: 'inherit',
});
if (mig.status !== 0) {
  console.error('[错误] 数据库迁移失败，请把上方报错截图发给管理员。');
  process.exit(1);
}

// 2) 端口接管 / --open 快捷打开
const OPEN_ONLY = process.argv.includes('--open');
let browserOpened = false;

(async () => {
  // --open 模式：服务已就绪 → 只开网页秒退（配合「打开工作台.cmd」）
  if (OPEN_ONLY) {
    if ((await probe(2000)) === 200) {
      console.log(`服务已在运行，正在打开浏览器 ${URL}`);
      openBrowser();
      await sleep(600);
      process.exit(0);
    }
    console.log('服务尚未启动，正在为您启动（就绪后会自动打开浏览器）...');
  }

  console.log(`[2/3] 检查端口 ${PORT}...`);
  const takeover = await takeOverPort();
  if (takeover === 'RUNNING') {
    // 服务健康且有人看管：本窗口只需打开网页，立即退出（黑窗口不会停留）
    console.log('      正在打开浏览器 ' + URL);
    openBrowser();
    await sleep(800);
    process.exit(0);
  }
  if (!takeover) {
    console.log('      本窗口可以关闭了。');
    // 给用户 8 秒看提示，然后退出（.cmd 里还有 pause 兜底）
    await sleep(8000);
    process.exit(0);
  }

  try {
    fs.writeFileSync(LOCK_FILE, String(process.pid));
  } catch {
    /* ignore */
  }

  console.log('[3/3] 启动服务（本窗口 = 服务 + 守护，请保持开启）...');
  console.log('      浏览器访问 ' + URL);
  console.log('      数据目录 ' + dataDir);
  console.log('      就绪后会自动打开浏览器；关闭本窗口即停止服务');
  console.log('');
  log(`启动器就绪 pid=${process.pid}，接管端口 ${PORT}`);

  startSupervisor();
  waitHealthyAndOpen();
})();

/** 由本窗口拉起的服务：等它就绪后自动打开浏览器（只开一次） */
async function waitHealthyAndOpen() {
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if (shuttingDown) return;
    if ((await probe(3000)) === 200) {
      if (!browserOpened) {
        browserOpened = true;
        log('服务就绪，自动打开浏览器');
        openBrowser();
      }
      return;
    }
  }
  log(`[警告] 服务 60 秒内未就绪，未能自动打开浏览器；请稍后手动访问 ${URL}`);
}

let child = null;
let lastStart = 0;
let crashCount = 0;
let shuttingDown = false;
let restartToday = 0;
let restartDay = new Date().getDate();
let healthFails = 0;
let healthTimer = null;
let starting = false;

function bumpDay() {
  const d = new Date().getDate();
  if (d !== restartDay) {
    restartDay = d;
    restartToday = 0;
  }
}

function startServer() {
  if (shuttingDown || starting) return;
  starting = true;
  bumpDay();
  lastStart = Date.now();
  healthFails = 0;

  child = spawn(process.execPath, [serverEntry], {
    cwd: serverDir,
    env: process.env,
    stdio: 'inherit',
  });
  log(`启动后端 pid=${child.pid}`);

  child.on('exit', (code, signal) => {
    starting = false;
    if (shuttingDown) {
      log(`后端已退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}），本窗口关闭`);
      process.exit(code ?? 0);
    }

    // 让位：如果 lock 已经不属于自己，说明另一个窗口接管了服务，本窗口安静退出，
    // 否则两个窗口会为了抢 7801 互相杀，形成重启风暴。
    try {
      const lockPid = Number(fs.readFileSync(LOCK_FILE, 'utf-8').trim());
      if (lockPid && lockPid !== process.pid) {
        log(`服务已被新窗口接管（进程 ${lockPid}），本窗口退出`);
        setTimeout(() => process.exit(0), 1200);
        return;
      }
    } catch {
      /* 没有 lock 视为自己仍是主人 */
    }

    // 设置页「保存并重启生效」写标记后主动退出
    const wantsRestart = fs.existsSync(restartMarker);
    if (wantsRestart) {
      try {
        fs.unlinkSync(restartMarker);
      } catch {
        /* ignore */
      }
    }

    const uptime = Date.now() - lastStart;
    crashCount = uptime < 60_000 ? crashCount + 1 : 0;

    // 退避：1s → 2s → 4s → 8s → 16s → 32s → 60s 封顶
    const delay = wantsRestart ? 800 : Math.min(1000 * Math.pow(2, Math.min(crashCount, 6)), 60_000);
    const reason = wantsRestart ? '收到重启请求' : `异常退出 code=${code ?? 'null'} signal=${signal ?? 'null'}`;
    log(`${reason}，运行 ${Math.round(uptime / 1000)}s，${Math.round(delay / 1000)}s 后重启（今日第 ${restartToday + 1} 次）`);

    if (restartToday >= MAX_RESTART_PER_DAY && crashCount >= 3) {
      log(`[熔断] 今日重启次数已达上限 ${MAX_RESTART_PER_DAY} 且持续崩溃，停止自动重启。请检查 .runtime/server.log`);
      process.exit(1);
    }
    restartToday++;
    setTimeout(startServer, delay);
  });
}

/** 60 秒一次健康探测：进程活着但 HTTP 不通 → 判定卡死，杀掉让它重启 */
function startSupervisor() {
  startServer();
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = setInterval(async () => {
    if (shuttingDown || starting) return;
    const code = await probe(6000);
    if (code === 200) {
      if (healthFails > 0) log(`健康探测恢复正常（HTTP 200）`);
      healthFails = 0;
      return;
    }
    healthFails++;
    log(`健康探测失败 ${healthFails}/${HEALTH_FAIL_LIMIT}（HTTP=${code || '无响应'}）`);
    if (healthFails >= HEALTH_FAIL_LIMIT && child && child.pid) {
      log(`连续 ${healthFails} 次无响应，判定卡死，重启后端`);
      healthFails = 0;
      killTree(child.pid);
    }
  }, HEALTH_INTERVAL);
}

/* 关窗口 / Ctrl+C：先停子进程，不再重启 */
function gracefulStop(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`收到 ${sig}，正在停止服务…`);
  if (healthTimer) clearInterval(healthTimer);
  try {
    if (child && child.pid) killTree(child.pid);
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', () => gracefulStop('SIGINT'));
process.on('SIGTERM', () => gracefulStop('SIGTERM'));
process.on('SIGHUP', () => gracefulStop('SIGHUP'));
process.on('uncaughtException', (e) => log(`[uncaught] ${e && e.message}`));
process.on('unhandledRejection', (e) => log(`[unhandledRejection] ${e && e.message}`));
