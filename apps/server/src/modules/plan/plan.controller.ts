import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { InitialStatus, PlanRow } from '@wkbd/shared';
import { DraftService } from './draft.service';
import { PlanAssetsService } from './plan.assets';
import { PlanPackagesService } from './plan.packages';
import { TaskService } from './task.service';

/**
 * 上计划（批量创编）接口。
 *
 * 调用顺序（前端按这个顺序走）：
 *   1. POST /api/plan/validate      提交前校验，拿到每行错误 + 各账户将创建的数量
 *   2. POST /api/plan/tasks         创建任务（校验不通过会被直接拒掉）
 *   3. GET  /api/plan/tasks/:id     轮询进度
 *   4. POST /api/plan/tasks/:id/retry-failed   只重试失败项
 *   5. POST /api/plan/tasks/:id/verify         回读核验
 */
@Controller('api/plan')
export class PlanController {
  constructor(
    private readonly drafts: DraftService,
    private readonly tasks: TaskService,
    private readonly assets: PlanAssetsService,
    private readonly packages: PlanPackagesService,
  ) {}

  /* ---------------- 账户资产 ---------------- */

  /** 账户下的视频素材（force=1 绕过 10 分钟缓存） */
  @Get('assets/videos')
  assetVideos(@Query('advertiserId') advertiserId: string, @Query('force') force?: string) {
    return this.assets.listVideos(String(advertiserId ?? ''), force === '1');
  }

  /** 按 photoId 批量核对素材在库情况（素材库共享，跨主题/跑量素材直接按 ID 精确查） */
  @Post('assets/videos/check')
  assetVideosCheck(@Body() body: { advertiserId: string; photoIds: string[] }) {
    return this.assets.checkVideosByIds(String(body.advertiserId ?? ''), body.photoIds ?? []);
  }

  /** 从源 URL 下载视频并上传到账户素材库（跨户搬运，v2/file/ad/video/upload） */
  @Post('assets/videos/upload-url')
  assetVideosUpload(@Body() body: { advertiserId: string; url: string; name: string }) {
    return this.assets.uploadVideoFromUrl(
      String(body.advertiserId ?? ''),
      String(body.url ?? ''),
      String(body.name ?? ''),
    );
  }

  /** 账户绑定的应用（应用安装/活跃用） */
  @Get('assets/apps')
  assetApps(@Query('advertiserId') advertiserId: string, @Query('force') force?: string) {
    return this.assets.listApps(String(advertiserId ?? ''), force === '1');
  }

  /** 账户的建站落地页（销售线索-建站用） */
  @Get('assets/lp-pages')
  assetLpPages(@Query('advertiserId') advertiserId: string, @Query('force') force?: string) {
    return this.assets.listLpPages(String(advertiserId ?? ''), force === '1');
  }

  /** 账户已授权的原生快手号（原生广告投放「选择快手号」用，force=1 绕过缓存） */
  @Get('assets/native-users')
  assetNativeUsers(@Query('advertiserId') advertiserId: string, @Query('force') force?: string) {
    return this.assets.listNativeUsers(String(advertiserId ?? ''), force === '1');
  }

  /** 地域定向树（定向抽屉「地域」多选用，按账户 token 拉取，结果全局缓存 24h） */
  @Get('assets/regions')
  assetRegions(@Query('advertiserId') advertiserId: string, @Query('force') force?: string) {
    return this.assets.listRegions(String(advertiserId ?? ''), force === '1');
  }

  /** 账户已生效的人群包（定向抽屉「人群包定向/排除」用） */
  @Get('assets/populations')
  assetPopulations(@Query('advertiserId') advertiserId: string, @Query('force') force?: string) {
    return this.assets.listPopulations(String(advertiserId ?? ''), force === '1');
  }

  /** 创意分类树（创意抽屉「创意分类」下拉用，叶子类目才可选中） */
  @Get('assets/creative-categories')
  assetCreativeCategories(
    @Query('advertiserId') advertiserId: string,
    @Query('force') force?: string,
  ) {
    return this.assets.listCreativeCategories(String(advertiserId ?? ''), force === '1');
  }

  /* ---------------- 定向包 ---------------- */

  /** 定向包列表（对齐创量：先建包、上计划时选择） */
  @Get('target-packages')
  listPackages() {
    return this.packages.list();
  }

  @Post('target-packages')
  createPackage(
    @Body('name') name: string,
    @Body('note') note: string,
    @Body('targeting') targeting: Record<string, unknown>,
  ) {
    return this.packages.create(name, note ?? null, targeting);
  }

  @Put('target-packages/:id')
  updatePackage(
    @Param('id', ParseIntPipe) id: number,
    @Body('name') name: string,
    @Body('note') note: string,
    @Body('targeting') targeting: Record<string, unknown>,
  ) {
    return this.packages.update(id, name, note ?? null, targeting);
  }

  @Delete('target-packages/:id')
  async removePackage(@Param('id', ParseIntPipe) id: number) {
    await this.packages.remove(id);
    return { ok: true };
  }

  /* ---------------- 文案包 ---------------- */

  /** 文案包列表（可复用的文案批次资产） */
  @Get('copy-packages')
  listCopyPackages() {
    return this.packages.listCopies();
  }

  @Post('copy-packages')
  createCopyPackage(
    @Body('name') name: string,
    @Body('note') note: string,
    @Body('titles') titles: string[],
  ) {
    return this.packages.createCopy(name, note ?? null, titles ?? []);
  }

  @Put('copy-packages/:id')
  updateCopyPackage(
    @Param('id', ParseIntPipe) id: number,
    @Body('name') name: string,
    @Body('note') note: string,
    @Body('titles') titles: string[],
  ) {
    return this.packages.updateCopy(id, name, note ?? null, titles ?? []);
  }

