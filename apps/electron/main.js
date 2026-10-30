/**
 * 快手投放工作台 - Electron 主进程
 *
 * 职责：
 *  1. 单实例锁（防止双开导致 SQLite 锁冲突 / 端口冲突）
 *  2. 用 Electron 自带的 Node（ELECTRON_RUN_AS_NODE）跑 prisma migrate deploy，
 *     首次启动自动建库，升级版本自动补迁移 —— 新电脑无需任何手工步骤
 *  3. 同样方式拉起 NestJS 后端（端口从 7801 起自动找空闲），DATA_DIR 指到 userData
 *  4. 轮询健康检查通过后，窗口加载 http://127.0.0.1:<port>/（后端同源托管前端静态资源）
 *
 * 打包产物布局（extraResources → resources/desktop）：
 *  desktop/
 *    server/dist/          NestJS 编译产物
 *    server/node_modules/  生产依赖（含 prisma CLI 与引擎）
 *    server/prisma/        schema + migrations
 *    web/dist/             前端构建产物
 */
const { app, BrowserWindow, shell, dialog, session } = require('electron');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');

const isDev = !app.isPackaged;

log(`main.js 已加载（isDev=${isDev}）`);

/** 静态资源根目录：开发态指向 apps/electron/resources，打包后指向 resources/desktop */
const resourcesRoot = isDev
  ? path.join(__dirname, 'resources')
  : path.join(process.resourcesPath, 'desktop');

const serverDir = path.join(resourcesRoot, 'server');
const webDist = path.join(resourcesRoot, 'web', 'dist');
const serverEntry = path.join(serverDir, 'dist', 'main.js');
const prismaCli = path.join(serverDir, 'node_modules', 'prisma', 'build', 'index.js');
const prismaSchema = path.join(serverDir, 'prisma', 'schema.prisma');

/** 数据目录：与浏览器端隔离，卸载重装不丢数据（NSIS deleteAppDataOnUninstall=false） */
const dataDir = app.getPath('userData');
const logsDir = path.join(dataDir, 'logs');
const desktopLog = path.join(logsDir, 'desktop.log');

/**
 * 重启意图标记（后端 /api/system/restart 写入，这里消费）。
 * 为什么需要：切换「局域网共享」要改监听地址，而监听地址只能在启动时决定，
 * 所以必须重启后端进程。但「后端自己退出」和「后端崩了」在外部看起来一样 ——
 * 靠这个标记区分：有标记 = 我们主动要求重启（静默拉起来），无标记 = 真崩了（弹窗）。
 */
const restartMarker = path.join(dataDir, '.restart-intent');

/** 消费重启标记：存在则删除并返回 true */
function consumeRestartIntent() {
  try {
    if (!fs.existsSync(restartMarker)) return false;
    fs.rmSync(restartMarker, { force: true });
    return true;
  } catch (err) {
    log(`读取重启标记失败（按未请求重启处理）：${err.message}`);
    return false;
  }
}

/** 统一日志：文件 + 控制台，排障直接看 %APPDATA%/快手投放工作台/logs/desktop.log */
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    fs.appendFileSync(desktopLog, line + '\n');
  } catch {
    /* 日志失败不影响主流程 */
  }
  console.log(line);
}

/** 从 start 起找第一个空闲端口（最多试 20 个） */
function findFreePort(start) {
  return new Promise((resolve, reject) => {
    let port = start;
    const tryNext = () => {
      if (port > start + 20) {
        reject(new Error(`端口 ${start}~${port} 都被占用`));
        return;
      }
      const srv = net.createServer();
      srv.once('error', () => {
        port += 1;
        tryNext();
      });
      srv.once('listening', () => srv.close(() => resolve(port)));
      srv.listen(port, '127.0.0.1');
    };
    tryNext();
  });
}

/** 轮询 /api/system/health 直到就绪或超时 */
function waitHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/system/health', timeout: 2000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          resolve();
        } else if (Date.now() < deadline) {
          setTimeout(attempt, 500);
        } else {
          reject(new Error(`健康检查超时（HTTP ${res.statusCode}）`));
        }
      });
      req.on('error', () => {
        if (Date.now() < deadline) setTimeout(attempt, 500);
        else reject(new Error('健康检查超时：后端未能启动'));
      });
      req.on('timeout', () => req.destroy());
    };
    attempt();
  });
}

