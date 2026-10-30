/**
 * 源码整理工具：从仓库复制出一份「干净、可迁移、可重新构建」的源码副本。
 *
 * 用法：node tools/src-package/build-src-package.cjs
 * 输出：.tmp-pack/<包名>/  —— 不含任何产物、密钥、本机数据
 *
 * 排除三类东西：
 *  1) 可重新生成的构建产物（dist / release / resources 里的 staging）
 *  2) 本机运行时数据与密钥（.data / .env / *.db / *.key）—— 绝不外流
 *  3) 临时文件（日志、截图、.tmp-*、vite 时间戳缓存）
 *
 * 另把散落在 .tmp-* 里的开发辅助脚本 / 平台文档快照归集到包内 tools/。
 * 版本号改了请同步 PKG_NAME。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const PKG_NAME = '快手投放工作台-源码-v0.6.1';
const OUT_ROOT = path.join(ROOT, '.tmp-pack');
const DEST = path.join(OUT_ROOT, PKG_NAME);

/** 按目录名排除（任意层级） */
const EXCLUDE_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'dist', // 所有构建产物
  'release', // electron-builder 安装包输出
  '.data', // 本机 SQLite + master.key
  '.tmp-diag',
  '.tmp-probe',
  '.tmp-verify',
  '.tmp-pack',
  '.fix-tmp',
  'edge-debug-profile',
  'cdp-driver',
]);

/** 按相对路径（相对仓库根）排除 */
const EXCLUDE_REL = new Set([
  'apps/electron/resources/server', // stage.js 生成的 staging 后端
  'apps/electron/resources/web', // stage.js 生成的 staging 前端
  '.workbuddy/tmp', // 大量临时截图 / 浏览器 profile
]);

/** 按文件名排除 */
const EXCLUDE_FILE_NAMES = new Set([
  '.env', // 含真实 APP_SECRET / APP_MASTER_KEY
  'broken-pkgs.txt',
  'broken-real.txt',
  'shell-check.png',
  '.tmp-launch-stderr.txt',
  '.tmp-launch-stdout.txt',
]);

const EXCLUDE_FILE_EXT = new Set(['.log', '.tsbuildinfo', '.zip']); // .zip：排除自身产物，避免自引用
const EXCLUDE_FILE_RE = [
  /^vite\.config\.ts\.timestamp-.*\.mjs$/,
  /^pack.*\.log$/,
  /\.db(-journal|-wal|-shm)?$/,
  /\.png$/,
];

const skipped = [];

function shouldSkipDir(name, rel) {
  if (EXCLUDE_DIR_NAMES.has(name)) return true;
  if (EXCLUDE_REL.has(rel)) return true;
  return false;
}

function shouldSkipFile(name) {
  if (EXCLUDE_FILE_NAMES.has(name)) return true;
  if (EXCLUDE_FILE_EXT.has(path.extname(name).toLowerCase())) return true;
  if (EXCLUDE_FILE_RE.some((re) => re.test(name))) return true;
  return false;
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function walk(srcDir, destDir, relBase) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name, rel)) {
        skipped.push(`[dir ] ${rel}`);
        continue;
      }
      walk(src, dest, rel);
    } else if (entry.isFile()) {
      if (shouldSkipFile(entry.name)) {
        skipped.push(`[file] ${rel}`);
        continue;
      }
      copyFile(src, dest);
    } else {
      skipped.push(`[link] ${rel}`);
    }
  }
}

/** 把 .tmp-* 里的开发资产按类归集到包内 tools/ */
function collectTools() {
  const plan = [
    ['.tmp-probe', 'tools/platform-probe'], // 平台接口探测脚本 + 官方文档快照
    ['.tmp-diag', 'tools/electron-diag'], // Electron/CDP 诊断脚本
    ['.tmp-verify', 'tools/logic-verify'], // 构建前逻辑自检脚本
  ];
  const EXTRA_EXCLUDE = new Set(['async-report.cjs', 'mapper.cjs']); // esbuild bundle 产物

  for (const [srcRel, destRel] of plan) {
    const srcDir = path.join(ROOT, srcRel);
    if (!fs.existsSync(srcDir)) continue;
    for (const name of fs.readdirSync(srcDir)) {
      const src = path.join(srcDir, name);
      if (!fs.statSync(src).isFile()) continue;
      if (EXTRA_EXCLUDE.has(name)) continue;
      if (shouldSkipFile(name)) continue;
      copyFile(src, path.join(DEST, destRel, name));
    }
  }
}

// 全量重建输出目录（先 rename 挪走，避开环境的批量删除护栏）
if (fs.existsSync(DEST)) {
  fs.renameSync(DEST, path.join(OUT_ROOT, `.old-${Date.now()}`));
}
walk(ROOT, DEST, '');
collectTools();

let bytes = 0;
let files = 0;
function size(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) size(p);
    else {
      files += 1;
      bytes += fs.statSync(p).size;
    }
  }
}
size(DEST);

fs.writeFileSync(path.join(OUT_ROOT, 'skipped.txt'), skipped.sort().join('\n') + '\n', 'utf8');

console.log(`目标目录: ${DEST}`);
console.log(`落盘 ${files} 个文件，${(bytes / 1024 / 1024).toFixed(2)} MB`);
console.log(`排除条目 ${skipped.length}（清单 .tmp-pack/skipped.txt）`);
console.log('\n顶层结构：');
for (const e of fs.readdirSync(DEST)) console.log('  ' + e);
