import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import {
  ALL_AUTH_ENTRIES,
  AUTH_ENTRY,
  AUTH_ENTRY_META,
  AUTH_TYPE,
  AUTH_TYPE_META,
  AuthEntry,
  AuthType,
} from '@wkbd/shared';
import { TokenService } from '../../mapi/token.service';
import { OauthService } from './oauth.service';

/**
 * 授权闭环。
 *
 * 标准流程：
 *   1. 前端 GET /api/oauth/authorize-url?authEntry=LUOPAN|ADVERTISER|AGENT&authType=USER|ACCOUNT
 *      拿到授权链接
 *   2. 在浏览器打开。注意：**不同入口的域名不同** ——
 *      LUOPAN 落在磁力罗盘，ADVERTISER / AGENT 落在磁力智投
 *   3. 快手回调 GET /api/oauth/callback?auth_code=xxx&state=xxx
 *   4. 本控制器用 auth_code 换 token，建立「授权凭证」并挂载账户
 *   5. 前端刷新凭证/账户列表
 *
 * 注意两个正交维度：
 *   authEntry 授权入口 —— 由我们拼链接时决定（域名 + oauth_type）
 *   authType  授权方式 —— 由用户在快手授权页上勾选，链接无法指定
 */
@Controller('api/oauth')
export class OauthController {
  constructor(
    private readonly tokens: TokenService,
    private readonly oauth: OauthService,
  ) {}

  /* ---------------- 授权入口 ---------------- */

  @Get('authorize-url')
  async authorizeUrl(
    @Query('authEntry') authEntry?: string,
    @Query('authType') authType?: string,
    @Query('appId') appId?: string,
  ) {
    const entry = authEntry?.toUpperCase();
    const normalizedEntry: AuthEntry = (ALL_AUTH_ENTRIES as string[]).includes(entry ?? '')
      ? (entry as AuthEntry)
      : AUTH_ENTRY.LUOPAN;
    const normalizedType: AuthType =
      authType?.toUpperCase() === AUTH_TYPE.ACCOUNT ? AUTH_TYPE.ACCOUNT : AUTH_TYPE.USER;

    return this.tokens.buildAuthorizeUrl({
      authEntry: normalizedEntry,
      authType: normalizedType,
      appIdOverride: appId,
    });
  }

  /**
   * 快手授权回调。这个地址会直接暴露在浏览器里，所以返回 HTML 而不是 JSON。
   * 回调地址必须与开放平台「应用管理」中登记的一致。
   */
  @Get('callback')
  async callback(
    @Query('auth_code') authCode: string | undefined,
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const ticket = (authCode ?? code ?? '').trim();

    if (!ticket) {
      res.type('html').send(this.renderPage(false, '回调地址缺少 auth_code 参数', state, null, null));
      return;
    }

    try {
      const result = await this.tokens.exchangeAuthCode(ticket, state);
      const entryMeta = AUTH_ENTRY_META[result.authEntry];
      const typeMeta = AUTH_TYPE_META[result.authType];
      const detail = result.pending
        ? '授权已成功，但本次没识别到广告账户。授权凭证已保存，请回到工作台点击「重新对齐账户列表」。' +
          '如果反复识别不到，说明这次授权链接的入口可能选错了（入口决定覆盖范围）。'
        : `授权成功：入口「${entryMeta.label}」· 方式「${typeMeta.label}」，` +
          `共接入 ${result.accountCount} 个广告账户。`;

      res
        .type('html')
        .send(
          this.renderPage(
            true,
            detail,
            state,
            result.grantId,
            result.authType,
            result.accountCount,
            result.authEntry,
          ),
        );
    } catch (err) {
      res
        .type('html')
        .send(this.renderPage(false, (err as Error).message, state, null, null));
    }
  }

  /** 手动兑换（当回调地址无法从浏览器访问时的兜底通道） */
  @Post('exchange')
  async exchange(@Body('authCode') authCode: string, @Body('state') state?: string) {
    if (!authCode?.trim()) throw new Error('缺少 auth_code');
    return this.tokens.exchangeAuthCode(authCode.trim(), state);
  }

  /* ---------------- 查询 ---------------- */

  /** 授权凭证列表 —— 一次授权一行 */
  @Get('grants')
  async grants() {
    return this.tokens.listGrants();
  }

  /** 账户列表（含所属凭证信息） */
  @Get('accounts')
  async accounts() {
    return this.tokens.listAccounts();
  }

  /** 重新与平台对齐账户列表（凭证不传则全部对齐） */
  @Post('resync')
  async resync(@Body('grantId') grantId?: number) {
    return this.oauth.resync(grantId);
  }

  /* ---------------- 凭证级操作 ---------------- */

  @Post('grants/:grantId/sync')
  async syncGrant(@Param('grantId', ParseIntPipe) grantId: number) {
    const r = await this.tokens.syncGrantAccounts(grantId);
    return { ok: true, ...r, grants: await this.tokens.listGrants() };
  }

  @Post('grants/:grantId/refresh')
  async refreshGrant(@Param('grantId', ParseIntPipe) grantId: number) {
    await this.tokens.refreshGrant(grantId, true);
    return { ok: true, grants: await this.tokens.listGrants() };
  }

