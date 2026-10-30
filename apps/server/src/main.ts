import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/global-exception.filter';
import { pinDataDirToEnv } from './common/paths';
import { ShareService } from './modules/system/share.service';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  // 固化数据目录：SQLite、日志、导出全部落在 DATA_DIR 下。
  // 桌面版（Electron）会通过环境变量传入 userData 路径，此处逻辑无需改动。
  const dataDir = pinDataDirToEnv();

  const app = await NestFactory.create(AppModule, { bufferLogs: false });

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: false,
      forbidUnknownValues: false,
    }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());

  const webOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:5173';
  app.enableCors({
    origin: [
      webOrigin,
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      // Electron 渲染进程（file:// 协议）origin 为 null
      'null',
    ],
    credentials: true,
  });

  // 生产/桌面模式：WEB_DIST 指向前端构建产物时同源托管（Electron 与局域网部署都走这条路）
  // 必须在 listen 之前注册：Nest 的 404 兜底在路由注册时固化，后挂的中间件拿不到请求。
  const webDist = process.env.WEB_DIST?.trim();
  if (webDist && fs.existsSync(path.join(webDist, 'index.html'))) {
    const webDistAbs = path.resolve(webDist);
    // 缓存策略 —— 桌面版升级防白屏的关键，别改回去：
    //   index.html 绝不能进缓存。它引用的是带内容 hash 的 bundle 文件名，
    //   一旦 index.html 被缓存（旧版是 maxAge:1h），升级后新版 bundle 换了 hash，
    //   客户端仍拿旧 index.html 去请求已删除的旧文件 → 模块脚本加载失败 → 白屏。
    //   （0.5.1 实测：清缓存前加载 index-DcSC_Xws.js 白屏，清后加载 index-0kPc30yp.js 正常）
    //   assets/ 下的文件名自带 hash，内容永不变化，可以放心长缓存。
    app.use(
      express.static(webDistAbs, {
        index: 'index.html',
        setHeaders: (res: express.Response, filePath: string) => {
          if (path.basename(filePath) === 'index.html') {
            res.setHeader('Cache-Control', 'no-store, must-revalidate');
          } else {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      }),
    );
    // SPA 兜底：非 /api 的 GET 一律回 index.html（hash 路由其实用不到，但防直接访问裸路径）
    app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (req.method === 'GET' && !req.path.startsWith('/api/')) {
        res.setHeader('Cache-Control', 'no-store, must-revalidate');
        res.sendFile(path.join(webDistAbs, 'index.html'));
        return;
      }
      next();
    });
    Logger.log(`已托管前端静态资源：${webDistAbs}`, 'Bootstrap');
  }

  const port = Number(process.env.PORT ?? 7801);

  // 监听地址由「局域网共享」配置决定（配置在库里，启动时读取）。
  // 为什么默认仍然只监听本机：这个进程持有 access_token，是全部权限的源头，
  // 「不主动暴露」应该是默认状态，开启共享必须是一次显式选择。
  // 变更需要重启才生效 —— 前端改完会调 /api/system/restart，由 Electron 自动拉起来。
  const share = app.get(ShareService);
  let bindLan = false;
  try {
    bindLan = await share.enabled();
  } catch (err) {
    Logger.warn(`读取共享配置失败，按「仅本机」启动：${(err as Error).message}`, 'Bootstrap');
  }
  process.env.WKBD_BIND_LAN = bindLan ? '1' : '0';
  const bindHost = bindLan ? '0.0.0.0' : '127.0.0.1';
  await app.listen(port, bindHost);

  if (bindLan) {
    logger.warn(`⚠️ 已开启局域网共享，监听 ${bindHost}:${port} —— 其他设备需输入访问口令`);
    for (const url of share.lanUrls()) logger.log(`其他设备可访问：${url}`);
  } else {
    logger.log(`服务已启动：http://127.0.0.1:${port}（仅本机可访问）`);
  }
  logger.log(`数据目录：${dataDir}`);
  logger.log(`前端来源已放行：${webOrigin}`);
  logger.warn('数据库迁移请先执行：npm run db:migrate');
}

void bootstrap();
