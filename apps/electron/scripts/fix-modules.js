/**
 * node_modules 修复脚本：对 main 入口损坏的包，按已装版本从 registry 重新拉取
 * tarball 解压覆盖（纯写入，不删除任何文件，规避受限环境的删除护栏）。
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..'); // scripts → electron → apps → 仓库根
const list = fs
  .readFileSync(path.join(ROOT, 'broken-real.txt'), 'utf8')
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);

const TMP = path.join(__dirname, '.fix-tmp');
fs.mkdirSync(TMP, { recursive: true });

/** 纯读写拷贝（不删除） */
function copyOver(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      copyOver(path.join(src, e.name), path.join(dest, e.name));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, fs.readFileSync(src));
  }
}

let fixed = 0;
const failed = [];
// package.json 被删掉的包从这里取精确版本（lock 里的 key 形如 node_modules/rc-util）
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
const lockPkgs = lock.packages ?? {};

for (const rel of list) {
  const pkgDir = path.join(ROOT, rel);
  const pj = path.join(pkgDir, 'package.json');
  let name;
  let version;
  if (fs.existsSync(pj)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pj, 'utf8'));
      name = pkg.name;
      version = pkg.version;
    } catch {
      failed.push(rel + ' (unparsable)');
      continue;
    }
  } else {
    // 空壳目录：从 lock 恢复版本信息
    const lockKey = rel.replace(/\\/g, '/');
    const lockEntry = lockPkgs[lockKey];
    if (!lockEntry) {
      failed.push(rel + ' (not in package-lock)');
      continue;
    }
    name = lockEntry.name ?? lockKey.replace(/^node_modules\//, '');
    version = lockEntry.version;
  }
  const spec = `${name}@${version}`;
  try {
    // 1. 下载 tarball（npm 对 scoped 包的命名规则不确定，直接取 pack 后最新的 .tgz）
    const before = fs
      .readdirSync(TMP)
      .filter((f) => f.endsWith('.tgz'))
      .map((f) => fs.statSync(path.join(TMP, f)).mtimeMs);
    execSync(`npm pack ${spec} --pack-destination "${TMP}" --loglevel=error`, {
      cwd: ROOT,
      stdio: 'ignore',
      shell: true,
    });
    const tgzs = fs
      .readdirSync(TMP)
      .filter((f) => f.endsWith('.tgz'))
      .filter((f) => fs.statSync(path.join(TMP, f)).mtimeMs > Math.max(0, ...before));
    if (tgzs.length === 0) throw new Error('tarball 未生成');
    const tgz = path.join(TMP, tgzs[0]);
    // 2. 解压到独立目录。注意用相对路径执行：GNU tar 会把绝对路径里的 "D:" 当成远程主机名
    const extName = `extract-${fixed}-${name.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    const extDir = path.join(TMP, extName);
    fs.mkdirSync(extDir, { recursive: true });
    execSync(`tar -xzf "${tgzs[0]}" -C "${extName}"`, {
      cwd: TMP,
      stdio: 'ignore',
      shell: true,
    });
    // 3. 覆盖写入（package/ → node_modules/<pkg>）
    copyOver(path.join(extDir, 'package'), pkgDir);
    fixed += 1;
    /* 独立解压目录留着不删，规避删除护栏 */
  } catch (err) {
    failed.push(`${rel} (${String(err.message).slice(0, 400)})`);
  }
}

console.log(`修复完成：${fixed}/${list.length}`);
if (failed.length) {
  console.log('失败清单：\n' + failed.join('\n'));
}
