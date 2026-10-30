import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  DEFAULT_SCOPES,
  REQUIRED_SCOPES,
  SCOPE_META,
} from '@wkbd/shared';
import * as crypto from 'crypto';
import { CryptoService } from '../../common/crypto.service';
import { PrismaService } from '../../prisma/prisma.service';

/* --------------------------------------------------------------------------
 * 应用配置迁移包（portable package）
 *
 * 场景：软件是多人共用的。同一局域网内可以「共享一个后端」解决，
 * 但不在同一网络的人（异地、外网）连不上主机，只能在**自己的电脑上**装一份。
 * 而「开发者应用凭据」是团队唯一的 —— 让他们各自去开放平台建应用并不现实。
 *
 * 于是提供迁移包：主机导出 → 对方导入 → 立刻拥有同样的授权能力，
 * 然后各自授权**自己负责的广告账户**，不必再申请开发者账号。
 *
 * 两个设计要点：
 *   1. 用「迁移口令」加密（scrypt + AES-256-GCM），所以就算用微信/邮件传，
 *      app_secret 也不是明文裸奔；口令走另一条路告诉对方即可。
 *   2. **只含应用凭据，不含任何访问令牌**。授权凭证与设备绑定
 *      （refresh_token 是轮换制，复制过去只会互相踢下线），
 *      导入方必须自己走一遍授权 —— 这也正是「自行授权」的含义。
 * ------------------------------------------------------------------------ */

const PORTABLE_PREFIX = 'WKBD-CONFIG-V1';
const PORTABLE_MIN_PASSPHRASE = 6;

/** 用口令派生密钥加密（与主密钥无关，便于跨机器还原） */
function sealWithPassphrase(plain: string, passphrase: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    PORTABLE_PREFIX,
    salt.toString('base64url'),
    iv.toString('base64url'),
    tag.toString('base64url'),
    body.toString('base64url'),
  ].join('.');
}

function isPortable(text: string): boolean {
  return text.startsWith(`${PORTABLE_PREFIX}.`);
}

