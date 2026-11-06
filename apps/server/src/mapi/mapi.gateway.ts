import { Injectable, Logger } from '@nestjs/common';
import {
  findHomePushViolation,
  HOME_PUSH_GUARD,
  MapiErrorKind,
  RETRY_BACKOFF_MS,
  RETRYABLE_HTTP_STATUS,
} from '@wkbd/shared';
import { PrismaService } from '../prisma/prisma.service';
import { classifyMapiError, classifyNetworkError, isRetryable } from './error-classifier';
import { MapiError } from './mapi-error';
import { getJson, getText, postJson, postMultipart } from './mapi-http';
import { RateLimiterService, RateCategory } from './rate-limiter.service';
import { sleep } from './token-bucket';
import { TokenService } from './token.service';

export interface MapiCallOptions {
  /** 广告账户 ID。token 类接口可不传 */
  advertiserId?: string;
  path: string;
  body?: Record<string, unknown>;
  /** 请求方法：默认 POST；只读 GET 接口（如 v1/region/list）传 'GET'，body 作为 query 参数 */
  httpMethod?: 'GET' | 'POST';
  /**
   * 响应类型：默认 'json'（解析 {code,message,data} 外壳）；
   * 'text' = 原始文本（异步任务 CSV 下载），平台报错时响应仍是 JSON，仍走错误分类
   */
  responseType?: 'json' | 'text';
  /**
   * Multipart 上传（FORM 格式接口，如 v2/file/ad/video/upload）。
   * 设置后 body 的字符串字段作为表单域，二进制部分作为 file 字段发出。
   */
  multipart?: { fileName?: string; contentType?: string; buffer: Buffer };
  /** 调用类别，决定限流桶 */
  category?: RateCategory;
  /** 审计用：谁发起的 */
  actor?: string;
  /** 审计用：动作名，不传则用 path */
  action?: string;
  /** 是否自动重试，默认 true */
  retry?: boolean;
  timeoutMs?: number;
  /** 跳过 Access-Token 头（授权类接口用） */
  skipAuth?: boolean;
}

interface AttemptOutcome<T> {
  ok: boolean;
  data?: T;
  error?: MapiError;
  /** 是否已经因为 token 失效刷新过一次 */
  tokenRefreshed: boolean;
}

/**
 * 对快手开放平台的**唯一**出口。
 *
 * 所有业务代码都不允许直接调 fetch —— 必须经过这里，
 * 由它统一负责：限流、重试、token 续期、错误分类、审计留痕。
 * 这是架构原则第 2 条「一切外部调用走统一网关」的落点。
 */
@Injectable()
export class MapiGateway {
  private readonly logger = new Logger(MapiGateway.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly limiter: RateLimiterService,
    private readonly tokens: TokenService,
  ) {}