  @Patch('grants/:grantId')
  async updateGrant(
    @Param('grantId', ParseIntPipe) grantId: number,
    @Body('label') label?: string,
    @Body('authType') authType?: string,
    @Body('authEntry') authEntry?: string,
  ) {
    const normalizedType =
      authType?.toUpperCase() === AUTH_TYPE.USER
        ? AUTH_TYPE.USER
        : authType?.toUpperCase() === AUTH_TYPE.ACCOUNT
          ? AUTH_TYPE.ACCOUNT
          : undefined;
    const entryUp = authEntry?.toUpperCase();
    const normalizedEntry = (ALL_AUTH_ENTRIES as string[]).includes(entryUp ?? '')
      ? (entryUp as AuthEntry)
      : undefined;

    await this.tokens.relabelGrant(grantId, {
      label,
      authType: normalizedType,
      authEntry: normalizedEntry,
    });
    return { ok: true, grants: await this.tokens.listGrants() };
  }

  @Patch('grants/:grantId/enabled')
  async setGrantEnabled(
    @Param('grantId', ParseIntPipe) grantId: number,
    @Body('enabled') enabled: boolean,
  ) {
    await this.tokens.setGrantEnabled(grantId, enabled);
    return { ok: true, grants: await this.tokens.listGrants() };
  }

  @Delete('grants/:grantId')
  async removeGrant(@Param('grantId', ParseIntPipe) grantId: number) {
    await this.tokens.removeGrant(grantId);
    return { ok: true };
  }

  /* ---------------- 账户级操作 ---------------- */

  @Post('accounts/:advertiserId/refresh')
  async refreshAccount(@Param('advertiserId') advertiserId: string) {
    await this.tokens.refreshAccount(advertiserId, true);
    return { ok: true, grants: await this.tokens.listGrants() };
  }

  /** 立即刷新单个账户的名称（平台侧改过名后点这个，不用等定时任务） */
  @Post('accounts/:advertiserId/refresh-name')
  async refreshName(@Param('advertiserId') advertiserId: string) {
    const r = await this.tokens.refreshAccountName(advertiserId);
    return { ok: true, ...r, accounts: await this.tokens.listAccounts() };
  }

  @Patch('accounts/:advertiserId/enabled')
  async setEnabled(
    @Param('advertiserId') advertiserId: string,
    @Body('enabled') enabled: boolean,
  ) {
    await this.tokens.setEnabled(advertiserId, enabled);
    return { ok: true };
  }

  /**
   * 批量设置「代投白名单」（只读标记）。
   * 白名单内账户只能看数据（报表/盯盘），上计划/调预算/调整计划等写操作一律拒绝。
   */
  @Patch('accounts/read-only')
  async setReadOnly(@Body('ids') ids: string[], @Body('readOnly') readOnly: boolean) {
    const result = await this.tokens.setAccountsReadOnly(Array.isArray(ids) ? ids : [], Boolean(readOnly));
    return { ok: true, ...result, accounts: await this.tokens.listAccounts() };
  }

  @Delete('accounts/:advertiserId')
  async remove(@Param('advertiserId') advertiserId: string) {
    await this.tokens.removeAccount(advertiserId);
    return { ok: true };
  }

  /* ---------------- 回调页渲染 ---------------- */

  private renderPage(
    ok: boolean,
    message: string,
    state?: string,
    grantId?: number | null,
    authType?: AuthType | null,
    accountCount?: number | null,
    authEntry?: AuthEntry | null,
  ): string {
    const color = ok ? '#0F6E56' : '#A32D2D';
    const bg = ok ? '#E1F5EE' : '#FCEBEB';
    const title = ok ? '授权成功' : '授权失败';
    const meta = authType ? AUTH_TYPE_META[authType] : null;
    const entry = authEntry ? AUTH_ENTRY_META[authEntry] : null;

    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
       background:#F5F5F3;color:#2C2C2A;padding:24px}
  .card{background:#fff;border-radius:12px;padding:32px 40px;max-width:560px;width:100%;
        border:1px solid rgba(0,0,0,.08);text-align:center}
  .badge{display:inline-block;padding:4px 12px;border-radius:999px;background:${bg};color:${color};
         font-size:13px;font-weight:500;margin-bottom:16px}
  h1{font-size:18px;font-weight:500;margin:0 0 12px}
  p{font-size:14px;line-height:1.7;color:#5F5E5A;margin:0 0 8px}
  .kv{margin:18px 0 4px;padding:14px 16px;background:#FAFAF9;border-radius:8px;text-align:left}
  .kv div{font-size:13px;line-height:1.9;color:#5F5E5A;display:flex;justify-content:space-between;gap:16px}
  .kv b{color:#2C2C2A;font-weight:500}
  code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;color:#888780;
       word-break:break-all}
</style></head>
<body><div class="card">
  <div class="badge">${title}</div>
  <h1>${ok ? '已接入工作台' : '未能完成授权'}</h1>
  <p>${this.escape(message)}</p>
  ${
    ok
      ? `<div class="kv">
           ${entry ? `<div><span>授权入口</span><b>${this.escape(entry.platform)}</b></div>` : ''}
           ${meta ? `<div><span>授权方式</span><b>${this.escape(meta.label)}</b></div>` : ''}
           ${grantId ? `<div><span>授权凭证</span><b>#${grantId}</b></div>` : ''}
           ${accountCount !== null && accountCount !== undefined ? `<div><span>覆盖账户</span><b>${accountCount} 个</b></div>` : ''}
           ${state ? `<div><span>state</span><code>${this.escape(state)}</code></div>` : ''}
         </div>`
      : ''
  }
  <p style="margin-top:20px">此页面可以关闭，请回到工作台查看账户列表。</p>
</div></body></html>`;
  }

  private escape(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
