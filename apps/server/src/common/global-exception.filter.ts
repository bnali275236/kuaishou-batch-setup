import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { MapiErrorKind } from '@wkbd/shared';
import { Response } from 'express';
import { MapiError, MapiNotConfiguredError, TokenExpiredError, AccountNotAuthorizedError } from '../mapi/mapi-error';

/**
 * 统一错误出口。
 * 把 MAPI 的错误分类（PARAM / PERMISSION / RETRYABLE…）一路透传到前端，
 * 前端才能给出「这是参数问题」「这是要去找运营加白」这种可操作提示，
 * 而不是干巴巴一句 500。
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();

    const { status, body } = this.map(exception);

    if (status >= 500) {
      this.logger.error(
        `${body.message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    res.status(status).json(body);
  }

  private map(exception: unknown) {
    if (exception instanceof MapiError) {
      return {
        status: HttpStatus.BAD_GATEWAY,
        body: {
          statusCode: HttpStatus.BAD_GATEWAY,
          message: exception.message,
          mapiCode: exception.code,
          kind: exception.kind,
        },
      };
    }

    if (exception instanceof MapiNotConfiguredError) {
      return {
        status: HttpStatus.PRECONDITION_REQUIRED,
        body: {
          statusCode: HttpStatus.PRECONDITION_REQUIRED,
          message: exception.message,
          kind: 'NOT_CONFIGURED',
        },
      };
    }

    if (exception instanceof TokenExpiredError || exception instanceof AccountNotAuthorizedError) {
      return {
        status: HttpStatus.UNAUTHORIZED,
        body: {
          statusCode: HttpStatus.UNAUTHORIZED,
          message: exception.message,
          kind: MapiErrorKind.TOKEN_INVALID,
        },
      };
    }

    if (exception instanceof HttpException) {
      const response = exception.getResponse();
      const message =
        typeof response === 'string'
          ? response
          : ((response as { message?: string | string[] }).message ?? exception.message);
      // 附加字段要保留：批量提交被拒时的逐行校验 issues（前端靠它逐行定位错误），
      // 以及共享访问的 code/kind（前端靠它识别「需要输入访问口令」并弹出口令门）。
      const extra =
        typeof response === 'object' && response !== null
          ? (response as Record<string, unknown>)
          : {};
      return {
        status: exception.getStatus(),
        body: {
          statusCode: exception.getStatus(),
          message: Array.isArray(message) ? message.join('；') : message,
          ...(Array.isArray(extra.issues) ? { issues: extra.issues } : {}),
          ...(typeof extra.kind === 'string' ? { kind: extra.kind } : {}),
          ...(typeof extra.code === 'string' ? { code: extra.code } : {}),
        },
      };
    }

    const err = exception as Error;
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: err?.message ?? '服务器内部错误',
      },
    };
  }
}
