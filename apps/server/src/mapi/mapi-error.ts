/** MAPI 调用异常基类 —— 携带错误分类，便于上层决定重试或提示 */

import { MapiErrorKind } from '@wkbd/shared';

export class MapiError extends Error {
  constructor(
    message: string,
    public readonly kind: MapiErrorKind,
    public readonly code: number,
    public readonly path: string,
  ) {
    super(message);
    this.name = 'MapiError';
  }
}

export class MapiNotConfiguredError extends Error {
  constructor(message = '尚未配置开发者应用（app_id / secret / 回调地址）') {
    super(message);
    this.name = 'MapiNotConfiguredError';
  }
}

/**
 * 账户未授权 / token 失效。
 *
 * 刻意继承 MapiError 并带 TOKEN_INVALID 分类：批量任务里这类错误的处置动作
 * 与「平台繁忙」完全不同（前者要去重新授权，后者等等就好）。
 * 如果它在网关里被当成未知错误，前端就只能给用户一句无用的报错。
 *
 * ⚠️ **这是本地鉴权状态检查抛出的，请求根本没发往平台**（`path` 固定为 'token'）。
 * 排查时务必分清：它出现在审计日志里，**不能**作为「平台已接受该接口路径」的证据。
 * 同理，它也不能说明「账户在平台上真的没权限」——只说明本地没有可用的凭证。
 * 曾因此误判过：把这条报错当成平台的业务响应，进而以为创编路径已被验证。
 */
export class AccountNotAuthorizedError extends MapiError {
  constructor(advertiserId: string) {
    super(
      `广告账户 ${advertiserId} 未授权或已失效，请重新授权（本地鉴权检查未通过，未调用平台接口）`,
      MapiErrorKind.TOKEN_INVALID,
      -1,
      'token',
    );
    this.name = 'AccountNotAuthorizedError';
  }
}

/** 同 AccountNotAuthorizedError：本地抛出的凭证失效，不是平台返回的业务错误 */
export class TokenExpiredError extends MapiError {
  constructor(advertiserId: string) {
    super(
      `广告账户 ${advertiserId} 的 refresh_token 已失效，必须重新走授权流程（本地鉴权检查未通过）`,
      MapiErrorKind.TOKEN_INVALID,
      -1,
      'token',
    );
    this.name = 'TokenExpiredError';
  }
}
