/**
 * 网页版启动器：环境变量 + 数据库迁移 + 启动后端
 *
 * 为什么要这个文件（而不是全写在 .cmd 里）：
 *   批处理文件在中文 Windows 下按 GBK 解析，脚本里一旦出现中文路径（%APPDATA%\快手投放工作台），
 *   经 chcp/UTF-8 组合会被读花，导致 DATA_DIR / WEB_DIST 静默失效——
 *   表现为「服务起来了，但用的是空库、前端 404」。
 *   Node 源码固定按 UTF-8 解析，中文路径放这里绝对可靠；.cmd 保持纯 ASCII 只负责调用。
 *
 * 用法：node tools/web-launch.cjs
 */
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const serverDir = path.join(root, 'apps', 'server');
const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');

// 数据目录：与桌面版完全同源（账户、授权 token、盯盘历史都在这里）
const dataDir = path.join(appData, '快手投放工作台');

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

// 2) 启动后端（同源托管 apps/web/dist）
console.log('[2/2] 启动服务...');
console.log('      浏览器访问 http://127.0.0.1:' + process.env.PORT);
console.log('      数据目录 ' + dataDir);
console.log('      关闭本窗口即停止服务');
require(path.join(serverDir, 'dist', 'main.js'));
