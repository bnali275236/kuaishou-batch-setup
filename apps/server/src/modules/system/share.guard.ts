import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { isLoopback, ShareService } from './share.service';

export const SHARE_PUBLIC = 'wkbd:share-public';
export const SHARE_LOCAL_ONLY = 'wkbd:local-only';

/**
 * 标记接口无需口令即可访问。
 * 只给两处用：「口令门」自己需要的探针（判断要不要弹门）与登录校验。
 * 业务接口一律不允许挂这个装饰器。
 */
export const SharePublic = () => SetMetadata(SHARE_PUBLIC, true);

/**
 * 标记接口只允许本机（回环）访问。
 *
 * 用途：任何「会改变这台主机行为 / 影响所有使用者」的操作 ——
 * 修改开发者应用凭据（app_id/secret）、共享开关与口令、重启后端。
 * 共享用户可以正常用工作台、可以自行发起授权，但改不了这些全局配置。
 */
export const LocalOnly = () => SetMetadata(SHARE_LOCAL_ONLY, true);

/**
 * 全局访问守卫 —— 局域网共享的安全阀。
 *
 * 放行规则（从宽到严）：
 *   1. 本机回环请求 → 无条件放行（桌面版本体 / 本机浏览器不受影响）
 *   2. 显式标记 @SharePublic() 的接口 → 放行（仅口令门自身）
 *   3. 未开启共享 → 403，并给出明确提示
 *   4. 已开启共享 → 校验 x-wkbd-key 请求头里的口令，不通过则 401
 *
 * 注意：静态资源（前端页面）不经过守卫，所以其他设备能打开页面、
 * 看到「输入访问口令」的界面；但拿不到任何 /api 数据。
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly share: ShareService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(SHARE_PUBLIC, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const isLocalOnly = this.reflector.getAllAndOverride<boolean>(SHARE_LOCAL_ONLY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);

    const req = ctx.switchToHttp().getRequest<Request>();
    const ip = req.ip || req.socket?.remoteAddress;
    const local = isLoopback(ip);

    // 本机专属操作：即使口令正确也不放行 —— 否则共享用户能改全局配置
    if (isLocalOnly && !local) {
      throw new ForbiddenException({
        message: '该操作只能在这台主机上进行',
        code: 'LOCAL_ONLY',
      });
    }

    if (local) return true;

    if (!(await this.share.enabled())) {
      throw new ForbiddenException({
        message: '这台电脑未开启局域网共享，已拒绝来自其他设备的访问',
        code: 'SHARE_DISABLED',
        kind: 'SHARE_AUTH',
      });
    }

    const key = req.header('x-wkbd-key') ?? '';
    if (!key || !(await this.share.verify(ip ?? 'unknown', key))) {
      throw new UnauthorizedException({
        message: '需要访问口令',
        code: 'SHARE_AUTH_REQUIRED',
        kind: 'SHARE_AUTH',
      });
    }
    return true;
  }
}
