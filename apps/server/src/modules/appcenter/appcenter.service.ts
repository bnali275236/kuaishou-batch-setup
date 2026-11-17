import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { MAPI_PATHS } from '@wkbd/shared';
import { MapiGateway } from '../../mapi/mapi.gateway';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * 应用中心（appcenter）资产操作。
 *
 * 与 PlanAssetsService.listApps 的区别（容易混淆，先说清）：
 *   - plan 那边用的是 `app/release/list`：**给单元创编选应用**，只读，
 *     只回「已发布可用」的包，所以列表里看不到审核中的应用；
 *   - 本模块用的是 `app/list`：**应用中心资产管理**，能看审核中/失败/待发布/已下架，
 *     也是创建/发布/上架的操作对象。
 *
 * 完整链路（平台侧的顺序，不能跳）：
 *   1. POST upload/apk           上传安装包 → blob_store_key（不是 app_id！）
 *   2. POST app/create/android   用 blob_store_key 建应用 → 得到 package_id，状态=审核中
 *   3. 平台人工审核通过 → 状态=待发布
 *   4. POST app/release          发布（把母包发布出去，发布后 package_id 才能绑定单元）
 *   5. POST app/online           上架到应用商店（可选，看投放目标）
 *
 * 单位与 ID：app_id / package_id 都是长整型，可能超出 JS 安全整数范围，
 * 一律 String 透传（与素材 photo_id 同样的处理）。
 */

export interface AppCenterItem {
  appId: string;
  packageId: string;
  appName: string;
  packageName: string;
  version: string;
  platform: string;
  /** 1 审核中 / 2 审核未通过 / 3 待发布 / 4 已发布 / 5 已下架（平台原值，可能缺省） */
  appStatus?: number;
  /** 投放状态（平台原值） */
  putStatus?: number;
  /** 1=我创建的 / 2=共享给我的 */
  sourceType?: number;
  iconUrl?: string;
  downloadUrl?: string;
  /** 审核意见（审核失败时平台会给） */
  reviewDetail?: string;
  updateTime?: string;
  raw: Record<string, unknown>;
}

export interface CreateAndroidInput {
  advertiserId: string;
  /** 上传 APK 返回的 blob_store_key */
  blobStoreKey: string;
  /** 应用名称（不填则用 APK 里解析出来的） */
  appName?: string;
  /** 1=软件 2=游戏 */
  category: number;
  developer: string;
  contactName: string;
  contactTel: string;
  contactEmail?: string;
  /** 隐私政策链接（必填） */
  privacyUrl: string;
  /** 备案号（国内应用必填） */
  recordNumber?: string;
  /** 功能介绍 */
  functionIntroduction?: string;
  /** 1=联网 2=单机 */
  networkType?: number;
  /** 敏感权限用途说明（申请了敏感权限时平台会要求） */
  sensitivePermissionDesc?: string;
  /** 图标（先调 upload/pic type=1 拿 URL） */
  appIconUrl?: string;
  /** 应用详情图（upload/pic type=2，多张） */
  appDetailImg?: string;
  applyAge?: number;
}

interface MapiEnvelope {
  data?: unknown;
  [k: string]: unknown;
}

/** 宽松取字符串：字段可能在 data 里，也可能在外层 */
function pickString(node: unknown, keys: string[]): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const obj = node as Record<string, unknown>;
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined || v === null || v === '') continue;
    return String(v);
  }
  return undefined;
}

