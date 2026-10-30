import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { RateLimiterService } from '../../mapi/rate-limiter.service';
import { TokenScheduler } from '../../scheduler/token.scheduler';
import { SharePublic } from './share.guard';
import { isLoopback, ShareService } from './share.service';

/** 系统状态：配额水位 + 账户健康度，前端顶栏展示 */
@Controller('api/system')
export class SystemController {
  constructor(
    private readonly limiter: RateLimiterService,
    private readonly scheduler: TokenScheduler,
    private readonly share: ShareService,
  ) {}

  @Get('health')
  async health() {
    return {
      ok: true,
      at: new Date().toISOString(),
      accounts: await this.scheduler.accountHealth(),
      rateLimit: this.limiter.snapshot(),
    };
  }

  /* ------------------------------------------------------------------
   * 局域网共享
   * ------------------------------------------------------------------ */

  /**
   * 完整共享状态 —— 只允许本机读。
   * 不为保密，而是「谁能改配置」必须严格限定在本机：
   * 否则别的设备可以把自己加进白名单。
   */
  @Get('share')
  async shareState(@Req() req: Request) {
    this.assertLocal(req);
    return this.share.state();
  }

  /** 保存共享配置（开关 + 口令），只允许本机操作 */
  @Post('share')
  async saveShare(
    @Req() req: Request,
    @Body() body: { enabled?: boolean; password?: string | null },
  ) {
    this.assertLocal(req);
    return this.share.save({
      enabled: Boolean(body?.enabled),
      password: typeof body?.password === 'string' ? body.password : undefined,
    });
  }

  /**
   * 口令门探针：免鉴权。
   * 其他设备打开页面时，前端靠它判断「弹出口令输入框」还是
   * 显示「这台电脑没开共享，找管理员开一下」。
   */
  @SharePublic()
  @Post('share/probe')
  async shareProbe(@Req() req: Request) {
    const local = isLoopback(req.ip || req.socket?.remoteAddress);
    const enabled = await this.share.enabled();
    return {
      isLocal: local,
      enabled,
      hasPassword: await this.share.hasPassword(),
      requiresKey: !local && enabled,
    };
  }

  /** 口令校验（即其他设备的「登录」入口）。口令错误返回 401，前端提示重试 */
  @SharePublic()
  @Post('share/verify')
  async shareVerify(@Req() req: Request, @Body() body: { password?: string }) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const password = typeof body?.password === 'string' ? body.password : '';
    const ok = password.length > 0 && (await this.share.verify(ip, password));
    if (!ok) {
      throw new UnauthorizedException({
        message: '访问口令不正确',
        code: 'SHARE_AUTH_REQUIRED',
        kind: 'SHARE_AUTH',
      });
    }
    return { ok: true };
  }

  /**
   * 重启后端让监听地址变更生效。
   * 只允许本机触发；写重启标记后短暂延迟退出，让响应先发出去。
   * Electron 主进程看到标记会把后端重新拉起（用户感知只是界面闪一下）。
   */
  @Post('restart')
  async restart(@Req() req: Request) {
    this.assertLocal(req);
    this.share.markRestart();
    setTimeout(() => process.exit(0), 600);
    return { ok: true, message: '后端正在重启，界面会自动恢复' };
  }

  private assertLocal(req: Request): void {
    const ip = req.ip || req.socket?.remoteAddress;
    if (!isLoopback(ip)) {
      throw new ForbiddenException({
        message: '该操作仅允许在本机进行',
        code: 'LOCAL_ONLY',
      });
    }
  }
}
