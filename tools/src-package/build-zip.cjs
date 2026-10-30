/**
 * 把整理好的源码目录打成 zip（UTF-8 文件名，中文解压不乱码）。
 *
 * 用法：先 node tools/src-package/build-src-package.cjs
 *      再 node tools/src-package/build-zip.cjs
 * 输出：<仓库根>/快手投放工作台-源码-v0.6.1.zip
 *
 * 依赖 archiver（来自仓库 node_modules，勿在无依赖环境运行）。
 */
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const ROOT = path.resolve(__dirname, '..', '..');
const PKG_NAME = '快手投放工作台-源码-v0.6.1';
const SRC = path.join(ROOT, '.tmp-pack', PKG_NAME);
const OUT = path.join(ROOT, `${PKG_NAME}.zip`);

if (!fs.existsSync(SRC)) {
  console.error('源码目录不存在，请先跑 tools/src-package/build-src-package.cjs');
  process.exit(1);
}
if (fs.existsSync(OUT)) fs.renameSync(OUT, path.join(__dirname, `.old-${Date.now()}.zip`));

const output = fs.createWriteStream(OUT);
const archive = archiver('zip', { zlib: { level: 6 }, forceLocalTime: true });

output.on('close', () => {
  console.log(`✅ ${OUT}`);
  console.log(`大小 ${(archive.pointer() / 1024 / 1024).toFixed(2)} MB`);
});
archive.on('warning', (err) => {
  if (err.code === 'ENOENT') console.warn(err.message);
  else throw err;
});
archive.on('error', (err) => {
  throw err;
});

archive.pipe(output);
archive.directory(SRC, PKG_NAME);
archive.finalize();
