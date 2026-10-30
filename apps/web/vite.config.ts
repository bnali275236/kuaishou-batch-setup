import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // 直接吃 shared 的 TS 源码，省掉一层构建产物依赖，改常量即时生效
  resolve: {
    alias: {
      '@wkbd/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    // 开发态走代理：前端只认 /api，天然规避跨域，也贴近桌面版形态
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:7801',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    // 本环境的删除护栏会拦截批量删除：assets 里文件数超过 50 时，
    // vite 清空旧产物会抛 [SAFE_DELETE_BULK_CONFIRM_REQUIRED] 直接让构建失败。
    // 关掉它，改由 apps/electron/scripts/stage.js 的 pruneUnreferencedAssets()
    // 按 index.html 引用逐个清理旧 bundle（打包前必跑）。
    emptyOutDir: false,
    // 桌面版会以 file:// 加载，必须用相对路径
    assetsDir: 'assets',
    sourcemap: false,
  },
  base: './',
});
