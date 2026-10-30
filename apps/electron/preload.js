/**
 * 预加载脚本：最小化暴露。
 * 目前页面全部通过同源 HTTP 与后端交互，不需要 Node 能力；
 * 仅暴露桌面版标识，方便前端区分运行环境。
 */
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('wkbdDesktop', {
  isDesktop: true,
  version: process.env.WKB_DESKTOP_VERSION || '0.1.0',
});
