import { MAPI_BASE_URL } from '@wkbd/shared';

export interface RawHttpResult {
  status: number;
  /** 已解析的 JSON；解析失败为 undefined */
  json?: Record<string, unknown>;
  /** 原始响应文本（截断后），排查用 */
  text: string;
  durationMs: number;
}

export interface PostJsonOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TEXT_KEEP = 4000;

/**
 * MAPI 最底层 HTTP 封装。
 * 只负责「发出去、拿回来、判断是不是超时」，不做鉴权、不做限流、不做重试 ——
 * 那些交给 TokenService 和 MapiGateway，保持职责单一。
 */
export async function postJson(
  path: string,
  body: unknown,
  opts: PostJsonOptions = {},
): Promise<RawHttpResult> {
  const url = path.startsWith('http') ? path : `${MAPI_BASE_URL}${path}`;
  const startedAt = Date.now();

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers ?? {}),
    },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  const text = await res.text();
  const durationMs = Date.now() - startedAt;

  let json: Record<string, unknown> | undefined;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = undefined;
  }

  return {
    status: res.status,
    json,
    text: text.length > MAX_TEXT_KEEP ? `${text.slice(0, MAX_TEXT_KEEP)}…[已截断]` : text,
    durationMs,
  };
}

/**
 * GET 版本：部分只读接口（如 v1/region/list）明确只支持 GET，
 * POST 会报 401000「Request method 'POST' not supported」。
 * 参数走 query string，鉴权头沿用 Access-Token。
 */
export async function getJson(
  path: string,
  query: Record<string, string | number | undefined>,
  opts: PostJsonOptions = {},
): Promise<RawHttpResult> {
  const base = path.startsWith('http') ? path : `${MAPI_BASE_URL}${path}`;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== '') qs.set(k, String(v));
  }
  const url = qs.toString() ? `${base}?${qs.toString()}` : base;
  const startedAt = Date.now();

  const res = await fetch(url, {
    method: 'GET',
    headers: { ...(opts.headers ?? {}) },
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  const text = await res.text();
  const durationMs = Date.now() - startedAt;

  let json: Record<string, unknown> | undefined;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = undefined;
  }

  return {
    status: res.status,
    json,
    text: text.length > MAX_TEXT_KEEP ? `${text.slice(0, MAX_TEXT_KEEP)}…[已截断]` : text,
    durationMs,
  };
}

export interface GetTextResult {
  status: number;
  /** 全量响应文本（不截断）—— 异步任务 CSV 下载用 */
  text: string;
  /** 若响应其实是 JSON（通常是错误响应），解析结果放这里供上层识别 */
  json?: Record<string, unknown>;
  durationMs: number;
}

/**
 * GET 下载文本版：响应不是 JSON（CSV / 文本文件），需要拿全量原文。
 * 平台出错时响应仍是 JSON（如 401000），用 json 字段识别。
 */
export async function getText(
  path: string,
  query: Record<string, string | number | undefined>,
  opts: PostJsonOptions = {},
): Promise<GetTextResult> {
  const base = path.startsWith('http') ? path : `${MAPI_BASE_URL}${path}`;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== '') qs.set(k, String(v));
  }
  const url = qs.toString() ? `${base}?${qs.toString()}` : base;
  const startedAt = Date.now();

  const res = await fetch(url, {
    method: 'GET',
    headers: { ...(opts.headers ?? {}) },
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  const text = await res.text();
  let json: Record<string, unknown> | undefined;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = undefined;
  }

  return { status: res.status, text, json, durationMs: Date.now() - startedAt };
}

/**
 * Multipart 版本：视频/图片上传接口（FORM 格式，如 v2/file/ad/video/upload）。
 * fields 走普通表单字段，file 为二进制部分（字段名固定 file）。
 * 注意：Node 18+ 原生 FormData/Blob，无需额外依赖。
 */
export async function postMultipart(
  path: string,
  fields: Record<string, string | number | undefined>,
  file: { buffer: Buffer; fileName?: string; contentType?: string },
  opts: PostJsonOptions = {},
): Promise<RawHttpResult> {
  const url = path.startsWith('http') ? path : `${MAPI_BASE_URL}${path}`;
  const startedAt = Date.now();

  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== '') form.append(k, String(v));
  }
  form.append(
    'file',
    new Blob([new Uint8Array(file.buffer)], { type: file.contentType ?? 'application/octet-stream' }),
    file.fileName ?? 'file',
  );

  const res = await fetch(url, {
    method: 'POST',
    headers: { ...(opts.headers ?? {}) },
    body: form,
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  const text = await res.text();
  const durationMs = Date.now() - startedAt;

  let json: Record<string, unknown> | undefined;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = undefined;
  }

  return {
    status: res.status,
    json,
    text: text.length > MAX_TEXT_KEEP ? `${text.slice(0, MAX_TEXT_KEEP)}…[已截断]` : text,
    durationMs,
  };
}
