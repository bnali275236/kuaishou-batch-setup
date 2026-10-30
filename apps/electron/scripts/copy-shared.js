/** 把 @wkbd/shared 拷进打包 staging 的 node_modules（workspace 内部包，npm 装不了） */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const src = path.join(ROOT, 'packages', 'shared');
const dest = path.join(ROOT, 'apps', 'electron', 'resources', 'server', 'node_modules', '@wkbd', 'shared');

/** 纯读写拷贝（不删除，规避受限环境的删除护栏） */
function copyOver(s, d) {
  const stat = fs.statSync(s);
  if (stat.isDirectory()) {
    fs.mkdirSync(d, { recursive: true });
    for (const e of fs.readdirSync(s, { withFileTypes: true })) {
      copyOver(path.join(s, e.name), path.join(d, e.name));
    }
  } else {
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.writeFileSync(d, fs.readFileSync(s));
  }
}

fs.mkdirSync(dest, { recursive: true });
const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
delete pkg.scripts;
fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify(pkg, null, 2));
copyOver(path.join(src, 'dist'), path.join(dest, 'dist'));
console.log('copied:', fs.existsSync(path.join(dest, 'dist', 'index.js')));
