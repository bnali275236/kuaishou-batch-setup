import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { paths } from './paths';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

/**
 * 凭证加密服务。
 *
 * 用于加密 app_secret / access_token / refresh_token —— 这些值落库时必须密文。
 * 桌面版后续可替换为 Electron safeStorage（底层走 Windows DPAPI），
 * 接口保持不变即可平滑迁移。
 *
 * 密钥来源优先级：
 *   1. APP_MASTER_KEY 环境变量（64 位 hex）
 *   2. <DATA_DIR>/master.key 密钥文件（首次启动自动生成）
 */
@Injectable()
export class CryptoService implements OnModuleInit {
  private readonly logger = new Logger(CryptoService.name);
  private key: Buffer;

  onModuleInit(): void {
    this.key = this.loadOrCreateKey();
  }

  private loadOrCreateKey(): Buffer {
    const fromEnv = process.env.APP_MASTER_KEY?.trim();
    if (fromEnv) {
      const buf = Buffer.from(fromEnv, 'hex');
      if (buf.length !== KEY_LENGTH) {
        throw new Error(
          `APP_MASTER_KEY 长度不合法：期望 ${KEY_LENGTH} 字节（${KEY_LENGTH * 2} 位 hex），实际 ${buf.length} 字节`,
        );
      }
      this.logger.log('主密钥来源：环境变量 APP_MASTER_KEY');
      return buf;
    }

    const keyFile = paths.masterKeyFile;
    if (fs.existsSync(keyFile)) {
      const buf = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
      if (buf.length === KEY_LENGTH) return buf;
      this.logger.warn('master.key 内容损坏，将重新生成（原有密文需重新录入凭证）');
    }

    const generated = crypto.randomBytes(KEY_LENGTH);
    fs.writeFileSync(keyFile, generated.toString('hex'), { mode: 0o600 });
    this.logger.log(`已生成主密钥文件：${keyFile}（请连同数据目录一起备份）`);
    return generated;
  }

  /** 加密。输出格式：v1:<iv_b64>:<tag_b64>:<cipher_b64> */
  encrypt(plain: string): string {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGO, this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
  }

  /** 解密。兼容未加密的历史明文（直接返回），便于调试期平滑过渡 */
  decrypt(payload: string): string {
    if (!payload.startsWith('v1:')) return payload;
    const parts = payload.split(':');
    if (parts.length !== 4) throw new Error('密文格式不合法');
    const [, ivB64, tagB64, dataB64] = parts;
    const decipher = crypto.createDecipheriv(ALGO, this.key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  /** 只显示尾部若干位，用于前端回显确认，绝不泄露完整值 */
  mask(value: string, tail = 4): string {
    if (!value) return '';
    if (value.length <= tail) return '*'.repeat(value.length);
    return `${'*'.repeat(Math.min(8, value.length - tail))}${value.slice(-tail)}`;
  }
}
