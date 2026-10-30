import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { paths } from '../../common/paths';
import { PrismaService } from '../../prisma/prisma.service';

/* ------------------------------------------------------------------
 * 局域网共享（2026-10-08）
 *
 * 为什么需要它：
 *   token 是按「应用 + 快手账号」签发的，本身与设备无关，所以多台电脑
 *   共用一份授权在技术上完全可行。但官方 refresh_token 是**轮换制** ——
 *   doc 2057 原文「每次刷新都会产生新的 access_token 和 refresh_token…
 *   老的 access_token 和 refresh_token 将不可再使用」。因此把 token 复制到
 *   多台设备各自使用必然互相踢下线（谁先刷新谁有效）。
 *
 *   唯一干净的共享方式：后端跑在一台主机上（token 只有一个进程持有、
 *   只刷新一次），其他设备**用浏览器**打开这台主机的地址。前端本就是
 *   普通 Web 应用、由后端同源托管（main.ts），所以这条路零改造即可用，
 *   缺的只是「监听地址」与「访问口令」两件事。
 *
 * 为什么必须有口令：
 *   后端此前没有任何鉴权。端口一旦开在局域网，同网段任何人都能调
 *   /api/manage/*（改出价、改预算、改状态）与 /api/plan/tasks（真实建计划），
 *   而这些都是花真金白银的操作。所以 enabled=true 时强制要求设置口令，
 *   由 AccessGuard 对**所有非本机请求**校验。
 *
 * 本机（127.0.0.1 / ::1）请求永远放行 —— 桌面版本体、本机浏览器都不受影响，
 * 只有来自其他设备的请求才需要口令。
 * ------------------------------------------------------------------ */

/** 重启意图标记文件：后端写、Electron 主进程读（两边都硬编码这个名字） */
export const RESTART_MARKER = '.restart-intent';

/** 口令尝试限流：同一个 IP 在窗口期内最多失败这么多次（防暴力猜口令） */
const AUTH_MAX_ATTEMPTS = 10;
const AUTH_WINDOW_MS = 5 * 60 * 1000;

export interface ShareState {
  /** 是否允许其他设备访问 */
  enabled: boolean;
  /** 是否已设置访问口令（enabled=true 时必定为 true） */
  hasPassword: boolean;
  /** 当前进程生效中的监听模式（由启动时读取，改动需重启才生效） */
  effectiveEnabled: boolean;
  /** 需要重启才能生效 */
  restartRequired: boolean;
  /** 仅本机可访问时的地址 */
  localUrl: string;
  /** 局域网可访问地址（每张网卡一条） */
  lanUrls: string[];
  port: number;
}

@Injectable()
export class ShareService {
  private readonly logger = new Logger(ShareService.name);
  /** 口令尝试记录：ip → 失败时间戳数组 */
  private readonly attempts = new Map<string, number[]>();

  constructor(private readonly prisma: PrismaService) {}

  /* ---------------- 配置读写 ---------------- */

  private async row() {
    return this.prisma.shareConfig.findUnique({ where: { id: 1 } });
  }

  /** 当前进程是否以「局域网可达」的方式监听（启动时由 main.ts 写入环境变量） */
  effectiveEnabled(): boolean {
    return process.env.WKBD_BIND_LAN === '1';
  }

  private port(): number {
    return Number(process.env.PORT ?? 7801);
  }

  async enabled(): Promise<boolean> {
    return (await this.row())?.enabled ?? false;
  }

  async hasPassword(): Promise<boolean> {
    return Boolean((await this.row())?.passwordHash);
  }

  async state(): Promise<ShareState> {
    const r = await this.row();
    const enabled = r?.enabled ?? false;
    return {
      enabled,
      hasPassword: Boolean(r?.passwordHash),
      effectiveEnabled: this.effectiveEnabled(),
      restartRequired: enabled !== this.effectiveEnabled(),
      localUrl: `http://127.0.0.1:${this.port()}/`,
      lanUrls: this.lanUrls(),
      port: this.port(),
    };
  }