/** 桌面版子进程公共环境：让 Electron 的可执行文件以纯 Node 模式运行 */
function childEnv(extra) {
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'production',
    ELECTRON_NO_ATTACH_CONSOLE: '1',
    ...extra,
  };
}

/* ---------------------------------------------------------------------------
 * VC++ 2015-2022 运行库检测
 *
 * Prisma 的查询引擎（query_engine-windows.dll.node）和迁移引擎依赖
 * msvcp140 / vcruntime140，全新 Windows 系统普遍没有，缺失时后端进程
 * 加载引擎即崩 → 健康检查超时。安装包内已内置 vc_redist.x64.exe，
 * 检测到缺失时引导用户一次装好。
 * ------------------------------------------------------------------------ */
const VC_RUNTIME_DLLS = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'];
const VCRUNTIME_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';
const vcRedistPath = path.join(resourcesRoot, 'redist', 'vc_redist.x64.exe');

function vcMissing() {
  const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  return VC_RUNTIME_DLLS.filter((f) => !fs.existsSync(path.join(sys32, f)));
}

/** 返回 true = 运行库就绪（或缺失但不阻断，留给日志/弹窗说明） */
async function ensureVcRuntime() {
  const missing = vcMissing();
  if (missing.length === 0) return true;
  log(`缺少 VC++ 运行库：${missing.join(', ')}（prisma 引擎依赖，缺失会导致后端无法启动）`);

  if (!fs.existsSync(vcRedistPath)) {
    log(`安装包内未内置 vc_redist（${vcRedistPath}），可手动下载：${VCRUNTIME_URL}`);
    return false;
  }
  const choice = dialog.showMessageBoxSync({
    type: 'warning',
    title: '需要安装系统组件',
    message: '检测到本机缺少 Microsoft VC++ 运行库（后端数据库引擎依赖）。',
    detail: '点击「立即安装」，在弹出的系统确认框中选择「是」即可，仅需安装一次。',
    buttons: ['立即安装', '暂不安装'],
    defaultId: 0,
    cancelId: 1,
  });
  if (choice !== 0) {
    log('用户跳过 VC++ 运行库安装，继续尝试启动');
    return false;
  }
  log('启动 vc_redist 静默安装（需用户在 UAC 弹窗确认）…');
  await new Promise((resolve) => {
    const ps = spawn(
      'powershell.exe',
      [
        '-NoProfile', '-NonInteractive', '-Command',
        `Start-Process -FilePath '${vcRedistPath}' -ArgumentList '/install','/quiet','/norestart' -Verb RunAs -Wait; exit 0`,
      ],
      { windowsHide: true },
    );
    // -Wait + exit 0：即使用户取消 UAC 也不卡死，后面靠重新检测判断结果
    ps.on('error', (err) => {
      log(`vc_redist 安装进程异常：${err.message}`);
      resolve();
    });
    ps.on('exit', resolve);
  });
  const still = vcMissing();
  if (still.length === 0) {
    log('VC++ 运行库安装成功');
    return true;
  }
  log(`VC++ 运行库安装后仍缺失：${still.join(', ')}`);
  return false;
}

