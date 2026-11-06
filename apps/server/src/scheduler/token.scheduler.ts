import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ACCOUNT_STATUS, AUTH_TYPE, GRANT_STATUS } from '@wkbd/shared';
import { PrismaService } from '../prisma/prisma.service';
import { TokenService } from '../mapi/token.service';

/**
 * 后台调度。
 *
 * 设计取舍：token 刷新必须在**过期前**完成，所以用「定时扫临近过期凭证」的方式，
 * 而不是等到调用失败再补救 —— 后者会导致批量任务跑一半集体失败。
 */
@Injectable()
export class TokenScheduler implements OnModuleInit {
  private readonly logger = new Logger(TokenScheduler.name);

  constructor(
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  /** 启动后半分钟先补一轮缺失的账户名（新装/刚导入大量账户时不用等 5 分钟） */
  onModuleInit(): void {
    setTimeout(() => void this.backfillAccountNames(), 30_000).unref?.();
  }

  /**
   * 每 5 分钟补一批账户名称（approval/list 只回 ID，名称要逐个调 advertiser/info）：
   * 先补缺失的，再用剩余配额刷新超过 24h 没同步的 —— 平台侧改名的账户会自动跟上
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async backfillAccountNames(): Promise<void> {
    try {
      const filled = await this.tokens.backfillMissingNames(100);
      if (filled > 0) {
        this.logger.log(`账户名称回填：本轮补齐 ${filled} 个`);
      }
    } catch (err) {
      this.logger.error(`账户名称回填异常：${(err as Error).message}`);
    }
  }

  /** 每 10 分钟刷新一次临近过期的凭证（按凭证刷新，一次覆盖其下全部账户） */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async refreshTokens(): Promise<void> {
    try {
      const { refreshed, failed } = await this.tokens.refreshDueGrants();
      if (refreshed > 0 || failed > 0) {
        this.logger.log(`token 定时刷新：成功 ${refreshed} 份凭证，失败 ${failed} 份`);
      }
    } catch (err) {
      this.logger.error(`token 定时刷新异常：${(err as Error).message}`);
    }
  }

  /**
   * 每天 07:10 与平台对齐账户列表。
   *
   * 「基于用户授权」的凭证，其覆盖的账户会随磁力罗盘变化 ——
   * 罗盘里新增的账户应当自动纳管，不需要让客户重新授权。
   * 本任务负责这件事，顺便把平台侧已解绑的账户标记为停用。
   */
  @Cron('0 10 7 * * *')
  async syncGrantAccounts(): Promise<void> {
    try {
      const userGrants = await this.prisma.authGrant.findMany({
        where: {
          authType: AUTH_TYPE.USER,
          status: { in: [GRANT_STATUS.ACTIVE, GRANT_STATUS.REFRESHING] },
        },
        select: { id: true },
      });

      let added = 0;
      let removed = 0;
      for (const g of userGrants) {
        try {
          const r = await this.tokens.syncGrantAccounts(g.id);
          added += r.added;
          removed += r.removed;
        } catch (err) {
          this.logger.warn(`凭证 #${g.id} 账户对齐失败：${(err as Error).message}`);
        }
      }

      if (added > 0 || removed > 0) {
        this.logger.log(
          `罗盘授权账户对齐：新增 ${added} 个，平台侧已解绑并停用 ${removed} 个`,
        );
      }
    } catch (err) {
      this.logger.error(`账户对齐任务异常：${(err as Error).message}`);
    }
  }

  /** 每天 09:20 巡检 refresh_token 剩余有效期（T-1 数据 09:00 已就绪） */
  @Cron('0 20 9 * * *')
  async inspectRefreshTokens(): Promise<void> {
    const expiring = await this.tokens.listExpiringRefreshTokens();
    if (expiring.length === 0) return;

    const lines = expiring
      .map(
        (g) =>
          `凭证 #${g.id}（${g.label ?? '未命名'}，覆盖 ${g.accountCount} 个账户，剩余 ${g.refreshTokenDaysLeft} 天）`,
      )
      .join('；');
    this.logger.warn(`以下授权凭证 refresh_token 即将过期，到期后必须重新授权：${lines}`);
  }

  /** 每天 03:00 清理 90 天前的调用审计，避免 SQLite 无限膨胀 */
  @Cron('0 0 3 * * *')
  async pruneAuditLog(): Promise<void> {
    const cutoff = new Date(Date.now() - 90 * 86_400_000);
    const { count } = await this.prisma.auditLog.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    if (count > 0) this.logger.log(`已清理 ${count} 条 90 天前的调用审计`);
  }

  /** 状态自检：凭证与账户的健康度，供前端健康面板使用 */
  async accountHealth() {
    const [grantTotal, grantActive, grantNeedReauth, grantDisabled, accountTotal, accountActive] =
      await Promise.all([
        this.prisma.authGrant.count(),
        this.prisma.authGrant.count({ where: { status: GRANT_STATUS.ACTIVE } }),
        this.prisma.authGrant.count({ where: { status: GRANT_STATUS.NEED_REAUTH } }),
        this.prisma.authGrant.count({ where: { status: GRANT_STATUS.DISABLED } }),
        this.prisma.oauthAccount.count(),
        this.prisma.oauthAccount.count({ where: { status: ACCOUNT_STATUS.ACTIVE } }),
      ]);

    return {
      grantTotal,
      grantActive,
      grantNeedReauth,
      grantDisabled,
      accountTotal,
      accountActive,
      accountDisabled: accountTotal - accountActive,
    };
  }
}