function openWithPassphrase(payload: string, passphrase: string): string {
  const parts = payload.split('.');
  if (parts.length !== 5 || parts[0] !== PORTABLE_PREFIX) {
    throw new BadRequestException('不是有效的迁移包');
  }
  const [, saltB64, ivB64, tagB64, bodyB64] = parts;
  const salt = Buffer.from(saltB64, 'base64url');
  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  const body = Buffer.from(bodyB64, 'base64url');
  const key = crypto.scryptSync(passphrase, salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  // 口令不对时 GCM 校验失败会抛错，这里让它自然冒泡给上层统一转成友好提示
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

interface PortableBody {
  v: number;
  appId: string;
  secret: string;
  redirectUri: string;
  scopes?: string[];
  exportedAt?: string;
}

export interface ResolvedAppConfig {
  appId: string;
  secret: string;
  redirectUri: string;
  scopes: string[];
  /** 配置来源：db=界面填写 / env=环境变量 / none=未配置 */
  source: 'db' | 'env' | 'none';
}

export interface SaveAppConfigInput {
  appId: string;
  /** 留空表示「不修改现有 secret」 —— 避免前端拿到掩码后又把掩码存回去 */
  secret?: string;
  redirectUri: string;
  /** 本次授权申请的权限范围；不传则用默认（核心三段 + 账户服务） */
  scopes?: string[];
}

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  /**
   * 解析生效中的应用配置。
   * 优先级：数据库（界面填写） > 环境变量。
   */
  async resolve(): Promise<ResolvedAppConfig> {
    const row = await this.prisma.appConfig.findUnique({ where: { id: 1 } });
    if (row?.appId && row?.secretEnc) {
      return {
        appId: row.appId,
        secret: this.crypto.decrypt(row.secretEnc),
        redirectUri: row.redirectUri,
        scopes: this.parseScopes(row.scopes),
        source: 'db',
      };
    }

    const appId = process.env.KUAI_APP_ID?.trim();
    const secret = process.env.KUAI_APP_SECRET?.trim();
    const redirectUri =
      process.env.KUAI_REDIRECT_URI?.trim() ||
      `http://localhost:${process.env.PORT ?? 7801}/api/oauth/callback`;

    if (appId && secret) {
      return { appId, secret, redirectUri, scopes: [...DEFAULT_SCOPES], source: 'env' };
    }

    return { appId: '', secret: '', redirectUri, scopes: [...DEFAULT_SCOPES], source: 'none' };
  }

  /** 供前端回显，secret 只露尾部 4 位 */
  async view() {
    const cfg = await this.resolve();
    const row = await this.prisma.appConfig.findUnique({ where: { id: 1 } });
    return {
      configured: cfg.source !== 'none',
      appId: cfg.appId || null,
      secretMasked: cfg.secret ? this.crypto.mask(cfg.secret) : null,
      redirectUri: cfg.redirectUri || null,
      scopes: cfg.scopes,
      source: cfg.source,
      updatedAt: row?.updatedAt?.toISOString() ?? null,
    };
  }

  async save(input: SaveAppConfigInput) {
    const existing = await this.prisma.appConfig.findUnique({ where: { id: 1 } });

    let secretEnc = existing?.secretEnc ?? '';
    if (input.secret && input.secret.trim().length > 0) {
      secretEnc = this.crypto.encrypt(input.secret.trim());
    }
    if (!secretEnc) {
      throw new BadRequestException('首次配置必须提供 app_secret');
    }

    const scopes = this.normalizeScopes(input.scopes);

    await this.prisma.appConfig.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        appId: input.appId.trim(),
        secretEnc,
        redirectUri: input.redirectUri.trim(),
        scopes: JSON.stringify(scopes),
      },
      update: {
        appId: input.appId.trim(),
        secretEnc,
        redirectUri: input.redirectUri.trim(),
        scopes: JSON.stringify(scopes),
      },
    });

    this.logger.log(
      `应用配置已更新：app_id=${input.appId.trim()}，scope=[${scopes.join(', ')}]`,
    );
    return this.view();
  }

  /** 清除配置（同时用于「换一个 app」场景） */
  async clear(): Promise<void> {
    await this.prisma.appConfig.deleteMany({ where: { id: 1 } });
    this.logger.warn('应用配置已清除');
  }

  /**
   * 导出应用配置迁移包（给不在同一网络的同事用）。
   * 只含开发者应用凭据，不含 token；用迁移口令加密。
   */
  async exportPortable(passphrase: string): Promise<{
    payload: string;
    fileName: string;
    appId: string;
    redirectUri: string;
    scopes: string[];
  }> {
    const pwd = passphrase.trim();
    if (pwd.length < PORTABLE_MIN_PASSPHRASE) {
      throw new BadRequestException(`迁移口令至少 ${PORTABLE_MIN_PASSPHRASE} 位`);
    }

    const cfg = await this.resolve();
    if (cfg.source === 'none' || !cfg.appId || !cfg.secret) {
      throw new BadRequestException('还没有配置开发者应用，没有可导出的内容');
    }

    const body: PortableBody = {
      v: 1,
      appId: cfg.appId,
      secret: cfg.secret,
      redirectUri: cfg.redirectUri,
      scopes: cfg.scopes,
      exportedAt: new Date().toISOString(),
    };

    this.logger.log(`已导出应用配置迁移包：app_id=${cfg.appId}`);
    return {
      payload: sealWithPassphrase(JSON.stringify(body), pwd),
      fileName: `wkbd-app-config-${cfg.appId}.wkbdkey.txt`,
      appId: cfg.appId,
      redirectUri: cfg.redirectUri,
      scopes: cfg.scopes,
    };
  }

  /** 导入迁移包，写入本机开发者应用配置（随后即可自行授权） */
  async importPortable(payload: string, passphrase: string) {
    const text = payload.trim();
    if (!text) throw new BadRequestException('请粘贴迁移包内容');
    if (!isPortable(text)) {
      throw new BadRequestException('迁移包格式不对：应以 WKBD-CONFIG-V1. 开头（请确认复制完整）');
    }

    let raw: string;
    try {
      raw = openWithPassphrase(text, passphrase);
    } catch {
      throw new BadRequestException('迁移口令不正确，或迁移包已损坏');
    }

    let parsed: PortableBody;
    try {
      parsed = JSON.parse(raw) as PortableBody;
    } catch {
      throw new BadRequestException('迁移包内容已损坏，请让主机重新导出');
    }

    if (!parsed?.appId || !parsed?.secret) {
      throw new BadRequestException('迁移包里缺少 app_id / app_secret');
    }

    const redirectUri =
      (parsed.redirectUri ?? '').trim() ||
      `http://localhost:${process.env.PORT ?? 7801}/api/oauth/callback`;

    const view = await this.save({
      appId: String(parsed.appId),
      secret: String(parsed.secret),
      redirectUri,
      scopes: Array.isArray(parsed.scopes) ? parsed.scopes.map(String) : undefined,
    });

    this.logger.log(`已导入应用配置迁移包：app_id=${parsed.appId}`);
    return view;
  }

  private parseScopes(raw: string): string[] {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) && parsed.length > 0 ? parsed.map(String) : [...DEFAULT_SCOPES];
    } catch {
      return [...DEFAULT_SCOPES];
    }
  }

  /**
   * 规范化 scope 列表：
   *   · 只保留已知 scope（防止手填错值导致授权页直接报错）
   *   · 核心三段权限强制保留 —— 授权是一次性的，漏掉就得让所有账户重新授权
   */
  private normalizeScopes(input?: string[]): string[] {
    const known = new Set(Object.keys(SCOPE_META));
    const picked = (input ?? []).filter((s) => known.has(s));
    const merged = [...new Set([...REQUIRED_SCOPES, ...picked])];
    return merged;
  }
}
