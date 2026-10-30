import { Injectable, Logger } from '@nestjs/common';
import { AuthGrantSummary } from '@wkbd/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../../mapi/token.service';

export interface ResyncOutcome {
  grants: number;
  found: number;
  added: number;
  removed: number;
  details: Array<{
    grantId: number;
    found: number;
    added: number;
    removed: number;
    error?: string;
  }>;
}

/**
 * 授权编排。
 *
 * 主要处理「授权已完成，但账户列表需要与平台重新对齐」的场景 ——
 * 对「基于用户授权」尤其重要：罗盘里新增账户后，账户列表会变化，
 * 定期对齐即可自动纳管，不需要让客户重新授权一遍。
 */
@Injectable()
export class OauthService {
  private readonly logger = new Logger(OauthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
  ) {}

  /**
   * 与平台对齐账户列表。
   * @param grantId 指定凭证；不传则对齐全部凭证
   */
  async resync(grantId?: number): Promise<ResyncOutcome> {
    const targets: AuthGrantSummary[] = grantId
      ? (await this.tokens.listGrants()).filter((g) => g.id === grantId)
      : await this.tokens.listGrants();

    if (targets.length === 0) {
      throw new Error(
        grantId
          ? `授权凭证 #${grantId} 不存在。`
          : '还没有任何授权凭证，请先在「接入设置」完成一次授权。',
      );
    }

    const details: ResyncOutcome['details'] = [];
    let found = 0;
    let added = 0;
    let removed = 0;

    for (const g of targets) {
      try {
        const r = await this.tokens.syncGrantAccounts(g.id);
        found += r.found;
        added += r.added;
        removed += r.removed;
        details.push({ grantId: g.id, found: r.found, added: r.added, removed: r.removed });
      } catch (err) {
        // 单份凭证失败不影响其余凭证
        const message = (err as Error).message;
        this.logger.warn(`凭证 #${g.id} 账户对齐失败：${message}`);
        details.push({ grantId: g.id, found: 0, added: 0, removed: 0, error: message });
      }
    }

    this.logger.log(
      `账户对齐完成：${targets.length} 份凭证，发现 ${found}，新增 ${added}，停用 ${removed}`,
    );

    return { grants: targets.length, found, added, removed, details };
  }

  /** 凭证数量，用于界面判断是否已完成过授权 */
  async grantCount(): Promise<number> {
    return this.prisma.authGrant.count();
  }
}
