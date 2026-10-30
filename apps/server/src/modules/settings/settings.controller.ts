import { Body, Controller, Delete, Get, Post } from '@nestjs/common';
import { IsArray, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { LocalOnly } from '../system/share.guard';
import { SettingsService } from './settings.service';

class SaveAppConfigDto {
  @IsString()
  @IsNotEmpty({ message: 'app_id 不能为空' })
  appId!: string;

  @IsOptional()
  @IsString()
  secret?: string;

  @IsString()
  @IsNotEmpty({ message: '回调地址不能为空' })
  redirectUri!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  scopes?: string[];
}

class ExportPortableDto {
  @IsString({ message: '迁移口令必须是文本' })
  @IsNotEmpty({ message: '请设置一个迁移口令' })
  passphrase!: string;
}

class ImportPortableDto {
  @IsString({ message: '迁移包内容必须是文本' })
  @IsNotEmpty({ message: '请粘贴迁移包内容' })
  payload!: string;

  @IsString({ message: '迁移口令必须是文本' })
  @IsNotEmpty({ message: '请输入迁移口令' })
  passphrase!: string;
}

@Controller('api/settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  /** 读取应用配置（脱敏）。共享用户可以读 —— 他们要靠 app_id 发起授权 */
  @Get('app')
  view() {
    return this.settings.view();
  }

  /**
   * 保存应用配置。**仅本机** —— 它决定了所有人的授权行为，
   * 不能让共享用户改（否则可以把自己的应用换成别人的）。
   */
  @LocalOnly()
  @Post('app')
  save(@Body() body: SaveAppConfigDto) {
    return this.settings.save(body);
  }

  /** 清除应用配置。仅本机 —— 会连带影响全部已授权账户 */
  @LocalOnly()
  @Delete('app')
  async clear() {
    await this.settings.clear();
    return { ok: true };
  }

  /**
   * 导出应用配置迁移包（给不在同一网络、需要在自己电脑上装软件的同事）。
   * **仅本机**：包里含 app_secret，不能让共享用户导出带走。
   */
  @LocalOnly()
  @Post('app/export')
  exportPortable(@Body() body: ExportPortableDto) {
    return this.settings.exportPortable(body.passphrase);
  }

  /**
   * 导入应用配置迁移包。**仅本机** —— 写入的是本机全局配置。
   * 导入后这台电脑就具备同样的授权能力，可自行授权自己的广告账户。
   */
  @LocalOnly()
  @Post('app/import')
  importPortable(@Body() body: ImportPortableDto) {
    return this.settings.importPortable(body.payload, body.passphrase);
  }
}
