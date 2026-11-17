import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { extOf, readRawBody } from '../../common/raw-body';
import { AppCenterService } from './appcenter.service';

/**
 * 应用中心：上传 APK → 创建应用 → 发布 → 上架。
 *
 * 与「上计划」用的 /api/plan/assets/apps 分开：那条只读、只回已发布应用，
 * 这里能看到审核中/失败状态，并且是唯一能创建应用的地方。
 */
@Controller('api/appcenter')
export class AppCenterController {
  constructor(private readonly apps: AppCenterService) {}

  /**
   * 上传 APK（裸二进制，Content-Type: application/vnd.android.package-archive）。
   * 返回 blob_store_key —— 后面创建应用要拿它当入参。
   */
  @Post('apk')
  async uploadApk(
    @Req() req: Request,
    @Query('advertiserId') advertiserId: string,
    @Query('fileName') fileName?: string,
  ) {
    const MAX_BYTES = 300 * 1024 * 1024;
    const buffer = await readRawBody(req, MAX_BYTES);
    const name = String(fileName ?? 'app.apk');
    return this.apps.uploadApk(advertiserId, buffer, /\.apk$/i.test(name) ? name : `${name}.apk`);
  }

  /** 上传图片（type：1 图标 450×450<1MB / 2 应用图片 9:20 / 5 单机承诺函） */
  @Post('pic')
  async uploadPic(
    @Req() req: Request,
    @Query('advertiserId') advertiserId: string,
    @Query('type') type?: string,
    @Query('fileName') fileName?: string,
  ) {
    const t = Number(type);
    const picType = t === 1 || t === 5 ? (t as 1 | 5) : 2;
    const buffer = await readRawBody(req, 10 * 1024 * 1024);
    const name = String(fileName ?? 'pic.png');
    const ext = extOf(name) || '.png';
    const contentType =
      ext === '.jpg' || ext === '.jpeg'
        ? 'image/jpeg'
        : ext === '.webp'
          ? 'image/webp'
          : 'image/png';
    return this.apps.uploadPic(advertiserId, buffer, picType, name, contentType);
  }

  /** 应用列表（应用中心口径，含审核状态） */
  @Get('apps')
  list(
    @Query('advertiserId') advertiserId: string,
    @Query('listType') listType?: string,
    @Query('appStatus') appStatus?: string,
    @Query('keyword') keyword?: string,
  ) {
    return this.apps.listApps(advertiserId, {
      listType: listType ? Number(listType) : undefined,
      appStatus: appStatus ? Number(appStatus) : undefined,
      keyword: keyword || undefined,
    });
  }

  /** 创建 Android 应用（APK 必须先上传拿到 blob_store_key） */
  @Post('apps/android')
  createAndroid(@Body() body: Parameters<AppCenterService['createAndroid']>[0]) {
    return this.apps.createAndroid(body);
  }

  /** 创建 iOS 应用（只要 App Store 链接） */
  @Post('apps/ios')
  createIos(@Body() body: { advertiserId: string; iosDownloadUrl: string; appIconUrl?: string }) {
    return this.apps.createIos(body);
  }

  /** 发布应用（审核通过后；发布后 package_id 才能绑定单元） */
  @Post('apps/release')
  release(@Body() body: { advertiserId: string; packageIds: Array<string | number> }) {
    return this.apps.release(String(body.advertiserId ?? ''), body.packageIds ?? []);
  }

  /** 上架 / 下架 */
  @Post('apps/online')
  online(@Body() body: { advertiserId: string; packageIds: Array<string | number>; online?: boolean }) {
    return this.apps.setOnline(
      String(body.advertiserId ?? ''),
      body.packageIds ?? [],
      body.online !== false,
    );
  }
}
