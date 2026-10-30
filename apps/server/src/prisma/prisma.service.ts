import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import * as path from 'path';
import { paths } from '../common/paths';

/**
 * 把 SQLite 落在 DATA_DIR 下的绝对路径。
 * 覆盖 datasource url，保证运行态数据库位置与 DATA_DIR 严格一致
 * （Prisma CLI 用 .env 里的相对路径，二者指向同一个文件）。
 */
function buildSqliteUrl(): string {
  const dbFile = path.join(paths.dataDir, 'app.db').replace(/\\/g, '/');
  return `file:${dbFile}`;
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({ datasources: { db: { url: buildSqliteUrl() } } });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log(`数据库已连接：${buildSqliteUrl()}`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
