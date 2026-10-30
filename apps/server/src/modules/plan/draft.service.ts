import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  AccountSummary,
  PlanDraftView,
  PlanRow,
  PlanRowIssue,
  PlanValidateResult,
  TASK_ITEM_STATUS,
  TASK_LEVEL,
} from '@wkbd/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { validateRows } from './plan.validator';

/**
 * 草稿与校验。
 *
 * 为什么草稿要落库：一张 100 行的创编表，用户可能填半小时。
 * 放在前端 state 里，刷新一次就全没了——这种事故一旦发生，
 * 用户就不会再信任这个工具。所以任何编辑都要能恢复。
 */
@Injectable()
export class DraftService {
  private readonly logger = new Logger(DraftService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<PlanDraftView[]> {
    const drafts = await this.prisma.planDraft.findMany({ orderBy: { updatedAt: 'desc' }, take: 50 });
    return drafts.map((draft) => this.toView(draft));
  }

  async get(id: number): Promise<PlanDraftView> {
    const draft = await this.prisma.planDraft.findUnique({ where: { id } });
    if (!draft) throw new NotFoundException(`草稿 #${id} 不存在`);
    return this.toView(draft);
  }

  async save(input: {
    id?: number;
    name: string;
    campaignType: number;
    rows: PlanRow[];
    /** 策略组表单快照（CardForm JSON 序列化串） */
    formJson?: string | null;
  }): Promise<PlanDraftView> {
    const rowsJson = JSON.stringify(input.rows ?? []);
    if (input.id) {
      await this.prisma.planDraft.update({
        where: { id: input.id },
        data: {
          name: input.name,
          campaignType: input.campaignType,
          rowsJson,
          formJson: input.formJson ?? null,
        },
      });
      return this.get(input.id);
    }
    const created = await this.prisma.planDraft.create({
      data: {
        name: input.name,
        campaignType: input.campaignType,
        rowsJson,
        formJson: input.formJson ?? null,
      },
    });
    return this.toView(created);
  }

  async remove(id: number): Promise<void> {
    await this.prisma.planDraft.delete({ where: { id } }).catch(() => undefined);
  }

  /**
   * 校验（干跑）。
   *
   * 除了字段级校验，还给出「按账户的创建数量统计」与「今日已用配额」，
   * 让用户在提交前就知道这次要动多少量、离平台上限还有多远。
   * 这两件事如果不提前告诉用户，就只能在提交失败后才知道。
   */
  async validate(rows: PlanRow[]): Promise<PlanValidateResult> {
    const issues: PlanRowIssue[] = validateRows(rows);

    const since = new Date();
    since.setHours(0, 0, 0, 0);
    const todayItems = await this.prisma.batchTaskItem.findMany({
      where: { createdAt: { gte: since }, status: TASK_ITEM_STATUS.SUCCEEDED },
      select: { advertiserId: true, level: true },
    });
    const usedByAccount = new Map<string, number>();
    for (const item of todayItems) {
      if (item.level !== TASK_LEVEL.CAMPAIGN) continue;
      usedByAccount.set(item.advertiserId, (usedByAccount.get(item.advertiserId) ?? 0) + 1);
    }

    const accountIds = [...new Set(rows.map((r) => r.advertiserId).filter(Boolean))];
    const accounts: AccountSummary[] = accountIds.length
      ? ((await this.prisma.oauthAccount.findMany({
          where: { advertiserId: { in: accountIds } },
        })) as unknown as AccountSummary[])
      : [];
    const nameOf = new Map(accounts.map((a) => [a.advertiserId, a.accountName]));

    const perAccount = accountIds.map((advertiserId) => {
      const rowsOfAccount = rows.filter((r) => r.advertiserId === advertiserId);
      // 一行 = 1 计划 + N 组 × M 创意；units 模型（素材切分）按 units 数组算，
      // 旧模型按 unitsPerCampaign 放大
      const unitCount = (r: PlanRow) =>
        r.units && r.units.length > 0
          ? r.units.length
          : Math.min(Math.max(Math.trunc(r.unitsPerCampaign ?? 1) || 1, 1), 50);
      const creativeCount = (r: PlanRow) =>
        r.units && r.units.length > 0
          ? r.units.reduce((n, u) => n + Math.max(u.videos.length, 0), 0)
          : unitCount(r) * Math.max(r.creativeVideos?.length ?? 1, 1);
      return {
        advertiserId,
        accountName: nameOf.get(advertiserId) ?? null,
        campaigns: rowsOfAccount.length,
        units: rowsOfAccount.reduce((n, r) => n + unitCount(r), 0),
        creatives: rowsOfAccount.reduce((n, r) => n + creativeCount(r), 0),
        createdToday: usedByAccount.get(advertiserId) ?? 0,
      };
    });

    return {
      rows: rows.length,
      errorCount: issues.filter((i) => i.severity === 'ERROR').length,
      warnCount: issues.filter((i) => i.severity === 'WARN').length,
      issues,
      perAccount,
    };
  }

  /** 草稿提交前的兜底校验：草稿里存的可能是旧版本的行数据 */
  assertRowsValid(rows: PlanRow[]): void {
    const errors = validateRows(rows).filter((i) => i.severity === 'ERROR');
    if (errors.length > 0) {
      throw new Error(`草稿有 ${errors.length} 处错误，请先修正`);
    }
  }

  private toView(draft: {
    id: number;
    name: string;
    campaignType: number;
    rowsJson: string;
    formJson: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): PlanDraftView {
    let rows: PlanRow[] = [];
    try {
      const parsed = JSON.parse(draft.rowsJson);
      if (Array.isArray(parsed)) rows = parsed as PlanRow[];
    } catch {
      this.logger.warn(`草稿 #${draft.id} 的行数据解析失败，已按空表返回`);
    }
    return {
      id: draft.id,
      name: draft.name,
      campaignType: draft.campaignType,
      rows,
      formJson: draft.formJson ?? null,
      createdAt: draft.createdAt.toISOString(),
      updatedAt: draft.updatedAt.toISOString(),
    };
  }
}
