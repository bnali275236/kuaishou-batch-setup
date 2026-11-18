/**
 * 在桌面生成「快手投放工作台」快捷方式（.url 互联网快捷方式）。
 *
 * 为什么用 .url 而不是 .lnk：
 *   创建 .lnk 需要 WScript.Shell COM 或 user32 调用，这台机器的安全策略禁止
 *   COM 实例化与 Add-Type，两条路都被拦。.url 是纯文本 INI 格式，系统原生支持、
 *   可自定义图标，双击即用默认浏览器打开工作台——对「快速启动」来说正好够用，
 *   而且不会闪黑窗口。
 *
 * 编码：Windows 的 .url 按系统 ANSI 代码页解析，中文 Windows 是 GBK，
 *       所以这里用 iconv-lite 编成 GBK + CRLF，避免中文路径变乱码。
 *
 * 用法：node tools/make-desktop-shortcut.cjs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const iconv = require('iconv-lite');

const root = path.resolve(__dirname, '..');
const icon = path.join(root, 'tools', 'icon.ico');
const url = `http://127.0.0.1:${process.env.PORT || 7801}/`;
const name = '快手投放工作台.url';

const desktop = path.join(os.homedir(), 'Desktop');
const target = path.join(desktop, name);

const content = [
  '[InternetShortcut]',
  `URL=${url}`,
  `IconFile=${icon}`,
  'IconIndex=0',
  '',
].join('\r\n');

fs.writeFileSync(target, iconv.encode(content, 'gbk'));
console.log(`已生成：${target}`);
console.log(`指向：${url}`);
if (!fs.existsSync(icon)) console.warn('警告：图标文件不存在，快捷方式会显示默认图标');
