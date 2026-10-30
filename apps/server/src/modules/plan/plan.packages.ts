import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/** 定向包条目（面向前端） */
export interface TargetPackageDto {
  id: number;
  name: string;
  note: string | null;
  targeting: Record<string, unknown>;
}

/**
 * 定向包 —— 对齐创量模式：先在包库里把定向配好，上计划时直接选择。
 * 包体是 targeting JSON（与 PlanRow.targeting 同构），应用后仍走 mapper 白名单。
 */
@Injectable()
export class PlanPackagesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<TargetPackageDto[]> {
    const rows = await this.prisma.targetPackage.findMany({ orderBy: { updatedAt: 'desc' } });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      note: r.note,
      targeting: this.safeParse(r.targetingJson),
    }));
  }

  async create(name: string, note: string | null, targeting: unknown): Promise<TargetPackageDto> {
    const clean = this.assertObject(targeting);
    const row = await this.prisma.targetPackage.create({
      data: {
        name: (name ?? '').trim() || '未命名定向包',
        note: note?.trim() || null,
        targetingJson: JSON.stringify(clean),
      },
    });
    return { id: row.id, name: row.name, note: row.note, targeting: clean };
  }

  async update(
    id: number,
    name: string,
    note: string | null,
    targeting: unknown,
  ): Promise<TargetPackageDto> {
    const clean = this.assertObject(targeting);
    const row = await this.prisma.targetPackage.update({
      where: { id },
      data: {
        name: (name ?? '').trim() || '未命名定向包',
        note: note?.trim() || null,
        targetingJson: JSON.stringify(clean),
      },
    });
    return { id: row.id, name: row.name, note: row.note, targeting: clean };
  }

  async remove(id: number): Promise<void> {
    await this.prisma.targetPackage.delete({ where: { id } }).catch(() => undefined);
  }

  /** 包体必须是平面对象；值类型做基本约束，防止存进无法提交的脏数据 */
  private assertObject(targeting: unknown): Record<string, unknown> {
    if (targeting == null || typeof targeting !== 'object' || Array.isArray(targeting)) {
      throw new BadRequestException('定向包内容必须是一个定向参数对象');
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(targeting as Record<string, unknown>)) {
      if (v === null || v === undefined || v === '') continue;
      if (Array.isArray(v) && v.length === 0) continue;
      out[k] = v;
    }
    if (Object.keys(out).length === 0) {
      throw new BadRequestException('定向包不能为空（当前没有任何定向参数）');
    }
    return out;
  }

  private safeParse(json: string): Record<string, unknown> {
    try {
      const v = JSON.parse(json);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  }

  /* ---------------- 文案包（可复用的文案批次资产） ---------------- */

  async listCopies(): Promise<CopyPackageDto[]> {
    const rows = await this.prisma.copyPackage.findMany({ orderBy: { updatedAt: 'desc' } });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      note: r.note,
      titles: this.safeParseArray(r.titlesJson),
    }));
  }

  async createCopy(name: string, note: string | null, titles: string[]): Promise<CopyPackageDto> {
    const clean = this.assertTitles(titles);
    const row = await this.prisma.copyPackage.create({
      data: {
        name: (name ?? '').trim() || '未命名文案包',
        note: note?.trim() || null,
        titlesJson: JSON.stringify(clean),
      },
    });
    return { id: row.id, name: row.name, note: row.note, titles: clean };
  }

  async updateCopy(id: number, name: string, note: string | null, titles: string[]): Promise<CopyPackageDto> {
    const clean = this.assertTitles(titles);
    const row = await this.prisma.copyPackage.update({
      where: { id },
      data: {
        name: (name ?? '').trim() || '未命名文案包',
        note: note?.trim() || null,
        titlesJson: JSON.stringify(clean),
      },
    });
    return { id: row.id, name: row.name, note: row.note, titles: clean };
  }

  async removeCopy(id: number): Promise<void> {
    await this.prisma.copyPackage.delete({ where: { id } }).catch(() => undefined);
  }

  /** 文案包：字符串数组，去空白去重，非空 */
  private assertTitles(titles: unknown): string[] {
    if (!Array.isArray(titles)) throw new BadRequestException('文案包内容必须是字符串数组');
    const out: string[] = [];
    for (const t of titles) {
      if (typeof t !== 'string') continue;
      const s = t.trim();
      if (s && !out.includes(s)) out.push(s);
    }
    if (out.length === 0) throw new BadRequestException('文案包不能为空（至少一条文案）');
    return out;
  }

  private safeParseArray(json: string): string[] {
    try {
      const v = JSON.parse(json);
      return Array.isArray(v) ? v.map(String) : [];
    } catch {
      return [];
    }
  }

  /* ---------------- 监测链接包（命名的第三方监测链接资产） ---------------- */

  async listMonitors(): Promise<MonitorPackageDto[]> {
    const rows = await this.prisma.monitorPackage.findMany({ orderBy: { updatedAt: 'desc' } });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      note: r.note,
      clickUrl: r.clickUrl,
      impressionUrl: r.impressionUrl,
    }));
  }

  async createMonitor(
    name: string,
    note: string | null,
    clickUrl: string,
    impressionUrl: string,
  ): Promise<MonitorPackageDto> {
    const clean = this.assertMonitorUrls(clickUrl, impressionUrl);
    const row = await this.prisma.monitorPackage.create({
      data: {
        name: (name ?? '').trim() || '未命名监测链接',
        note: note?.trim() || null,
        clickUrl: clean.clickUrl,
        impressionUrl: clean.impressionUrl,
      },
    });
    return { id: row.id, name: row.name, note: row.note, ...clean };
  }

  async updateMonitor(
    id: number,
    name: string,
    note: string | null,
    clickUrl: string,
    impressionUrl: string,
  ): Promise<MonitorPackageDto> {
    const clean = this.assertMonitorUrls(clickUrl, impressionUrl);
    const row = await this.prisma.monitorPackage.update({
      where: { id },
      data: {
        name: (name ?? '').trim() || '未命名监测链接',
        note: note?.trim() || null,
        clickUrl: clean.clickUrl,
        impressionUrl: clean.impressionUrl,
      },
    });
    return { id: row.id, name: row.name, note: row.note, ...clean };
  }

  async removeMonitor(id: number): Promise<void> {
    await this.prisma.monitorPackage.delete({ where: { id } }).catch(() => undefined);
  }

  /** 至少一条链接；两条都要求是合法 http(s) 地址（监测链接下发到创意层，错了平台会拒） */
  private assertMonitorUrls(clickUrl: string, impressionUrl: string) {
    const click = (clickUrl ?? '').trim();
    const impression = (impressionUrl ?? '').trim();
    if (!click && !impression) {
      throw new BadRequestException('监测链接包不能为空（至少填写一条监测链接）');
    }
    for (const [label, url] of [
      ['点击监测链接', click],
      ['展示监测链接', impression],
    ] as const) {
      if (url && !/^https?:\/\//i.test(url)) {
        throw new BadRequestException(`${label}必须以 http(s):// 开头`);
      }
    }
    return { clickUrl: click, impressionUrl: impression };
  }
}

/** 监测链接包条目（面向前端） */
export interface MonitorPackageDto {
  id: number;
  name: string;
  note: string | null;
  clickUrl: string;
  impressionUrl: string;
}

/** 文案包条目（面向前端） */
export interface CopyPackageDto {
  id: number;
  name: string;
  note: string | null;
  titles: string[];
}