  @Delete('copy-packages/:id')
  async removeCopyPackage(@Param('id', ParseIntPipe) id: number) {
    await this.packages.removeCopy(id);
    return { ok: true };
  }

  /* ---------------- 监测链接包 ---------------- */

  /** 监测链接包列表（命名的第三方监测链接资产，多账户创编可复用） */
  @Get('monitor-packages')
  listMonitorPackages() {
    return this.packages.listMonitors();
  }

  @Post('monitor-packages')
  createMonitorPackage(
    @Body('name') name: string,
    @Body('note') note: string,
    @Body('clickUrl') clickUrl: string,
    @Body('impressionUrl') impressionUrl: string,
  ) {
    return this.packages.createMonitor(name, note ?? null, clickUrl ?? '', impressionUrl ?? '');
  }

  @Put('monitor-packages/:id')
  updateMonitorPackage(
    @Param('id', ParseIntPipe) id: number,
    @Body('name') name: string,
    @Body('note') note: string,
    @Body('clickUrl') clickUrl: string,
    @Body('impressionUrl') impressionUrl: string,
  ) {
    return this.packages.updateMonitor(id, name, note ?? null, clickUrl ?? '', impressionUrl ?? '');
  }

  @Delete('monitor-packages/:id')
  async removeMonitorPackage(@Param('id', ParseIntPipe) id: number) {
    await this.packages.removeMonitor(id);
    return { ok: true };
  }

  /* ---------------- 草稿（策略组） ---------------- */

  @Get('drafts')
  listDrafts() {
    return this.drafts.list();
  }

  @Get('drafts/:id')
  getDraft(@Param('id', ParseIntPipe) id: number) {
    return this.drafts.get(id);
  }

  @Post('drafts')
  createDraft(
    @Body('name') name: string,
    @Body('campaignType') campaignType: number,
    @Body('rows') rows: PlanRow[],
    @Body('formJson') formJson: string | null,
  ) {
    return this.drafts.save({
      name: name?.trim() || '未命名草稿',
      campaignType: Number(campaignType) || 2,
      rows: rows ?? [],
      formJson: typeof formJson === 'string' ? formJson : null,
    });
  }

  @Put('drafts/:id')
  updateDraft(
    @Param('id', ParseIntPipe) id: number,
    @Body('name') name: string,
    @Body('campaignType') campaignType: number,
    @Body('rows') rows: PlanRow[],
    @Body('formJson') formJson: string | null,
  ) {
    return this.drafts.save({
      id,
      name: name?.trim() || '未命名草稿',
      campaignType: Number(campaignType) || 2,
      rows: rows ?? [],
      formJson: typeof formJson === 'string' ? formJson : null,
    });
  }

  @Delete('drafts/:id')
  async removeDraft(@Param('id', ParseIntPipe) id: number) {
    await this.drafts.remove(id);
    return { ok: true };
  }

  /* ---------------- 校验 ---------------- */

  @Post('validate')
  validate(@Body('rows') rows: PlanRow[]) {
    return this.drafts.validate(rows ?? []);
  }

  /* ---------------- 任务 ---------------- */

  @Get('tasks')
  listTasks() {
    return this.tasks.listTasks();
  }

  @Get('tasks/:id')
  getTask(@Param('id', ParseIntPipe) id: number) {
    return this.tasks.getTask(id);
  }

  @Post('tasks')
  createTask(
    @Body('name') name: string,
    @Body('rows') rows: PlanRow[],
    @Body('dryRun') dryRun: boolean,
    @Body('draftId') draftId?: number,
    @Body('initialStatus') initialStatus?: InitialStatus,
  ) {
    return this.tasks.createTask({
      name,
      rows: rows ?? [],
      dryRun: Boolean(dryRun),
      draftId: draftId ? Number(draftId) : undefined,
      initialStatus,
    });
  }

  @Post('tasks/:id/pause')
  async pause(@Param('id', ParseIntPipe) id: number) {
    await this.tasks.requestPause(id);
    return this.tasks.getTask(id);
  }

  @Post('tasks/:id/resume')
  resume(@Param('id', ParseIntPipe) id: number) {
    return this.tasks.resume(id);
  }

  @Post('tasks/:id/retry-failed')
  retryFailed(@Param('id', ParseIntPipe) id: number) {
    return this.tasks.retryFailed(id);
  }

  @Post('tasks/:id/cancel')
  async cancel(@Param('id', ParseIntPipe) id: number) {
    await this.tasks.cancel(id);
    return this.tasks.getTask(id);
  }

  @Post('tasks/:id/verify')
  verify(@Param('id', ParseIntPipe) id: number) {
    return this.tasks.verifyTask(id);
  }

  /** 任务行快照来源：复制任务时跳转上计划页回填表单（只读，不发起提交） */
  @Get('tasks/:id/source')
  getTaskSource(@Param('id', ParseIntPipe) id: number) {
    return this.tasks.getTaskSource(id);
  }

  /** 复制历史任务：用创建时的行快照重新发起一个新任务（默认暂停，不自动执行旧任务的行为） */
  @Post('tasks/:id/duplicate')
  duplicate(@Param('id', ParseIntPipe) id: number) {
    return this.tasks.duplicateTask(id);
  }

  /** 删除历史任务：仅隐藏显示（平台实体不受影响） */
  @Delete('tasks/:id')
  async removeTask(@Param('id', ParseIntPipe) id: number) {
    await this.tasks.hideTask(id);
    return { ok: true };
  }
}
