/**
 * 网页版启动器：环境变量 + 数据库迁移 + 守护启动后端
 *
 * 为什么要这个文件（而不是全写在 .cmd 里）：
 *   批处理文件在中文 Windows 下按 GBK 解析，脚本里一旦出现中文路径（%APPDATA%\快手投放工作台），
 *   经 chcp/UTF-8 组合会被读花，导致 DATA_DIR / WEB_DIST 静默失效——
 *   表现为「服务起来了，但用的是空库、前端 404」。
 *   Node 源码固定按 UTF-8 解析，中文路径放这里绝对可靠；.cmd 保持纯 ASCII 只负责调用。
 *
 * 为什么要「守护」：
 *   设置页的「保存并重启生效」是写 .restart-intent 标记后 process.exit(0)，
 *   桌面版由 Electron 主进程把它重新拉起；网页版没有 Electron，
 *   没有守护就会出现「点完重启，服务再也没起来」。这里由启动器自己看标记重启。
 *
 * 用法：node tools/web-launch.cjs
 */
const path = require('path');
const fs = require('fs');
const { spawnSync, spawn } = require('child_process');

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

// 1) 迁移（幂等）：升级后新增字段/表必须先补，否则 Prisma 查询会报表不存在
const prismaCli = path.join(root, 'node_modules', 'prisma', 'build', 'index.js');
const schema = path.join(serverDir, 'prisma', 'schema.prisma');
console.log('[1/2] 应用数据库迁移...');
const mig = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy', '--schema', schema], {
  cwd: serverDir,
  env: process.env,
  stdio: 'inherit',
});
if (mig.status !== 0) {
  console.error('[错误] 数据库迁移失败，请把上方报错截图发给管理员。');
  process.exit(1);
}

// 2) 守护启动后端（同源托管 apps/web/dist）
console.log('[2/2] 启动服务...');
console.log('      浏览器访问 http://127.0.0.1:' + process.env.PORT);
console.log('      数据目录 ' + dataDir);
console.log('      关闭本窗口即停止服务');

let restarts = 0;
let lastStart = 0;

function startServer() {
  lastStart = Date.now();
  const child = spawn(process.execPath, [serverEntry], {
    cwd: serverDir,
    env: process.env,
    stdio: 'inherit',
  });

  const forward = (sig) => () => {
    try {
      child.kill(sig);
    } catch {
      /* 子进程已退出 */
    }
  };
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));

  child.on('exit', (code, signal) => {
    if (fs.existsSync(restartMarker)) {
      try {
        fs.unlinkSync(restartMarker);
      } catch {
        /* 标记删不掉也不影响重启 */
      }
      // 崩溃保护：60 秒内反复退出就不要再无限重启了
      restarts = Date.now() - lastStart < 60_000 ? restarts + 1 : 0;
      if (restarts >= 5) {
        console.error('[web-launcher] 服务短时间内反复退出，已停止自动重启，请查看上方日志。');
        process.exit(1);
      }
      console.log('[web-launcher] 检测到重启请求，正在重启服务…');
      setTimeout(startServer, 800);
      return;
    }
    console.log(`[web-launcher] 服务已退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`);
    process.exit(code ?? 0);
  });
}

startServer();