function pickNumber(node: unknown, keys: string[]): number | undefined {
  const s = pickString(node, keys);
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function pickList(node: unknown, keys: string[]): unknown[] {
  if (Array.isArray(node)) return node;
  if (!node || typeof node !== 'object') return [];
  const obj = node as Record<string, unknown>;
  for (const k of keys) {
    const v = obj[k];
    if (Array.isArray(v)) return v;
  }
  return [];
}

@Injectable()
export class AppCenterService {
  private readonly logger = new Logger(AppCenterService.name);

  constructor(
    private readonly gateway: MapiGateway,
    private readonly prisma: PrismaService,
  ) {}

  /** 代投白名单账户只读：创建/发布/上架一律拒绝（服务端拦截，不靠前端藏按钮） */
  private async assertWritable(advertiserId: string): Promise<void> {
    if (!advertiserId) throw new BadRequestException('缺少 advertiserId');
    const locked = await this.prisma.oauthAccount.findFirst({
      where: { advertiserId, readOnly: true },
      select: { advertiserId: true },
    });
    if (locked) {
      throw new ForbiddenException(`账户 ${advertiserId} 在「代投白名单」内，禁止创建/发布应用`);
    }
  }

  /** 1️⃣ 上传 APK → blob_store_key */
  async uploadApk(
    advertiserId: string,
    buffer: Buffer,
    fileName: string,
  ): Promise<{ blobStoreKey: string; sizeBytes: number; fileName: string }> {
    await this.assertWritable(advertiserId);
    if (buffer.length < 1024) {
      throw new BadRequestException(`APK 内容过小(${buffer.length}B)，请确认选的是安装包`);
    }
    // 平台没有给 APK 单独的格式校验错误码，先在本机挡住明显不对的文件，省一次 400
    if (!/\.apk$/i.test(fileName) && buffer.subarray(0, 2).toString() !== 'PK') {
      throw new BadRequestException('不是 APK：请选择 .apk 安装包（zip 头校验未通过）');
    }

    const data = await this.gateway.call<MapiEnvelope>({
      advertiserId,
      path: MAPI_PATHS.APPCENTER_APK_UPLOAD,
      category: 'create',
      timeoutMs: 600_000,
      body: { advertiser_id: Number(advertiserId) },
      multipart: {
        buffer,
        fileName: /\.apk$/i.test(fileName) ? fileName : `${fileName}.apk`,
        contentType: 'application/vnd.android.package-archive',
      },
      action: 'appcenter.apk_upload',
    });

    const key =
      pickString(data, ['blob_store_key']) ??
      pickString((data.data as Record<string, unknown>) ?? {}, ['blob_store_key']);
    if (!key) {
      throw new Error(`上传响应没有 blob_store_key：${JSON.stringify(data).slice(0, 300)}`);
    }
    this.logger.log(`账户 ${advertiserId} APK 上传成功：${key}`);
    return { blobStoreKey: key, sizeBytes: buffer.length, fileName };
  }

  /** 2️⃣ 上传图片（type 1=图标 / 2=应用图片 / 5=单机承诺函）→ CDN URL */
  async uploadPic(
    advertiserId: string,
    buffer: Buffer,
    type: 1 | 2 | 5,
    fileName: string,
    contentType: string,
  ): Promise<{ url: string; sizeBytes: number }> {
    if (buffer.length < 128) throw new BadRequestException('图片内容过小，请重新选择');
    const limit = type === 1 ? 1 * 1024 * 1024 : type === 2 ? 2 * 1024 * 1024 : 10 * 1024 * 1024;
    if (buffer.length > limit) {
      throw new BadRequestException(
        `图片过大：${(buffer.length / 1024 / 1024).toFixed(1)}MB，该类型上限 ${(limit / 1024 / 1024).toFixed(0)}MB`,
      );
    }

    const data = await this.gateway.call<MapiEnvelope>({
      advertiserId,
      path: MAPI_PATHS.APPCENTER_PIC_UPLOAD,
      category: 'create',
      timeoutMs: 120_000,
      body: { advertiser_id: Number(advertiserId), type },
      multipart: { buffer, fileName, contentType },
      action: 'appcenter.pic_upload',
    });

    const url =
      pickString(data, ['url']) ??
      pickString((data.data as Record<string, unknown>) ?? {}, ['url']);
    if (!url) {
      throw new Error(`上传响应没有 url：${JSON.stringify(data).slice(0, 300)}`);
    }
    return { url, sizeBytes: buffer.length };
  }

  /**
   * 3️⃣ 应用中心列表（含审核状态）。
   *
   * ⚠️ 实测纠错（2026-11-17）：`list_type` **不能省略**。
   * SDK 注释写「不传=全部」，但真实接口直接回 401000「查询应用列表 list_type 填写有误」。
   * 所以「全部」要自己查两次（1=我创建的、2=共享给我的）再合并去重。
   * 124276386 就是典型：自有应用为空、共享应用里才有 com.pzds.pzds。
   */
  async listApps(
    advertiserId: string,
    opts: { listType?: number; appStatus?: number; keyword?: string } = {},
  ): Promise<AppCenterItem[]> {
    if (!advertiserId) throw new BadRequestException('缺少 advertiserId');

    const fetchOne = async (listType: number): Promise<AppCenterItem[]> => {
      const body: Record<string, unknown> = {
        advertiser_id: Number(advertiserId),
        list_type: listType,
        page: 1,
        page_size: 100,
      };
      if (opts.appStatus) body.app_status = opts.appStatus;
      if (opts.keyword) body.key_word = opts.keyword;

      const data = await this.gateway.call<MapiEnvelope>({
        advertiserId,
        path: MAPI_PATHS.APPCENTER_APP_LIST,
        body,
        action: 'appcenter.app_list',
      });
      return this.mapRows(pickList(data, ['list', 'details', 'data', 'apps']));
    };

    if (opts.listType === 1 || opts.listType === 2) return fetchOne(opts.listType);

    // 全部 = 自有 + 共享，按 package_id（兜底 app_id）去重
    const [own, shared] = await Promise.all([fetchOne(1), fetchOne(2)]);
    const seen = new Set<string>();
    const merged: AppCenterItem[] = [];
    for (const item of [...own, ...shared]) {
      const key = item.packageId || item.appId;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      merged.push(item);
    }
    return merged;
  }

  /** 平台条目 → 前端条目（ID 一律字符串，避免 19 位数字精度丢失） */
  private mapRows(rows: unknown[]): AppCenterItem[] {
    return rows.map((row) => {
      const r = (row ?? {}) as Record<string, unknown>;
      return {
        appId: pickString(r, ['app_id']) ?? '',
        packageId: pickString(r, ['package_id']) ?? '',
        appName: pickString(r, ['real_app_name', 'app_name', 'name']) ?? '',
        packageName: pickString(r, ['package_name']) ?? '',
        version: pickString(r, ['real_app_version', 'version']) ?? '',
        platform: pickString(r, ['platform']) ?? 'android',
        appStatus: pickNumber(r, ['app_status']),
        putStatus: pickNumber(r, ['put_status']),
        sourceType: pickNumber(r, ['source_type']),
        iconUrl: pickString(r, ['app_icon_url']),
        downloadUrl: pickString(r, ['url']),
        reviewDetail: pickString(r, ['review_detail']),
        updateTime: pickString(r, ['update_time']),
        raw: r,
      };
    });
  }

  /** 4️⃣ 创建 Android 应用（APK 已上传拿到 blob_store_key） */
  async createAndroid(input: CreateAndroidInput): Promise<Record<string, unknown>> {
    const advertiserId = String(input.advertiserId ?? '');
    await this.assertWritable(advertiserId);

    const missing: string[] = [];
    if (!input.blobStoreKey) missing.push('APK（请先上传安装包）');
    if (!input.category) missing.push('应用类型');
    if (!input.developer?.trim()) missing.push('开发者');
    if (!input.contactName?.trim()) missing.push('联系人姓名');
    if (!input.contactTel?.trim()) missing.push('联系人电话');
    if (!input.privacyUrl?.trim()) missing.push('隐私政策链接');
    if (missing.length) {
      throw new BadRequestException(`缺少必填项：${missing.join('、')}`);
    }
    if (!/^https?:\/\//i.test(input.privacyUrl.trim())) {
      throw new BadRequestException('隐私政策链接必须是 http(s) 完整地址');
    }

    const appInfo: Record<string, unknown> = {
      platform: 'android',
      category: Number(input.category),
      developer: input.developer.trim(),
      contact_name: input.contactName.trim(),
      contact_tel: input.contactTel.trim(),
      app_privacy_url: input.privacyUrl.trim(),
    };
    if (input.appName?.trim()) appInfo.real_app_name = input.appName.trim();
    if (input.contactEmail?.trim()) appInfo.contact_email = input.contactEmail.trim();
    if (input.recordNumber?.trim()) appInfo.record_number = input.recordNumber.trim();
    if (input.functionIntroduction?.trim()) {
      appInfo.function_introduction = input.functionIntroduction.trim();
    }
    if (input.networkType) appInfo.network_type = Number(input.networkType);
    if (input.appIconUrl?.trim()) appInfo.app_icon_url = input.appIconUrl.trim();
    if (input.appDetailImg?.trim()) appInfo.app_detail_img = input.appDetailImg.trim();
    if (input.applyAge) appInfo.apply_age = Number(input.applyAge);

    const packageInfo: Record<string, unknown> = {
      blob_store_key: input.blobStoreKey,
    };
    if (input.appName?.trim()) packageInfo.app_name = input.appName.trim();
    if (input.sensitivePermissionDesc?.trim()) {
      packageInfo.sensitive_permission_desc = input.sensitivePermissionDesc.trim();
    }

    const data = await this.gateway.call<MapiEnvelope>({
      advertiserId,
      path: MAPI_PATHS.APPCENTER_APP_CREATE_ANDROID,
      category: 'create',
      timeoutMs: 180_000,
      body: {
        advertiser_id: Number(advertiserId),
        app_info: appInfo,
        app_privacy_info: { url: input.privacyUrl.trim() },
        package_info: packageInfo,
      },
      action: 'appcenter.app_create_android',
    });

    const inner = (data.data as Record<string, unknown>) ?? data;
    this.logger.log(
      `账户 ${advertiserId} 创建应用成功：app_id=${pickString(inner, ['app_id']) ?? '?'} package_id=${
        pickString(inner, ['package_id']) ?? '?'
      }`,
    );
    return inner;
  }

  /** 5️⃣ 创建 iOS 应用（只要 App Store 链接） */
  async createIos(input: {
    advertiserId: string;
    iosDownloadUrl: string;
    appIconUrl?: string;
  }): Promise<Record<string, unknown>> {
    const advertiserId = String(input.advertiserId ?? '');
    await this.assertWritable(advertiserId);
    if (!/^https?:\/\//i.test(input.iosDownloadUrl ?? '')) {
      throw new BadRequestException('请填写完整的 App Store 应用链接（https://apps.apple.com/...）');
    }
    const body: Record<string, unknown> = {
      advertiser_id: Number(advertiserId),
      ios_download_url: input.iosDownloadUrl.trim(),
    };
    if (input.appIconUrl?.trim()) body.app_icon_url = input.appIconUrl.trim();

    const data = await this.gateway.call<MapiEnvelope>({
      advertiserId,
      path: MAPI_PATHS.APPCENTER_APP_CREATE_IOS,
      category: 'create',
      timeoutMs: 120_000,
      body,
      action: 'appcenter.app_create_ios',
    });
    return (data.data as Record<string, unknown>) ?? data;
  }

  /** 6️⃣ 发布应用（审核通过的母包；发布后 package_id 才能在单元里用） */
  async release(advertiserId: string, packageIds: Array<string | number>): Promise<unknown> {
    await this.assertWritable(advertiserId);
    const ids = (packageIds ?? []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
    if (!ids.length) throw new BadRequestException('缺少 package_ids（应用包 ID）');

    const data = await this.gateway.call<MapiEnvelope>({
      advertiserId,
      path: MAPI_PATHS.APPCENTER_APP_RELEASE,
      body: { advertiser_id: Number(advertiserId), package_ids: ids },
      action: 'appcenter.app_release',
    });
    return (data.data as Record<string, unknown>) ?? data;
  }

  /** 7️⃣ 上架 / 下架（应用商店维度） */
  async setOnline(
    advertiserId: string,
    packageIds: Array<string | number>,
    online: boolean,
  ): Promise<unknown> {
    await this.assertWritable(advertiserId);
    const ids = (packageIds ?? []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
    if (!ids.length) throw new BadRequestException('缺少 package_ids（应用包 ID）');

    const data = await this.gateway.call<MapiEnvelope>({
      advertiserId,
      path: online ? MAPI_PATHS.APPCENTER_APP_ONLINE : MAPI_PATHS.APPCENTER_APP_OFFLINE,
      body: { advertiser_id: Number(advertiserId), package_ids: ids },
      action: online ? 'appcenter.app_online' : 'appcenter.app_offline',
    });
    return (data.data as Record<string, unknown>) ?? data;
  }
}
