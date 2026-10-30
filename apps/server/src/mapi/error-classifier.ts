import {
  ERROR_CODE_MAP,
  ERROR_MESSAGE_PATTERNS,
  MapiErrorKind,
  RETRYABLE_HTTP_STATUS,
} from '@wkbd/shared';

export interface ClassifiedError {
  kind: MapiErrorKind;
  desc: string;
}

/**
 * 把平台的错误码 / 网络异常归类，决定「重试 / 修正参数 / 走加白流程」。
 *
 * ⚠️ 官方「报错码枚举」表尚未全部录入，当前策略是：
 *   1. 先查 ERROR_CODE_MAP 精确匹配
 *   2. 未命中则用错误消息关键字兜底
 *   3. 仍未命中归为 UNKNOWN，只记录不重试（宁可人工看一眼，也不要盲目重试）
 * 附录错误码拿到后，只需往 ERROR_CODE_MAP 补条目即可，无需改逻辑。
 */
export function classifyMapiError(code: number, message?: string): ClassifiedError {
  if (code === 0) return { kind: MapiErrorKind.OK, desc: '成功' };

  const known = ERROR_CODE_MAP[code];
  if (known) return { kind: known.kind, desc: known.desc };

  const text = message ?? '';
  for (const { pattern, kind, desc } of ERROR_MESSAGE_PATTERNS) {
    if (pattern.test(text)) return { kind, desc };
  }

  return { kind: MapiErrorKind.UNKNOWN, desc: text || `未知错误码 ${code}` };
}

/** 网络层异常归类（超时、DNS、连接重置等） */
export function classifyNetworkError(err: unknown): ClassifiedError {
  const e = err as { name?: string; code?: string; message?: string; status?: number };
  const name = e?.name ?? '';
  const code = e?.code ?? '';

  if (name === 'AbortError' || name === 'TimeoutError' || code === 'ETIMEDOUT') {
    return { kind: MapiErrorKind.RETRYABLE, desc: '请求超时' };
  }
  if (['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_SOCKET'].includes(code)) {
    return { kind: MapiErrorKind.RETRYABLE, desc: `网络异常（${code}）` };
  }
  if (typeof e?.status === 'number' && RETRYABLE_HTTP_STATUS.has(e.status)) {
    return { kind: MapiErrorKind.RETRYABLE, desc: `平台返回 HTTP ${e.status}` };
  }
  return { kind: MapiErrorKind.UNKNOWN, desc: e?.message ?? '未知网络异常' };
}

/** 只有这些分类才值得重试 */
export function isRetryable(kind: MapiErrorKind): boolean {
  return kind === MapiErrorKind.RETRYABLE || kind === MapiErrorKind.TOKEN_INVALID;
}