/** 首启动建库 / 升级补迁移：prisma migrate deploy（幂等，无迁移时秒过） */
async function runMigrate() {
  if (!fs.existsSync(prismaCli)) {
    log(`未找到 prisma CLI：${prismaCli}（跳过迁移，可能影响首次建库）`);
    return { ok: false, output: 'prisma CLI 缺失' };
  }
  const dbUrl = 'file:' + path.join(dataDir, 'app.db').replace(/\\/g, '/');
  // 注意用异步 spawn 而非 spawnSync：electron.exe 是 GUI 子系统程序，
  // spawnSync 会立即返回且拿不到 stdio（exit null / 输出为空），根本等不到迁移结束。
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [prismaCli, 'migrate', 'deploy', '--schema', prismaSchema],
      {
        cwd: serverDir,
        windowsHide: true,
        env: childEnv({ DATABASE_URL: dbUrl, DATA_DIR: dataDir }),
      },
    );
    const out = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => out.push(d));
    const timer = setTimeout(() => child.kill(), 180 * 1000);
    child.on('error', (err) => {
      clearTimeout(timer);
      log(`数据库迁移进程异常：${err.message}`);
      resolve({ ok: false, output: err.message });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(out).toString('utf8').trim();
      if (code === 0) {
        log(`数据库迁移完成：${output.split('\n').slice(-3).join(' | ')}`);
        resolve({ ok: true, output });
      } else {
        const hint = /msvcp140|vcruntime140|api-ms-win/i.test(output)
          ? '（疑似缺少 VC++ 运行库，请安装 Microsoft Visual C++ 2015-2022 Redistributable x64）'
          : '';
        log(`数据库迁移失败（exit ${code}）${hint}：${output.slice(0, 2000)}`);
        resolve({ ok: false, output });
      }
    });
  });
}

/**
 * 版本升级后清一次 HTTP 缓存（防「升级即白屏」）。
 *
 * 背景：打包产物的 bundle 文件名带内容 hash，而 index.html 会被 Chromium 的
 * 磁盘缓存留住。升级后新版 bundle 换了文件名，客户端却仍拿旧 index.html，
 * 去请求已被清理的旧 bundle → 模块脚本加载失败 → 整页白屏。
 * （0.5.1 实测踩坑：清缓存前加载旧 index-DcSC_Xws.js 白屏，清后加载新
 *  index-0kPc30yp.js 恢复正常。服务端已给 index.html 加 no-store，
 *  这里是针对「已经污染过的老缓存」的必要兜底。）
 *
 * 只在版本号变化时清，正常启动零开销。
 */
async function clearCacheOnUpgrade() {
  try {
    const marker = path.join(dataDir, '.last-version');
    const current = app.getVersion();
    let last = '';
    try {
      last = fs.readFileSync(marker, 'utf8').trim();
    } catch {
      /* 首次运行或标记文件缺失：按需清理 */
    }
    if (last === current) return;
    await session.defaultSession.clearCache();
    fs.writeFileSync(marker, current);
    log(`版本 ${last || '(首次)'} → ${current}：已清理 HTTP 缓存（防止旧页面残留导致白屏）`);
  } catch (err) {
    log(`清理 HTTP 缓存失败（忽略，不影响启动）：${err.message}`);
  }
}

let serverChild = null;
/** 主动退出中：此时后端被 kill 属于预期，不能弹「后端异常退出」 */
let quitting = false;
/** 后端输出环形缓冲：健康检查失败时直接把原因带进弹窗，不用用户翻日志文件 */
const serverLogTail = [];
const TAIL_MAX = 60;

/** 拉起 NestJS 后端（同源托管前端），返回实际端口 */
async function startServer() {
  if (!fs.existsSync(serverEntry)) {
    throw new Error(`后端入口不存在：${serverEntry}（请先执行打包脚本 stage.js）`);
  }
  const port = await findFreePort(7801);
  log(`启动后端：端口 ${port}，数据目录 ${dataDir}`);

  serverLogTail.length = 0;
  serverChild = spawn(process.execPath, [serverEntry], {
    cwd: serverDir,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv({
      DATA_DIR: dataDir,
      PORT: String(port),
      WEB_DIST: webDist,
      // 桌面版环境变量优先，避免读到开发目录的 .env
      NODE_CONFIG_DIR: '',
    }),
  });

  serverChild.stdout.on('data', (buf) => appendServerLog(buf));
  serverChild.stderr.on('data', (buf) => appendServerLog(buf));

  return new Promise((resolve, reject) => {
    let settled = false;

    const tailText = () =>
      serverLogTail.length > 0
        ? `\n\n后端最近日志：\n${serverLogTail.slice(-15).join('\n')}`
        : '\n\n（后端没有任何输出，可能被杀毒软件拦截或依赖加载失败）';

    serverChild.on('exit', (code) => {
      log(`后端进程退出（exit ${code}）`);
      serverChild = null;

      // 应用正在退出：后端被 kill 是预期行为，静默即可
      if (quitting) return;

      // 主动重启（切换局域网共享后生效）：静默拉起，不打扰用户
      if (consumeRestartIntent()) {
        settled = true;
        log('检测到重启请求，正在重新拉起后端…');
        void restartServer();
        return;
      }

      if (!settled) {
        settled = true;
        reject(new Error(`后端进程启动即退出（exit ${code}）${tailText()}`));
      } else {
        // 已就绪后的崩溃：提示用户重启应用
        dialog.showMessageBox({
          type: 'error',
          title: '后端服务已退出',
          message: `后端服务异常退出（exit ${code}），请重新打开应用。`,
          detail: `若反复出现，请把日志发给管理员：\n${desktopLog}`,
          buttons: ['确定'],
        });
      }
    });

    // 慢机器 / 杀软全盘扫描可能拖慢首次启动，放宽到 120 秒
    waitHealth(port, 120 * 1000).then(
      () => {
        if (settled) return;
        settled = true;
        log('后端健康检查通过');
        resolve(port);
      },
      (err) => {
        if (settled) return;
        settled = true;
        reject(new Error(`${err.message}${tailText()}`));
      },
    );
  });
}

