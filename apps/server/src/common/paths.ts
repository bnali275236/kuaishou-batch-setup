import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@nestjs/common';

const logger = new Logger('Paths');

/**
 * 定位 server 包根目录。
 * 从 __dirname 向上查找 package.json，命中 name === '@wkbd/server' 即返回。
 * 比写死 '../../..' 更抗编译产物目录变化（也兼容后续 Electron 打包）。
 */
function findServerRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i += 1) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: string };
        if (pkg.name === '@wkbd/server') return dir;
      } catch {
        /* 读取失败继续向上找 */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const SERVER_ROOT = findServerRoot();

/**
 * 数据目录：SQLite、日志、导出文件都落在这里。
 * - 桌面版（Electron）会显式传入绝对路径的 DATA_DIR（通常是 userData）
 * - 开发态默认 <apps/server>/.data
 */
export function resolveDataDir(): string {
  const fromEnv = process.env.DATA_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(SERVER_ROOT, '.data');
}

export const paths = {
  serverRoot: SERVER_ROOT,
  /** 惰性求值，保证在 dotenv 加载之后才读取 DATA_DIR */
  get dataDir(): string {
    const dir = resolveDataDir();
    ensureDir(dir);
    return dir;
  },
  get logsDir(): string {
    const dir = path.join(this.dataDir, 'logs');
    ensureDir(dir);
    return dir;
  },
  get exportsDir(): string {
    const dir = path.join(this.dataDir, 'exports');
    ensureDir(dir);
    return dir;
  },
  get masterKeyFile(): string {
    return path.join(this.dataDir, 'master.key');
  },
};

export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    logger.log(`已创建数据目录：${dir}`);
  }
}

/** 把 DATA_DIR 固化进进程环境变量，供 Prisma 与子进程复用 */
export function pinDataDirToEnv(): string {
  const dir = resolveDataDir();
  ensureDir(dir);
  process.env.DATA_DIR = dir;
  return dir;
}
