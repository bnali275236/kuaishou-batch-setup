/** 统一的 API 客户端。所有错误都被规整成 ApiError，前端只处理这一种形态。 */

export interface ApiError {
  statusCode: number;
  message: string;
  /** 快手开放平台原始错误码 */
  mapiCode?: number;
  /** 错误分类：RETRYABLE / PARAM / PERMISSION / TOKEN_INVALID / NOT_CONFIGURED / SHARE_AUTH … */
  kind?: string;
  /** 后端自定义错误码：SHARE_AUTH_REQUIRED / SHARE_DISABLED / LOCAL_ONLY … */
  code?: string;
  /** 批量提交时后端回传的逐行校验问题 */
  issues?: unknown[];
}

export function isApiError(e: unknown): e is ApiError {
  return typeof e === 'object' && e !== null && 'statusCode' in e && 'message' in e;
}

/** 是否属于「局域网共享」的鉴权问题（需要输口令 / 对方没开共享） */
export function isShareAuthError(e: unknown): boolean {
  return isApiError(e) && (e.kind === 'SHARE_AUTH' || e.code === 'SHARE_AUTH_REQUIRED');
}

/** 把错误分类翻译成「该怎么办」，而不是只念一遍原始报错 */
export function explainError(e: unknown): string {
  if (!isApiError(e)) return (e as Error)?.message ?? '未知错误';
  const base = e.message;
  switch (e.kind) {
    case 'PERMISSION':
      return `${base}\n→ 该账户缺少相应能力权限，需要联系快手运营同学加白后再试。`;
    case 'PARAM':
      return `${base}\n→ 这是参数问题，请检查填写内容后重试，无需重复提交。`;
    case 'TOKEN_INVALID':
      return `${base}\n→ 授权已失效，请到「账户管理」重新授权该账户。`;
    case 'NOT_CONFIGURED':
      return `${base}\n→ 请先在「接入设置」里填写开发者应用信息。`;
    case 'RETRYABLE':
      return `${base}\n→ 平台繁忙或触发限流，稍后会自动重试。`;
    case 'SHARE_AUTH':
      return `${base}\n→ 这是局域网共享的访问口令问题，请在页面上重新输入口令。`;
    default:
      return base;
  }
}

/* ------------------------------------------------------------------
 * 局域网共享的访问口令
 *
 * 存在 localStorage：其他设备访问时随每个请求带上 x-wkbd-key。
 * 本机请求后端会直接放行，所以桌面版本体根本用不到这个值。
 * ------------------------------------------------------------------ */

const SHARE_KEY_STORAGE = 'wkbd-share-key';

export function getShareKey(): string {
  try {
    return localStorage.getItem(SHARE_KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

export function setShareKey(key: string): void {
  try {
    localStorage.setItem(SHARE_KEY_STORAGE, key);
  } catch {
    /* 隐私模式下 localStorage 可能不可写，忽略即可（每次访问重新输口令） */
  }
}

export function clearShareKey(): void {
  try {
    localStorage.removeItem(SHARE_KEY_STORAGE);
  } catch {
    /* 同上 */
  }
}

/** 口令失效时的订阅：让口令门能在任意请求被拒时自动弹出来 */
type Listener = () => void;
const shareAuthListeners = new Set<Listener>();

export function onShareAuthRequired(fn: Listener): () => void {
  shareAuthListeners.add(fn);
  return () => shareAuthListeners.delete(fn);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const key = getShareKey();
  const res = await fetch(path, {
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { 'x-wkbd-key': key } : {}),
    },
    ...init,
  });

  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }

  if (!res.ok) {
    const body = json as
      | { message?: string; mapiCode?: number; kind?: string; code?: string; issues?: unknown[] }
      | undefined;
    // Nest 的 BadRequestException 传对象时，message 会嵌在 body 里
    const nested = body as { message?: unknown } | undefined;
    const rawMessage = nested?.message;
    const code = body?.code;
    const kind = body?.kind;

    // 口令失效：清掉本地口令并通知口令门重新弹出
    if (kind === 'SHARE_AUTH' || code === 'SHARE_AUTH_REQUIRED') {
      clearShareKey();
      for (const fn of shareAuthListeners) fn();
    }

    throw {
      statusCode: res.status,
      message:
        typeof rawMessage === 'string'
          ? rawMessage
          : (body?.message as string) ?? `请求失败（HTTP ${res.status}）`,
      mapiCode: body?.mapiCode,
      kind,
      code,
      issues: body?.issues,
    } satisfies ApiError;
  }

  return json as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body ?? {}) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

/* ------------------------------------------------------------------
 * 二进制直传（大文件：素材视频 / APK / 图片）
 *
 * 为什么不用 fetch：fetch 没有上传进度事件，500MB 的视频没有进度条
 * 等于不可用。这里用 XHR，把 onprogress 透给调用方画进度。
 * 请求体是裸字节，所以必须自己设 Content-Type，不能走 api.post 的 JSON。
 * ------------------------------------------------------------------ */

export interface UploadProgress {
  loaded: number;
  total: number;
  /** 0-100 */
  percent: number;
}

export function uploadBinary<T>(
  path: string,
  file: Blob,
  opts: {
    /** 原始文件名（后端据此判断扩展名/类型） */
    fileName?: string;
    contentType?: string;
    onProgress?: (p: UploadProgress) => void;
  } = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const qs = new URLSearchParams();
    if (opts.fileName) qs.set('fileName', opts.fileName);
    const url = qs.toString() ? `${path}${path.includes('?') ? '&' : '?'}${qs}` : path;

    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', opts.contentType ?? 'application/octet-stream');
    const key = getShareKey();
    if (key) xhr.setRequestHeader('x-wkbd-key', key);

    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable || !opts.onProgress) return;
      opts.onProgress({
        loaded: e.loaded,
        total: e.total,
        percent: Math.min(100, Math.round((e.loaded / e.total) * 100)),
      });
    };

    xhr.onload = () => {
      let json: unknown;
      try {
        json = xhr.responseText ? JSON.parse(xhr.responseText) : undefined;
      } catch {
        json = undefined;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(json as T);
        return;
      }
      const body = json as { message?: unknown; kind?: string; code?: string; mapiCode?: number } | undefined;
      if (body?.kind === 'SHARE_AUTH' || body?.code === 'SHARE_AUTH_REQUIRED') {
        clearShareKey();
        for (const fn of shareAuthListeners) fn();
      }
      reject({
        statusCode: xhr.status,
        message:
          typeof body?.message === 'string'
            ? body.message
            : `上传失败（HTTP ${xhr.status || '网络中断'}）`,
        mapiCode: body?.mapiCode,
        kind: body?.kind,
        code: body?.code,
      } satisfies ApiError);
    };

    xhr.onerror = () =>
      reject({ statusCode: 0, message: '网络中断，上传失败（检查服务是否还在运行）' } satisfies ApiError);

    xhr.send(file);
  });
}