/**
 * 重启后端（切换局域网共享后生效）并让窗口加载新地址。
 * 端口可能变化（findFreePort 从 7801 起找第一个空闲），所以必须重新 loadURL。
 */
async function restartServer() {
  try {
    const port = await startServer();
    log(`后端已重启，端口 ${port}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(`http://127.0.0.1:${port}/`);
    }
  } catch (err) {
    log(`重启后端失败：${err.message}`);
    showStartupError(err.message);
  }
}

function appendServerLog(buf) {
  for (const line of buf.toString().split('\n')) {
    const t = line.trim();
    if (!t) continue;
    log(`[server] ${t}`);
    serverLogTail.push(t);
    if (serverLogTail.length > TAIL_MAX) serverLogTail.shift();
  }
}

/** 启动失败弹窗：错误原因 + 日志尾部 + 一键打开日志文件 */
function showStartupError(message) {
  const vcHint = vcMissing().length > 0
    ? `\n\n检测到本机缺少 VC++ 运行库，请下载安装后重试：\n${VCRUNTIME_URL}`
    : '';
  const logTail = (() => {
    try {
      const lines = fs.readFileSync(desktopLog, 'utf8').trim().split('\n');
      return '\n\n— 日志最后 10 行 —\n' + lines.slice(-10).join('\n');
    } catch {
      return '';
    }
  })();
  dialog.showMessageBox({
    type: 'error',
    title: '启动失败',
    message: '后端服务未能启动',
    detail: `${message}${vcHint}${logTail}\n\n完整日志：${desktopLog}`,
    buttons: ['打开日志文件', '确定'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  }).then(({ response }) => {
    if (response === 0) shell.showItemInFolder(desktopLog);
  });
}

let mainWindow = null;

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    title: '快手投放工作台',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(`http://127.0.0.1:${port}/`);

  // 外链（如 OAuth 授权页、快手后台）一律走系统默认浏览器，不在应用窗口里跳
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    log(`应用启动（packaged=${app.isPackaged}），数据目录：${dataDir}`);
    try {
      // Prisma 引擎依赖 VC++ 运行库：新电脑缺了必崩，先补齐再启动
      await ensureVcRuntime();

      // 版本升级时先清 HTTP 缓存，避免旧 index.html 残留导致新版白屏
      await clearCacheOnUpgrade();

      const mig = await runMigrate();
      if (!mig.ok) {
        // 迁移失败不直接崩：SQLite 有可能只是缺新表，后端能否跑起来交给健康检查判断
        log('迁移未成功，继续尝试启动后端（若启动失败会弹窗提示）');
      }
      const port = await startServer();
      createWindow(port);
    } catch (err) {
      log(`启动失败：${err.message}`);
      showStartupError(err.message);
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    if (serverChild) {
      log('正在停止后端进程…');
      serverChild.kill();
      serverChild = null;
    }
  });
}
