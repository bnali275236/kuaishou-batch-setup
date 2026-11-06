import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import {
  ACCOUNT_STATUS,
  ALL_AUTH_ENTRIES,
  AUTH_ENTRY,
  AUTH_ENTRY_META,
  AUTH_TYPE,
  AccountSummary,
  AuthEntry,
  AuthGrantSummary,
  AuthType,
  GRANT_STATUS,
  MAPI_PATHS,
  REFRESH_TOKEN_WARN_SECONDS,
  TOKEN_REFRESH_AHEAD_SECONDS,
} from '@wkbd/shared';
import type { AuthGrant, OauthAccount } from '@prisma/client';
import { CryptoService } from '../common/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../modules/settings/settings.service';
import {
  AccountNotAuthorizedError,
  MapiError,
  MapiNotConfiguredError,
  TokenExpiredError,
} from './mapi-error';
import { getJson, postJson } from './mapi-http';
import { classifyMapiError, classifyNetworkError } from './error-classifier';
import { RateLimiterService } from './rate-limiter.service';

interface TokenBundle {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
}

/** 账户发现结果 */
export interface DiscoveredAccount {
  advertiserId: string;
  accountName: string | null;
}

/**
 * state 参数用来承载「用户声明的授权入口 + 授权方式」。
 *
 * 为什么需要它：授权入口由我们拼链接时决定（域名 + oauth_type），
 * 而授权方式（覆盖几个账户）由用户在快手页面上勾选 —— 两者都无法从
 * 回调参数里直接读到。把我们的意图随 state 发出去、回调时原样收回，
 * 入库时就能带上正确的标签，界面也能给出有针对性的提示。
 *
 * 格式：<随机串>.<AUTH_ENTRY>.<AUTH_TYPE>  （后两段可选，兼容旧格式）
 */
const STATE_SEP = '.';

function encodeState(authEntry: AuthEntry, authType: AuthType): string {
  return `${crypto.randomBytes(12).toString('hex')}${STATE_SEP}${authEntry}${STATE_SEP}${authType}`;
}

export interface DecodedState {
  authEntry?: AuthEntry;
  authType?: AuthType;
}

/**
 * 解析 state。兼容两种格式：
 *   <随机串>.<AUTH_TYPE>              旧格式
 *   <随机串>.<AUTH_ENTRY>.<AUTH_TYPE> 现行格式
 */
export function decodeState(state?: string | null): DecodedState {
  if (!state) return {};
  const parts = state.split(STATE_SEP).map((p) => p.trim().toUpperCase());
  const entry = parts.find((p) => (ALL_AUTH_ENTRIES as string[]).includes(p)) as
    | AuthEntry
    | undefined;
  const authType = parts.find(
    (p) => p === AUTH_TYPE.USER || p === AUTH_TYPE.ACCOUNT,
  ) as AuthType | undefined;
  return { authEntry: entry, authType };
}

