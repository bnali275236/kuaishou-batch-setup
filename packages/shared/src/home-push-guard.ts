/**
 * 🚫 红线（2026-09-24 用户明确定下，永久生效）：
 *
 *   本工具**禁止**把素材上传 / 推送到快手主页。
 *
 * 背景：竞品（mobgi）批量创编里有「将视频推送至快手主页」的选项，
 * 会把广告视频同步发布到快手账号的个人主页。这会直接影响账号内容生态，
 * 用户明确要求：不做这个功能、不留任何入口，并且**提交前必须检查**，
 * 任何情况下都不允许触发这条指令。
 *
 * 落地方式（三层防御）：
 *   1. 前端：界面上不存在任何「推送主页」入口（选择素材只从账户广告视频库挑选）。
 *   2. 网关：MapiGateway.call() 是全站唯一出口，调用前跑 `assertNoHomePush`，
 *      命中黑名单直接抛错，请求根本不会发出去。
 *   3. 任务引擎：createTask 在落库前对全部请求体再跑一次同样的检查，
 *      让问题在任务创建阶段就报错，而不是跑到一半才失败。
 *
 * ⚠️ 维护须知：新增任何素材相关接口/字段前，先对照本文件；
 *    修改黑名单属于高危变更，必须与用户确认。
 */
export const HOME_PUSH_GUARD = {
  /** 命中任一正则的请求路径 → 直接拒绝（不发请求） */
  pathPatterns: [
    // 快手素材管理分两族：/file/ad/video/*（广告视频，允许）与 /file/video/*（主页视频，禁止）。
    // /file/ad/... 不会匹配 /\/file\/video\//，因为中间隔着 ad/。
    /\/file\/video\//i,
    /\/file\/photo\//i,
    // 任何「推送」语义的接口一律禁止
    /push/i,
  ],
  /** 请求体中出现任一字段名（递归检查，含嵌套对象/数组） → 直接拒绝 */
  payloadKeys: [
    'push_to_home',
    'push_home',
    'home_push',
    'to_home',
    'photo_push',
    'photo_ids_push',
    'push_to_ks_home',
    'push_main_page',
    'main_page_push',
    'sync_to_home',
    'publish_to_home',
  ],
  /** 字段名模糊兜底：防未来新增写法（只看键名，不看值，避免误伤内容文本） */
  keyPattern: /(^|_)(push)[a-z_]*(home|main_page|profile)|(home|profile)[a-z_]*push/i,
  /** 拦截提示语（会原样透出给用户/日志） */
  reason:
    '🚫 红线拦截：本工具禁止把素材上传/推送到快手主页（该调用未发出）。' +
    '如果你是开发者，请检查最近新增的接口路径或请求体字段——主页推送类能力在此项目中永久禁用。',
};

/**
 * 深度扫描请求体：键名命中黑名单（精确表 + 模糊兜底）即违规。
 * 只检查**键名**，不检查字符串值——广告语/素材名里出现「push」「主页」等字样不该被误伤。
 */
export function findHomePushViolation(
  path: string,
  body: unknown,
): string | null {
  for (const re of HOME_PUSH_GUARD.pathPatterns) {
    if (re.test(path)) return `path 命中黑名单：${path}`;
  }
  if (body == null) return null;
  const hit = scanKeys(body, 0);
  return hit ? `请求体字段命中黑名单：${hit}` : null;
}

function scanKeys(node: unknown, depth: number): string | null {
  if (depth > 8) return null; // 防御：够深了还没问题就当没有
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = scanKeys(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      // camelCase 也归一成 snake_case 再比对（如 syncToHome → sync_to_home）
      const lower = key
        .replace(/([A-Z])/g, '_$1')
        .toLowerCase();
      if (
        HOME_PUSH_GUARD.payloadKeys.includes(lower) ||
        HOME_PUSH_GUARD.keyPattern.test(lower)
      ) {
        return key;
      }
      const hit = scanKeys(value, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}