  /**
   * 保存共享配置。
   * - password 传非空字符串 → 设置/修改口令
   * - password 传 null → 清除口令（仅允许在关闭共享时清）
   * - password 不传 / 空串 → 保持原口令不动（前端只显示「已设置」，不回传明文）
   */
  async save(input: { enabled: boolean; password?: string | null }): Promise<ShareState> {
    const existing = await this.row();
    let passwordHash = existing?.passwordHash ?? null;

    if (typeof input.password === 'string' && input.password.length > 0) {
      if (input.password.trim().length < 4) {
        throw new BadRequestException('访问口令至少 4 位');
      }
      passwordHash = this.hash(input.password);
    } else if (input.password === null) {
      passwordHash = null;
    }

    // 开共享就必须有口令 —— 这是硬性约束，不是建议。
    // 没有口令等于把「改出价 / 建计划」的权限开放给同网段所有人。
    if (input.enabled && !passwordHash) {
      throw new BadRequestException('开启局域网共享前必须设置访问口令');
    }

    await this.prisma.shareConfig.upsert({
      where: { id: 1 },
      create: { id: 1, enabled: input.enabled, passwordHash },
      update: { enabled: input.enabled, passwordHash },
    });

    this.logger.log(
      `共享配置已更新：enabled=${input.enabled}，口令=${passwordHash ? '已设置' : '未设置'}`,
    );
    return this.state();
  }

  /* ---------------- 口令校验 ---------------- */

  private hash(password: string): string {
    const salt = crypto.randomBytes(16);
    const derived = crypto.scryptSync(password, salt, 32);
    return `${salt.toString('hex')}:${derived.toString('hex')}`;
  }

  private match(password: string, stored: string): boolean {
    const [saltHex, hashHex] = stored.split(':');
    if (!saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }

  /** 校验口令；带失败次数限流，避免被在线爆破 */
  async verify(ip: string, password: string): Promise<boolean> {
    if (this.tooManyAttempts(ip)) return false;
    const r = await this.row();
    if (!r?.passwordHash) return false;
    const ok = this.match(password, r.passwordHash);
    if (!ok) this.recordFailure(ip);
    else this.attempts.delete(ip);
    return ok;
  }

  private tooManyAttempts(ip: string): boolean {
    const now = Date.now();
    const list = (this.attempts.get(ip) ?? []).filter((t) => now - t < AUTH_WINDOW_MS);
    this.attempts.set(ip, list);
    return list.length >= AUTH_MAX_ATTEMPTS;
  }

  private recordFailure(ip: string): void {
    const list = this.attempts.get(ip) ?? [];
    list.push(Date.now());
    this.attempts.set(ip, list);
    this.logger.warn(`访问口令校验失败（来源 ${ip}，累计 ${list.length} 次）`);
  }

  /* ---------------- 地址枚举 ---------------- */

  /** 本机所有非回环 IPv4 地址对应的访问地址（用于提示其他设备该怎么访问） */
  lanUrls(): string[] {
    const port = this.port();
    const out: string[] = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list ?? []) {
        if (ni.family !== 'IPv4' || ni.internal) continue;
        out.push(`http://${ni.address}:${port}/`);
      }
    }
    return out;
  }

  /* ---------------- 重启 ---------------- */

  /**
   * 写重启标记后退出进程。
   * Electron 主进程看到这个标记会把后端重新拉起并刷新窗口，
   * 所以用户感知只是「界面闪一下」而不是「应用崩了」。
   */
  markRestart(): void {
    try {
      fs.writeFileSync(path.join(paths.dataDir, RESTART_MARKER), String(Date.now()), 'utf8');
    } catch (err) {
      this.logger.warn(`写重启标记失败：${(err as Error).message}`);
    }
  }
}

/** 判断请求是否来自本机回环地址（IPv4 / IPv6 / IPv4-mapped） */
export function isLoopback(ip?: string): boolean {
  if (!ip) return false;
  const v = ip.replace(/^::ffff:/i, '').trim();
  return v === '::1' || v === 'localhost' || v.startsWith('127.');
}