/**
 * 授权凭证与 token 托管。
 *
 * 核心模型：**token 属于「授权凭证」，不属于「广告账户」**。
 * 一次授权（无论是罗盘全量还是勾选多个账户）产生一份凭证，
 * 该凭证下的所有账户共用同一个 access_token。
 * 刷新时按凭证刷新一次，全部账户同时生效。
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly settings: SettingsService,
    private readonly limiter: RateLimiterService,
  ) {}

  /* ------------------------------------------------------------------
   * 授权链接
   * ---------------------------------------------------------------- */

  /**
   * 生成授权链接。
   *
   * ⚠️ 关键点：**域名由授权入口决定**，不是随便选一个就行。
   *
   *   磁力罗盘 → https://developers.e.kuaishou.com/tools/authorize
   *   磁力智投 → https://ad.e.kuaishou.com/openapi/oauth  (+ oauth_type=advertiser)
   *   代理商   → https://ad.e.kuaishou.com/openapi/oauth  (+ oauth_type=agent)
   *
   * 之前这里一律用 ad.e.kuaishou.com/openapi/oauth，导致本该进罗盘做
   * 批量授权的链接落到了磁力智投登录页，用户只能按单账户授权 ——
   * 这是「为什么授权是单个账户」的真正原因。
   */
  async buildAuthorizeUrl(
    opts: {
      authEntry?: AuthEntry;
      authType?: AuthType;
      appIdOverride?: string;
    } = {},
  ): Promise<{ url: string; state: string; authEntry: AuthEntry; authType: AuthType }> {
    const cfg = await this.settings.resolve();
    const appId = opts.appIdOverride?.trim() || cfg.appId;
    if (!appId || !cfg.redirectUri) throw new MapiNotConfiguredError();

    const authEntry: AuthEntry =
      opts.authEntry && opts.authEntry in AUTH_ENTRY_META ? opts.authEntry : AUTH_ENTRY.LUOPAN;
    const meta = AUTH_ENTRY_META[authEntry];

    // 代理商入口没有「授权方式」可选 —— 一份 token 天然覆盖管辖内全部账户
    const authType: AuthType =
      authEntry === AUTH_ENTRY.AGENT
        ? AUTH_TYPE.USER
        : opts.authType === AUTH_TYPE.ACCOUNT
          ? AUTH_TYPE.ACCOUNT
          : AUTH_TYPE.USER;

    const state = encodeState(authEntry, authType);

    const params = new URLSearchParams({
      app_id: appId,
      scope: JSON.stringify(cfg.scopes),
      redirect_uri: cfg.redirectUri,
      state,
    });
    if (meta.oauthType) params.set('oauth_type', meta.oauthType);

    return { url: `${meta.url}?${params.toString()}`, state, authEntry, authType };
  }

  /* ------------------------------------------------------------------
   * auth_code → 凭证
   * ---------------------------------------------------------------- */

  async exchangeAuthCode(
    authCode: string,
    stateRaw?: string,
  ): Promise<{
    grantId: number;
    authEntry: AuthEntry;
    authType: AuthType;
    accountCount: number;
    pending: boolean;
    accounts: AccountSummary[];
    idsPreview: string[];
    raw: unknown;
  }> {
    const cfg = await this.settings.resolve();
    if (cfg.source === 'none') throw new MapiNotConfiguredError();

    await this.limiter.acquire('query');

    const res = await postJson(
      MAPI_PATHS.ACCESS_TOKEN,
      { app_id: Number(cfg.appId) || cfg.appId, secret: cfg.secret, auth_code: authCode },
      { timeoutMs: 20_000 },
    );

    await this.auditAuth(
      MAPI_PATHS.ACCESS_TOKEN,
      'oauth.access_token',
      { app_id: cfg.appId, auth_code: authCode },
      Number(res.json?.code ?? -1) === 0,
      Number(res.json?.code ?? res.status),
      String(res.json?.message ?? `HTTP ${res.status}`),
      res.durationMs,
    );

    if (!res.json) {
      throw new MapiError(
        `获取 token 失败：响应不是合法 JSON（HTTP ${res.status}）`,
        classifyNetworkError({ status: res.status }).kind,
        res.status,
        MAPI_PATHS.ACCESS_TOKEN,
      );
    }

    const code = Number(res.json.code ?? -1);
    if (code !== 0) {
      const cls = classifyMapiError(code, String(res.json.message ?? ''));
      throw new MapiError(
        `获取 token 失败[${code}]：${res.json.message ?? cls.desc}`,
        cls.kind,
        code,
        MAPI_PATHS.ACCESS_TOKEN,
      );
    }

    const data = (res.json.data ?? {}) as Record<string, unknown>;
    const bundle = this.parseTokenBundle(data);
    const declared = decodeState(stateRaw);
    const authEntry: AuthEntry = declared.authEntry ?? AUTH_ENTRY.LUOPAN;

    // 账户发现：优先用兑换响应里带的 advertiser_ids（部分场景会返回），
    // 拿不到再调 approval/list 反查。
    let discovered = this.extractAdvertiserIds(data);
    if (discovered.length === 0) {
      discovered = await this.fetchApprovedAdvertiserIds(bundle.accessToken);
    }

    // 推断授权方式：声明优先；代理商入口天然是「基于用户授权」；
    // 都没线索时，覆盖多个账户基本可判定为「基于用户授权」。
    const authType: AuthType =
      authEntry === AUTH_ENTRY.AGENT
        ? AUTH_TYPE.USER
        : (declared.authType ??
          (discovered.length > 1 ? AUTH_TYPE.USER : AUTH_TYPE.ACCOUNT));

    const grant = await this.prisma.authGrant.create({
      data: {
        label: this.suggestLabel(authEntry, authType, discovered.length),
        authEntry,
        authType,
        declaredAuthType: declared.authType ?? null,
        scopesJson: JSON.stringify(cfg.scopes),
        accessTokenEnc: this.crypto.encrypt(bundle.accessToken),
        refreshTokenEnc: this.crypto.encrypt(bundle.refreshToken),
        accessTokenExpiresAt: bundle.accessTokenExpiresAt,
        refreshTokenExpiresAt: bundle.refreshTokenExpiresAt,
        status: GRANT_STATUS.ACTIVE,
        lastSyncedAt: new Date(),
        accountCount: discovered.length,
      },
    });

    await this.attachAccounts(grant.id, discovered);
    // 新授权的账户只有 ID 没有名称，立即在后台补一轮（不阻塞响应）
    if (discovered.length > 0) void this.backfillMissingNames(50);

    if (discovered.length === 0) {
      this.logger.warn(
        `授权成功但未识别到广告账户（凭证 #${grant.id} 已入库，token 未丢失）。` +
          `请稍后在账户页「重新对齐账户列表」。`,
      );
    } else {
      this.logger.log(
        `授权成功：凭证 #${grant.id}（入口=${authEntry}，方式=${authType}）` +
          `覆盖 ${discovered.length} 个账户`,
      );
    }

    return {
      grantId: grant.id,
      authEntry,
      authType,
      accountCount: discovered.length,
      pending: discovered.length === 0,
      accounts: await this.listAccounts(),
      idsPreview: discovered.slice(0, 5).map((d) => d.advertiserId),
      raw: { code, message: res.json.message, data: this.redact(data) },
    };
  }

  /* ------------------------------------------------------------------
   * 账户发现
   * ---------------------------------------------------------------- */

  /**
   * 拉取某个 token 下已授权的广告账户列表。
   *
   * 依据官方文档「拉取token下授权广告账户接口」：
   *   POST /rest/openapi/oauth2/authorize/approval/list
   *   请求参数 app_id / secret / access_token / page_no / page_size **全部放在 JSON body**，
   *   其中 access_token 是请求体字段，不是请求头！page_size 最大 200。
   *   返回 data.details 为广告主 ID 列表，data.isEnd 标识是否已翻到最后一页。
   *
   * 实测结论（2026-09 探测）：
   *   · 全部参数放 body → 通过参数校验，进入鉴权（返回「access token错误」）
   *   · access_token 放请求头 → 直接被拒（「查询分页参数必传」），根本没走到鉴权
   *   · 该接口的错误响应外壳是 {result, message, data}，与主网关的 {code, message, data} 不同，
   *     因此这里两种外壳都读。
   */
  async fetchApprovedAdvertiserIds(accessToken: string): Promise<DiscoveredAccount[]> {
    const cfg = await this.settings.resolve();
    if (cfg.source === 'none') return [];

    const PAGE_SIZE = 200;
    const MAX_PAGES = 200; // 防御性上限：200 × 200 = 4 万账户，足够且不会死循环
    const out: DiscoveredAccount[] = [];
    const seen = new Set<string>();

    for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo += 1) {
      await this.limiter.acquire('query');

      const reqBody: Record<string, unknown> = {
        app_id: Number(cfg.appId) || cfg.appId,
        secret: cfg.secret,
        access_token: accessToken,
        page_no: pageNo,
        page_size: PAGE_SIZE,
      };

      let res: Awaited<ReturnType<typeof postJson>>;
      try {
        res = await postJson(MAPI_PATHS.APPROVAL_LIST, reqBody, { timeoutMs: 20_000 });
      } catch (err) {
        this.logger.warn(`approval/list 第 ${pageNo} 页调用异常：${(err as Error).message}`);
        break;
      }

      const body = (res.json ?? undefined) as Record<string, unknown> | undefined;
      const status = this.readStatus(body);
      const data = (body?.data ?? undefined) as Record<string, unknown> | undefined;
      const ok = this.isSuccessStatus(status);

      await this.auditAuth(
        MAPI_PATHS.APPROVAL_LIST,
        'oauth.approval_list',
        { app_id: cfg.appId, page_no: pageNo, page_size: PAGE_SIZE },
        ok,
        status,
        ok ? String(body?.message ?? 'OK') : this.describeFailure(body, res.status),
        res.durationMs,
      );

      if (!ok && !data) {
        this.logger.warn(
          `approval/list 第 ${pageNo} 页失败（status=${status}）：${this.describeFailure(body, res.status)}`,
        );
        break;
      }

      const details = Array.isArray(data?.details) ? (data?.details as unknown[]) : [];
      for (const raw of details) {
        const id = raw === null || raw === undefined ? '' : String(raw).trim();
        if (!id || id === '0' || seen.has(id)) continue;
        seen.add(id);
        out.push({ advertiserId: id, accountName: null });
      }

      const isEnd = data?.isEnd === true;
      if (isEnd || details.length === 0 || details.length < PAGE_SIZE) break;
    }

    this.logger.log(`approval/list 共发现 ${out.length} 个已授权广告账户`);
    return out;
  }

  /**
   * 读取响应状态码。该接口存在两种外壳：主网关的 {code} 与边缘返回的 {result}，
   * 两种都认，读不到则返回 -1。
   */
  private readStatus(body?: Record<string, unknown>): number {
    if (!body) return -1;
    const raw = body.code ?? body.result;
    const n = Number(raw);
    return Number.isFinite(n) ? n : -1;
  }

  private isSuccessStatus(status: number): boolean {
    return status === 0 || status === 1 || status === 200;
  }

  /** 失败时把原始响应尽量完整地带进日志/审计，避免只看到一句笼统的报错 */
  private describeFailure(body: Record<string, unknown> | undefined, httpStatus: number): string {
    const message = String(body?.message ?? '').trim();
    if (message) return message;
    const raw = body ? JSON.stringify(body).slice(0, 300) : '';
    return raw || `HTTP ${httpStatus}`;
  }

  /** 从任意形态的返回体里尽力捞出 advertiser_id 列表（兑换响应的兜底解析） */
  private extractAdvertiserIds(payload?: Record<string, unknown>): DiscoveredAccount[] {
    if (!payload) return [];

    const out: DiscoveredAccount[] = [];
    const push = (rawId: unknown, name?: unknown) => {
      if (rawId === undefined || rawId === null) return;
      const id = String(rawId).trim();
      if (!id || id === '0' || id === 'undefined') return;
      if (out.some((x) => x.advertiserId === id)) return;
      out.push({ advertiserId: id, accountName: name ? String(name) : null });
    };

    const arrays = [
      payload.advertiser_ids,
      payload.advertiserIds,
      payload.list,
      payload.records,
      payload.details,
      payload.accounts,
      payload.data,
    ];
    for (const arr of arrays) {
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        if (typeof item === 'object' && item !== null) {
          const o = item as Record<string, unknown>;
          push(
            o.advertiser_id ?? o.advertiserId ?? o.id,
            o.advertiser_name ?? o.name ?? o.account_name,
          );
        } else {
          push(item);
        }
      }
    }

    push(payload.advertiser_id ?? payload.advertiserId);
    return out;
  }

  /* ------------------------------------------------------------------
   * 账户列表对齐
   * ---------------------------------------------------------------- */

  /** 把发现的账户挂到凭证下；已存在的账户若换了凭证，归属随之迁移 */
  private async attachAccounts(grantId: number, accounts: DiscoveredAccount[]): Promise<void> {
    for (const acc of accounts) {
      await this.prisma.oauthAccount.upsert({
        where: { advertiserId: acc.advertiserId },
        create: {
          advertiserId: acc.advertiserId,
          accountName: acc.accountName,
          grantId,
          status: ACCOUNT_STATUS.ACTIVE,
        },
        update: {
          accountName: acc.accountName ?? undefined,
          grantId,
          status: ACCOUNT_STATUS.ACTIVE,
        },
      });
    }
  }

  /**
   * 与平台对齐某份凭证下的账户列表。
   *
   * 这一步对「基于用户授权」尤其重要：罗盘里新增的账户会自动出现在
   * approval/list 结果中，所以定期对齐就能自动纳管新账户，不必重新授权。
   * 平台侧已解绑的账户不删除，只标记停用，保留历史数据。
   */
  async syncGrantAccounts(grantId: number): Promise<{
    found: number;
    added: number;
    removed: number;
    total: number;
  }> {
    const grant = await this.prisma.authGrant.findUnique({ where: { id: grantId } });
    if (!grant) throw new Error(`授权凭证 #${grantId} 不存在`);

    const accessToken = await this.getGrantAccessToken(grantId);
    const discovered = await this.fetchApprovedAdvertiserIds(accessToken);
    const foundIds = new Set(discovered.map((d) => d.advertiserId));

    const before = await this.prisma.oauthAccount.findMany({
      where: { grantId },
      select: { advertiserId: true },
    });
    const beforeIds = new Set(before.map((b) => b.advertiserId));

    await this.attachAccounts(grantId, discovered);
    // 新发现的账户可能还没有名称，立即在后台补一轮（不阻塞对齐响应）
    if (discovered.length > 0) void this.backfillMissingNames(50);

    // 平台侧已不在授权范围内的账户 → 标记停用（不删，避免丢历史）
    const stale = before.filter((b) => !foundIds.has(b.advertiserId)).map((b) => b.advertiserId);
    if (stale.length > 0) {
      await this.prisma.oauthAccount.updateMany({
        where: { advertiserId: { in: stale } },
        data: { status: ACCOUNT_STATUS.DISABLED },
      });
    }

    const total = await this.prisma.oauthAccount.count({ where: { grantId } });
    await this.prisma.authGrant.update({
      where: { id: grantId },
      data: { lastSyncedAt: new Date(), accountCount: total },
    });

    return {
      found: discovered.length,
      added: discovered.filter((d) => !beforeIds.has(d.advertiserId)).length,
      removed: stale.length,
      total,
    };
  }

  /* ------------------------------------------------------------------
   * token 取用与刷新
   * ---------------------------------------------------------------- */

  /** 按广告账户取 token（业务代码的常用入口） */
  async getAccessToken(advertiserId: string): Promise<string> {
    const account = await this.prisma.oauthAccount.findUnique({ where: { advertiserId } });
    if (!account) throw new AccountNotAuthorizedError(advertiserId);
    if (account.status === ACCOUNT_STATUS.DISABLED) throw new AccountNotAuthorizedError(advertiserId);
    return this.getGrantAccessToken(account.grantId);
  }

  /** 按凭证取 token；临近过期自动续期 */
  async getGrantAccessToken(grantId: number): Promise<string> {
    const grant = await this.prisma.authGrant.findUnique({ where: { id: grantId } });
    if (!grant) throw new AccountNotAuthorizedError(`grant:${grantId}`);
    if (grant.status === GRANT_STATUS.NEED_REAUTH) throw new TokenExpiredError(`grant:${grantId}`);
    if (grant.status === GRANT_STATUS.DISABLED) throw new AccountNotAuthorizedError(`grant:${grantId}`);

    const aheadMs = TOKEN_REFRESH_AHEAD_SECONDS * 1000;
    if (grant.accessTokenExpiresAt.getTime() - Date.now() <= aheadMs) {
      await this.refreshGrant(grantId, false);
      const fresh = await this.prisma.authGrant.findUnique({ where: { id: grantId } });
      if (!fresh) throw new AccountNotAuthorizedError(`grant:${grantId}`);
      return this.crypto.decrypt(fresh.accessTokenEnc);
    }

    return this.crypto.decrypt(grant.accessTokenEnc);
  }

  /**
   * 刷新凭证。一份凭证覆盖的所有账户同时生效 ——
   * 这就是把 token 提到凭证层的好处：不论覆盖 1 个还是 500 个账户，
   * 一次刷新即可，不存在「同批账户被刷新多次」或「部分账户用旧 token」。
   */
  async refreshGrant(grantId: number, force: boolean): Promise<void> {
    const grant = await this.prisma.authGrant.findUnique({ where: { id: grantId } });
    if (!grant) throw new AccountNotAuthorizedError(`grant:${grantId}`);
    if (grant.status === GRANT_STATUS.DISABLED) return;

    const aheadMs = TOKEN_REFRESH_AHEAD_SECONDS * 1000;
    const stillFresh = grant.accessTokenExpiresAt.getTime() - Date.now() > aheadMs;
    if (stillFresh && !force) return;

    if (grant.refreshTokenExpiresAt.getTime() <= Date.now()) {
      await this.markGrantNeedReauth(grantId, 'refresh_token 已过期');
      throw new TokenExpiredError(`grant:${grantId}`);
    }

    const cfg = await this.settings.resolve();
    if (cfg.source === 'none') throw new MapiNotConfiguredError();

    await this.prisma.authGrant.update({
      where: { id: grantId },
      data: { status: GRANT_STATUS.REFRESHING },
    });

    try {
      await this.limiter.acquire('query');
      const res = await postJson(
        MAPI_PATHS.REFRESH_TOKEN,
        {
          app_id: Number(cfg.appId) || cfg.appId,
          secret: cfg.secret,
          refresh_token: this.crypto.decrypt(grant.refreshTokenEnc),
        },
        { timeoutMs: 20_000 },
      );

      const code = Number(res.json?.code ?? -1);
      await this.auditAuth(
        MAPI_PATHS.REFRESH_TOKEN,
        'oauth.refresh_token',
        { app_id: cfg.appId, grant_id: grantId },
        code === 0,
        Number.isFinite(code) ? code : res.status,
        String(res.json?.message ?? `HTTP ${res.status}`),
        res.durationMs,
      );

      if (code !== 0 || !res.json) {
        const cls = classifyMapiError(code, String(res.json?.message ?? ''));
        throw new MapiError(
          `刷新 token 失败[${code}]：${res.json?.message ?? cls.desc}`,
          cls.kind,
          code,
          MAPI_PATHS.REFRESH_TOKEN,
        );
      }

      const bundle = this.parseTokenBundle(res.json.data as Record<string, unknown>);
      await this.prisma.authGrant.update({
        where: { id: grantId },
        data: {
          accessTokenEnc: this.crypto.encrypt(bundle.accessToken),
          refreshTokenEnc: this.crypto.encrypt(bundle.refreshToken),
          accessTokenExpiresAt: bundle.accessTokenExpiresAt,
          refreshTokenExpiresAt: bundle.refreshTokenExpiresAt,
          status: GRANT_STATUS.ACTIVE,
          lastError: null,
        },
      });

      const accountCount = await this.prisma.oauthAccount.count({ where: { grantId } });
      this.logger.log(`凭证 #${grantId} 已刷新 token（覆盖 ${accountCount} 个账户）`);
    } catch (err) {
      // 刷新失败 → 必须重新授权，不能反复重试把 refresh_token 打废
      await this.markGrantNeedReauth(grantId, (err as Error).message);
      throw err;
    }
  }

  /** 兼容网关调用：按账户入口刷新其所属凭证 */
  async refreshAccount(advertiserId: string, force: boolean): Promise<void> {
    const account = await this.prisma.oauthAccount.findUnique({ where: { advertiserId } });
    if (!account) throw new AccountNotAuthorizedError(advertiserId);
    await this.refreshGrant(account.grantId, force);
  }

  private async markGrantNeedReauth(grantId: number, reason: string): Promise<void> {
    await this.prisma.authGrant.update({
      where: { id: grantId },
      data: { status: GRANT_STATUS.NEED_REAUTH, lastError: reason },
    });
    const count = await this.prisma.oauthAccount.count({ where: { grantId } });
    this.logger.error(`凭证 #${grantId}（覆盖 ${count} 个账户）需重新授权：${reason}`);
  }

  /** 定时任务调用：把所有临近过期的凭证刷一遍 */
  async refreshDueGrants(): Promise<{ refreshed: number; failed: number }> {
    const dueBefore = new Date(Date.now() + TOKEN_REFRESH_AHEAD_SECONDS * 1000);
    const grants = await this.prisma.authGrant.findMany({
      where: {
        status: { in: [GRANT_STATUS.ACTIVE, GRANT_STATUS.REFRESHING] },
        accessTokenExpiresAt: { lte: dueBefore },
      },
      select: { id: true },
    });

    let refreshed = 0;
    let failed = 0;
    for (const g of grants) {
      try {
        await this.refreshGrant(g.id, true);
        refreshed += 1;
      } catch {
        failed += 1;
      }
    }
    return { refreshed, failed };
  }

  /* ------------------------------------------------------------------
   * 查询与维护
   * ---------------------------------------------------------------- */

  async listAccounts(): Promise<AccountSummary[]> {
    const rows = await this.prisma.oauthAccount.findMany({
      orderBy: [{ grantId: 'asc' }, { createdAt: 'asc' }],
      include: { grant: true },
    });
    // 账户名回填不再阻塞列表返回（200 个账户逐个调 advertiser/info 会拖慢接口好几秒）。
    // 改为后台异步补齐 + 定时任务兜底（见 TokenScheduler.backfillAccountNames），
    // 授权/对齐后也会立即触发一轮。
    void this.backfillMissingNames(50);
    return rows.map((r) => this.toAccountSummary(r));
  }

  /** 名称刷新门槛：上次同步超过该时长的已有名称账户才会被自动重新拉取 */
  private static readonly NAME_REFRESH_INTERVAL_MS = 24 * 3600 * 1000;

  /**
   * 回填/刷新账户名称并落库。
   *
   * 两级队列（每轮有界，避免占满限流桶）：
   *   1. 缺失名称的账户（accountName 为空）—— 优先补齐
   *   2. 已有名称但超过 24h 没同步的 —— 按最旧优先刷新，让「平台侧已改名」
   *      的账户自动跟上（此前只补缺失，改名的账户永远不更新，124276386 事故）
   *
   * 拉取异常（网络/限流）不写 nameSyncedAt，下轮自然重试；
   * 平台响应成功但没有名称字段时也记 nameSyncedAt，避免反复占配额。
   */
  async backfillMissingNames(max = 100): Promise<number> {
    // 第一优先：补缺失
    const missing = await this.prisma.oauthAccount.findMany({
      where: { accountName: null },
      select: { advertiserId: true, grantId: true, accountName: true },
      orderBy: { createdAt: 'asc' },
      take: max,
    });

    // 第二优先：刷新最久没同步的已有名称（用剩余配额，不挤占补缺失的额度）
    let stale: Array<{ advertiserId: string; grantId: number; accountName: string | null }> = [];
    const quota = max - missing.length;
    if (quota > 0) {
      stale = await this.prisma.oauthAccount.findMany({
        where: {
          accountName: { not: null },
          OR: [
            { nameSyncedAt: null },
            { nameSyncedAt: { lt: new Date(Date.now() - TokenService.NAME_REFRESH_INTERVAL_MS) } },
          ],
        },
        select: { advertiserId: true, grantId: true, accountName: true },
        orderBy: [{ nameSyncedAt: 'asc' }, { updatedAt: 'asc' }],
        take: quota,
      });
    }

    const rows = [...missing, ...stale];
    if (rows.length === 0) return 0;

    let filled = 0;
    for (const row of rows) {
      const isNew = row.accountName === null;
      try {
        const name = await this.fetchAccountName(row.advertiserId, row.grantId);
        await this.prisma.oauthAccount.update({
          where: { advertiserId: row.advertiserId },
          data: {
            ...(name ? { accountName: name } : {}),
            nameSyncedAt: new Date(),
          },
        });
        if (name) {
          filled += 1;
          const renamed = !isNew && row.accountName !== name;
          this.logger.log(
            renamed
              ? `账户 ${row.advertiserId} 名称已更新：${row.accountName} → ${name}`
              : `账户 ${row.advertiserId} 名称回填：${name}`,
          );
        } else {
          // 拉到了响应但没有可用的名称字段 —— 记警告，避免继续「静默跳过」没法排查
          this.logger.warn(
            `账户 ${row.advertiserId} 未取到名称（advertiser/info 响应里没有 name 字段）`,
          );
        }
      } catch (err) {
        this.logger.warn(`账户 ${row.advertiserId} 名称拉取失败：${(err as Error).message}`);
      }
    }
    return filled;
  }

  /** 立即刷新单个账户的名称（绕过 24h 门槛，供前端「刷新名称」按钮）。返回新旧名称。 */
  async refreshAccountName(
    advertiserId: string,
  ): Promise<{ name: string | null; previous: string | null }> {
    const row = await this.prisma.oauthAccount.findUnique({
      where: { advertiserId },
      select: { advertiserId: true, grantId: true, accountName: true },
    });
    if (!row) throw new Error(`账户 ${advertiserId} 不存在`);

    const name = await this.fetchAccountName(advertiserId, row.grantId);
    if (!name) throw new Error('平台未返回该账户的名称（advertiser/info 无 name 字段）');

    await this.prisma.oauthAccount.update({
      where: { advertiserId },
      data: { accountName: name, nameSyncedAt: new Date() },
    });
    if (name !== row.accountName) {
      this.logger.log(`账户 ${advertiserId} 名称已更新：${row.accountName} → ${name}`);
    }
    return { name, previous: row.accountName };
  }

  /**
   * 调 v1/advertiser/info 取单个账户的当前名称。
   * 主用 POST（body 带 advertiser_id，鉴权走 Access-Token 头）；兜底再试 GET query 形态。
   * 返回空字符串 = 响应成功但平台没给名称字段（与「拉取失败抛异常」区分开）。
   */
  private async fetchAccountName(advertiserId: string, grantId: number): Promise<string> {
    const accessToken = await this.getGrantAccessToken(grantId);
    await this.limiter.acquire('query');

    let first: Record<string, unknown> | undefined;
    try {
      const res = await postJson(
        MAPI_PATHS.ADVERTISER_INFO,
        { advertiser_id: Number(advertiserId) || advertiserId },
        { headers: { 'Access-Token': accessToken }, timeoutMs: 15_000 },
      );
      first = this.pickAdvertiserInfo(res.json);
    } catch {
      first = undefined;
    }
    if (!first) {
      const res = await getJson(
        MAPI_PATHS.ADVERTISER_INFO,
        { advertiser_id: Number(advertiserId) || advertiserId },
        { headers: { 'Access-Token': accessToken }, timeoutMs: 15_000 },
      );
      first = this.pickAdvertiserInfo(res.json);
    }
    return first
      ? String(first.user_name ?? first.name ?? first.advertiser_name ?? '').trim()
      : '';
  }

  /** 从 advertiser/info 两种响应形态里捞出第一个条目（data 数组 / data.list） */
  private pickAdvertiserInfo(body?: Record<string, unknown>): Record<string, unknown> | undefined {
    const data = body?.data;
    if (Array.isArray(data)) return data[0] as Record<string, unknown> | undefined;
    if (data && typeof data === 'object') {
      const obj = data as Record<string, unknown>;
      if (Array.isArray(obj.list)) return obj.list[0] as Record<string, unknown> | undefined;
      if (Array.isArray(obj.details)) return obj.details[0] as Record<string, unknown> | undefined;
      return obj;
    }
    return undefined;
  }

  async listAccountsByGrant(grantId: number): Promise<AccountSummary[]> {
    const rows = await this.prisma.oauthAccount.findMany({
      where: { grantId },
      orderBy: { createdAt: 'asc' },
      include: { grant: true },
    });
    return rows.map((r) => this.toAccountSummary(r));
  }

  async listGrants(): Promise<AuthGrantSummary[]> {
    const grants = await this.prisma.authGrant.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { accounts: true } } },
    });

    const activeGroups = await this.prisma.oauthAccount.groupBy({
      by: ['grantId'],
      where: { status: ACCOUNT_STATUS.ACTIVE },
      _count: { _all: true },
    });
    const activeMap = new Map(activeGroups.map((g) => [g.grantId, g._count._all]));

    return grants.map((g) => ({
      id: g.id,
      label: g.label,
      authEntry: (g.authEntry as AuthEntry) ?? AUTH_ENTRY.LUOPAN,
      authType: g.authType as AuthType,
      subjectId: g.subjectId,
      subjectName: g.subjectName,
      scopes: this.parseJsonArray(g.scopesJson),
      status: g.status,
      lastError: g.lastError,
      accountCount: g._count.accounts,
      activeAccountCount: activeMap.get(g.id) ?? 0,
      accessTokenExpiresAt: g.accessTokenExpiresAt.toISOString(),
      refreshTokenExpiresAt: g.refreshTokenExpiresAt.toISOString(),
      refreshTokenDaysLeft: Math.floor(
        (g.refreshTokenExpiresAt.getTime() - Date.now()) / 86_400_000,
      ),
      lastSyncedAt: g.lastSyncedAt?.toISOString() ?? null,
      createdAt: g.createdAt.toISOString(),
    }));
  }

  /** 账户是否可用（账户本身启用 且 所属凭证未失效） */
  async assertUsable(advertiserId: string): Promise<void> {
    const row = await this.prisma.oauthAccount.findUnique({
      where: { advertiserId },
      include: { grant: true },
    });
    if (!row) throw new AccountNotAuthorizedError(advertiserId);
    if (row.status === ACCOUNT_STATUS.DISABLED) throw new TokenExpiredError(advertiserId);
    if (
      row.grant.status === GRANT_STATUS.NEED_REAUTH ||
      row.grant.status === GRANT_STATUS.DISABLED
    ) {
      throw new TokenExpiredError(advertiserId);
    }
  }

  /** 需要重新授权的凭证数 */
  async needsReauthCount(): Promise<number> {
    return this.prisma.authGrant.count({ where: { status: GRANT_STATUS.NEED_REAUTH } });
  }

  /* ------------------------------------------------------------------
   * 账户级维护
   * ---------------------------------------------------------------- */

  /** 删除账户（仅清本地，不影响快手侧授权） */
  async removeAccount(advertiserId: string): Promise<void> {
    await this.prisma.oauthAccount.deleteMany({ where: { advertiserId } });
  }

  async setEnabled(advertiserId: string, enabled: boolean): Promise<void> {
    await this.prisma.oauthAccount.update({
      where: { advertiserId },
      data: { status: enabled ? ACCOUNT_STATUS.ACTIVE : ACCOUNT_STATUS.DISABLED },
    });
  }

  /**
   * 批量设置「代投白名单」（只读标记）。
   * 白名单内账户只能看数据（报表/盯盘），上计划、调预算、调整计划等写操作一律拒绝。
   */
  async setAccountsReadOnly(
    advertiserIds: string[],
    readOnly: boolean,
  ): Promise<{ count: number }> {
    const ids = [...new Set(advertiserIds.map((id) => String(id).trim()).filter(Boolean))];
    if (ids.length === 0) return { count: 0 };
    const { count } = await this.prisma.oauthAccount.updateMany({
      where: { advertiserId: { in: ids } },
      data: { readOnly },
    });
    this.logger.log(
      `代投白名单已更新：${readOnly ? '加入' : '移出'} ${count} 个账户（${ids.slice(0, 5).join(',')}${ids.length > 5 ? '…' : ''}）`,
    );
    return { count };
  }

  /** 是否存在指定账户被代投白名单锁定（供写操作前置校验，返回带名称的明细） */
  async filterReadOnlyAccounts(
    advertiserIds: string[],
  ): Promise<Array<{ advertiserId: string; accountName: string | null }>> {
    const ids = [...new Set(advertiserIds.filter(Boolean))];
    if (ids.length === 0) return [];
    const rows = await this.prisma.oauthAccount.findMany({
      where: { advertiserId: { in: ids }, readOnly: true },
      select: { advertiserId: true, accountName: true },
    });
    return rows;
  }

  /* ------------------------------------------------------------------
   * 凭证级维护
   * ---------------------------------------------------------------- */

  /** 删除凭证 —— 其下账户一并移除（外键级联）。不影响快手侧授权关系 */
  async removeGrant(grantId: number): Promise<void> {
    const count = await this.prisma.oauthAccount.count({ where: { grantId } });
    await this.prisma.authGrant.delete({ where: { id: grantId } });
    this.logger.warn(`已删除授权凭证 #${grantId}，连带移除 ${count} 个账户记录`);
  }

  async setGrantEnabled(grantId: number, enabled: boolean): Promise<void> {
    await this.prisma.authGrant.update({
      where: { id: grantId },
      data: {
        status: enabled ? GRANT_STATUS.ACTIVE : GRANT_STATUS.DISABLED,
        lastError: enabled ? null : undefined,
      },
    });
  }

  async relabelGrant(
    grantId: number,
    patch: { label?: string; authType?: AuthType; authEntry?: AuthEntry },
  ): Promise<void> {
    await this.prisma.authGrant.update({
      where: { id: grantId },
      data: {
        label: patch.label?.trim() || undefined,
        authType: patch.authType,
        authEntry: patch.authEntry,
      },
    });
  }

  /** refresh_token 即将过期（7 天内）的凭证，用于前端告警 */
  async listExpiringRefreshTokens(): Promise<AuthGrantSummary[]> {
    const grants = await this.listGrants();
    return grants.filter(
      (g) => g.status !== GRANT_STATUS.DISABLED && g.refreshTokenDaysLeft * 86_400 <= REFRESH_TOKEN_WARN_SECONDS,
    );
  }

  /* ------------------------------------------------------------------
   * 内部工具
   * ---------------------------------------------------------------- */

  private toAccountSummary(r: OauthAccount & { grant: AuthGrant }): AccountSummary {
    return {
      advertiserId: r.advertiserId,
      accountName: r.accountName,
      status: r.status,
      /** 代投白名单：true = 仅可看数据，禁止上计划/调整 */
      readOnly: r.readOnly,
      grantId: r.grantId,
      authEntry: (r.grant.authEntry as AuthEntry) ?? AUTH_ENTRY.LUOPAN,
      authType: r.grant.authType as AuthType,
      grantLabel: r.grant.label,
      grantStatus: r.grant.status,
      accessTokenExpiresAt: r.grant.accessTokenExpiresAt.toISOString(),
      refreshTokenExpiresAt: r.grant.refreshTokenExpiresAt.toISOString(),
      refreshTokenDaysLeft: Math.floor(
        (r.grant.refreshTokenExpiresAt.getTime() - Date.now()) / 86_400_000,
      ),
      lastSyncAt: r.grant.lastSyncedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    };
  }

  private suggestLabel(authEntry: AuthEntry, authType: AuthType, count: number): string {
    const now = new Date();
    const stamp = `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;

    if (authEntry === AUTH_ENTRY.AGENT) {
      return `代理商授权 · ${stamp}`;
    }
    if (authEntry === AUTH_ENTRY.LUOPAN) {
      return authType === AUTH_TYPE.USER
        ? `罗盘授权 · 全部账户 · ${stamp}`
        : `罗盘授权 · ${count} 个账户 · ${stamp}`;
    }
    return `磁力智投授权 · ${count} 个 · ${stamp}`;
  }

  private parseJsonArray(raw: string): string[] {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }

  private parseTokenBundle(data: Record<string, unknown>): TokenBundle {
    const accessToken = String(data.access_token ?? '');
    const refreshToken = String(data.refresh_token ?? '');
    if (!accessToken || !refreshToken) {
      throw new MapiError(
        '平台返回的 token 数据不完整（缺少 access_token 或 refresh_token）',
        classifyMapiError(-1, 'token 缺失').kind,
        -1,
        MAPI_PATHS.ACCESS_TOKEN,
      );
    }

    const accessTtl = Number(data.access_token_expires_in ?? 86_400);
    const refreshTtl = Number(data.refresh_token_expires_in ?? 2_592_000);
    const now = Date.now();

    return {
      accessToken,
      refreshToken,
      accessTokenExpiresAt: new Date(now + accessTtl * 1000),
      refreshTokenExpiresAt: new Date(now + refreshTtl * 1000),
    };
  }

  /** 日志/响应里抹掉敏感字段 */
  private redact(data: Record<string, unknown>): Record<string, unknown> {
    const clone: Record<string, unknown> = { ...data };
    for (const key of ['access_token', 'refresh_token', 'secret']) {
      if (clone[key]) clone[key] = this.crypto.mask(String(clone[key]));
    }
    return clone;
  }

  /**
   * 授权类调用不走 MapiGateway（它们没有 advertiserId，且需要 skipAuth），
   * 所以单独留痕 —— 授权出问题时，这是唯一能回溯「到底发了什么、平台回了什么」的地方。
   */
  private async auditAuth(
    path: string,
    action: string,
    body: Record<string, unknown>,
    ok: boolean,
    code: number,
    message: string,
    durationMs?: number,
  ): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actor: 'oauth',
          action,
          path,
          requestJson: this.sanitizeAuth(body),
          ok,
          code: Number.isFinite(code) ? code : null,
          message: message.slice(0, 1000),
          kind: ok ? 'OK' : classifyMapiError(code, message).kind,
          attempt: 1,
          durationMs: durationMs ?? null,
        },
      });
    } catch (err) {
      this.logger.debug(`授权审计写入失败：${(err as Error).message}`);
    }
  }

  /** 授权请求体脱敏：secret / token / auth_code 一律不入库 */
  private sanitizeAuth(body: Record<string, unknown>): string {
    const SENSITIVE = ['secret', 'access_token', 'refresh_token', 'auth_code', 'app_secret'];
    const clone: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      clone[k] = SENSITIVE.includes(k.toLowerCase()) ? '***' : v;
    }
    const text = JSON.stringify(clone);
    return text.length > 4000 ? `${text.slice(0, 4000)}…[已截断]` : text;
  }
}