  /** 调用并返回 response.data */
  async call<T = Record<string, unknown>>(opts: MapiCallOptions): Promise<T> {
    // 🚫 红线守卫：禁止「上传/推送素材到快手主页」。在全站唯一出口处拦截，
    // 任何业务代码想绕都绕不过去。命中即抛错，请求不会发出，也不进限流/审计重试循环。
    const violation = findHomePushViolation(opts.path, opts.body);
    if (violation) {
      this.logger.error(`${HOME_PUSH_GUARD.reason}（${violation}）`);
      throw new MapiError(
        `${HOME_PUSH_GUARD.reason} 触发点：${violation}`,
        MapiErrorKind.PERMISSION,
        -1,
        opts.path,
      );
    }

    const maxAttempts = (opts.retry === false ? 1 : RETRY_BACKOFF_MS.length + 1);
    const category: RateCategory = opts.category ?? 'query';

    let tokenRefreshed = false;
    let lastError: MapiError | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await this.limiter.acquire(category, opts.advertiserId);

      try {
        const result = await this.attempt<T>(opts, tokenRefreshed);
        if (result.ok) {
          this.limiter.recordOutcome(false);
          await this.audit(opts, true, 0, undefined, MapiErrorKind.OK, attempt, result.durationMs);
          return result.data as T;
        }
        if (result.tokenRefreshed) tokenRefreshed = true;
        lastError = result.error;
      } catch (err) {
        // 已经是分类过的业务异常（如 token 失效）——直接沿用其分类，不要降级成「未知」。
        // 分类决定上层给用户的处置建议，丢掉它等于把可操作的问题变成一句废话。
        if (err instanceof MapiError) {
          lastError = err;
          if (!isRetryable(err.kind)) break;
        } else {
          // 网络层异常
          const cls = classifyNetworkError(err);
          lastError = new MapiError(
            `调用 ${opts.path} 失败：${cls.desc}`,
            cls.kind,
            -1,
            opts.path,
          );
          if (!isRetryable(cls.kind)) break;
        }
      }

      const kind = lastError?.kind ?? MapiErrorKind.UNKNOWN;
      const timedOut = kind === MapiErrorKind.RETRYABLE;
      this.limiter.recordOutcome(timedOut);

      const canRetry = isRetryable(kind) && attempt < maxAttempts;
      if (!canRetry) break;

      const backoff = RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)];
      this.logger.warn(
        `${opts.path} 第 ${attempt} 次失败（${kind}：${lastError?.message}），${backoff}ms 后重试`,
      );
      await sleep(backoff);
    }

    const finalError =
      lastError ??
      new MapiError(`调用 ${opts.path} 失败：未知原因`, MapiErrorKind.UNKNOWN, -1, opts.path);

    await this.audit(
      opts,
      false,
      finalError.code,
      finalError.message,
      finalError.kind,
      maxAttempts,
      undefined,
    );
    throw finalError;
  }

  private async attempt<T>(
    opts: MapiCallOptions,
    alreadyRefreshed: boolean,
  ): Promise<AttemptOutcome<T> & { durationMs?: number }> {
    const headers: Record<string, string> = {};
    if (!opts.skipAuth) {
      if (!opts.advertiserId) {
        throw new MapiError('缺少 advertiserId，无法鉴权', MapiErrorKind.PARAM, -1, opts.path);
      }
      headers['Access-Token'] = await this.tokens.getAccessToken(opts.advertiserId);
    }

    const res =
      opts.httpMethod === 'GET'
        ? opts.responseType === 'text'
          ? await getText(opts.path, (opts.body ?? {}) as Record<string, string | number | undefined>, {
              headers,
              timeoutMs: opts.timeoutMs,
            })
          : await getJson(opts.path, (opts.body ?? {}) as Record<string, string | number | undefined>, {
              headers,
              timeoutMs: opts.timeoutMs,
            })
        : opts.multipart
          ? await postMultipart(
              opts.path,
              opts.body as Record<string, string | number | undefined>,
              opts.multipart,
              { headers, timeoutMs: opts.timeoutMs },
            )
          : await postJson(opts.path, opts.body ?? {}, {
              headers,
              timeoutMs: opts.timeoutMs,
            });

    // —— 原始文本响应（CSV 下载）：拿到非 JSON 文本即成功；JSON 响应说明平台报错，走错误分类 ——
    if (opts.responseType === 'text') {
      if (res.json) {
        const code = Number(res.json.code ?? -1);
        const message = String(res.json.message ?? '');
        const cls = classifyMapiError(code, message);
        if (cls.kind === MapiErrorKind.TOKEN_INVALID && !alreadyRefreshed && opts.advertiserId) {
          this.logger.warn(`access_token 失效，刷新后重试：${opts.path}`);
          await this.tokens.refreshAccount(opts.advertiserId, true);
          return { ok: false, tokenRefreshed: true, durationMs: res.durationMs };
        }
        return {
          ok: false,
          tokenRefreshed: false,
          durationMs: res.durationMs,
          error: new MapiError(
            `平台返回错误[${code}]：${message || cls.desc}`,
            cls.kind,
            code,
            opts.path,
          ),
        };
      }
      return { ok: true, data: res.text as unknown as T, tokenRefreshed: false, durationMs: res.durationMs };
    }

    if (!res.json) {
      if (RETRYABLE_HTTP_STATUS.has(res.status)) {
        return {
          ok: false,
          tokenRefreshed: false,
          durationMs: res.durationMs,
          error: new MapiError(
            `平台返回 HTTP ${res.status}，响应非 JSON`,
            MapiErrorKind.RETRYABLE,
            res.status,
            opts.path,
          ),
        };
      }
      return {
        ok: false,
        tokenRefreshed: false,
        durationMs: res.durationMs,
        error: new MapiError(
          `响应无法解析为 JSON（HTTP ${res.status}）：${res.text.slice(0, 200)}`,
          MapiErrorKind.UNKNOWN,
          res.status,
          opts.path,
        ),
      };
    }

    const code = Number(res.json.code ?? -1);
    // 部分报表接口（实测 /v1/report/material_report）不返回 code/message 外壳，
    // 直接回 {total_count, details} 形状的 payload。用「无 code 字段且带明细/总数键」
    // 识别这种形状，避免把成功响应当成「未知错误 -1」。
    if (res.json.code === undefined && looksLikeBarePayload(res.json)) {
      return { ok: true, data: res.json as T, tokenRefreshed: false, durationMs: res.durationMs };
    }
    if (code === 0) {
      return { ok: true, data: res.json.data as T, tokenRefreshed: false, durationMs: res.durationMs };
    }

    const message = String(res.json.message ?? '');
    const cls = classifyMapiError(code, message);

    // 平台返回了没有 code 的响应（HTML / 网关页 / 非标 JSON），把原始片段带出来方便排查
    const rawHint =
      code === -1 && !message ? ` resp=${res.text.slice(0, 300)}` : '';

    // token 失效：刷新一次后立刻重试，不占用退避次数
    if (cls.kind === MapiErrorKind.TOKEN_INVALID && !alreadyRefreshed && opts.advertiserId) {
      this.logger.warn(`access_token 失效，刷新后重试：${opts.path}`);
      await this.tokens.refreshAccount(opts.advertiserId, true);
      return { ok: false, tokenRefreshed: true, durationMs: res.durationMs };
    }

    return {
      ok: false,
      tokenRefreshed: false,
      durationMs: res.durationMs,
      error: new MapiError(
        `平台返回错误[${code}]：${message || cls.desc}${rawHint}`,
        cls.kind,
        code,
        opts.path,
      ),
    };
  }

  /** 审计写库。失败不影响主流程（审计是旁路，不能拖垮业务调用） */  private async audit(
    opts: MapiCallOptions,
    ok: boolean,
    code: number,
    message: string | undefined,
    kind: MapiErrorKind,
    attempt: number,
    durationMs: number | undefined,
  ): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actor: opts.actor ?? 'system',
          action: opts.action ?? opts.path,
          advertiserId: opts.advertiserId ?? null,
          path: opts.path,
          requestJson: opts.body ? this.sanitize(opts.body) : null,
          ok,
          code,
          message: message?.slice(0, 1000) ?? null,
          kind,
          attempt,
          durationMs: durationMs ?? null,
        },
      });
    } catch (err) {
      this.logger.debug(`审计写入失败：${(err as Error).message}`);
    }
  }

  /** 请求体脱敏：token/secret 一律不入库 */
  private sanitize(body: Record<string, unknown>): string {
    const SENSITIVE = ['secret', 'access_token', 'refresh_token', 'auth_code', 'app_secret'];
    const clone: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      clone[k] = SENSITIVE.includes(k.toLowerCase()) ? '***' : v;
    }
    const text = JSON.stringify(clone);
    return text.length > 4000 ? `${text.slice(0, 4000)}…[已截断]` : text;
  }
}

/** 识别「无 code 外壳、直接回 payload」的响应形状（部分报表接口如此） */
function looksLikeBarePayload(json: Record<string, unknown>): boolean {
  return ['details', 'list', 'records', 'items', 'rows', 'data', 'total_count'].some((key) =>
    Object.prototype.hasOwnProperty.call(json, key),
  );
}
