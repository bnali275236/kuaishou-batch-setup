/**
 * 平台 ID 序列化工具。
 *
 * 快手的 ID 字段在接口里声明为 Long，但本地一律以 String 存储
 * （避免 BigInt 序列化问题）。发请求时需要还原成数字型 ——
 * 平台对类型敏感，传字符串可能被判为参数非法。
 * 超过 JS 安全整数范围时保持字符串，避免精度丢失。
 */
export function toId(value: string | number): number | string {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : String(value);
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) return trimmed;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : trimmed;
}

export function toIdArray(values: Array<string | number>): Array<number | string> {
  return values.map(toId);
}

/** 请求体里递归把 id 类字段还原为数字 */
const ID_KEYS = new Set([
  'advertiser_id',
  'campaign_id',
  'unit_id',
  'creative_id',
  'photo_id',
  'app_id',
  'site_id',
  'group_id',
  'library_id',
  'convert_id',
  'template_id',
  'series_id',
  'episode_id',
  'live_user_id',
  'jingle_bell_id',
]);

export function normalizeIdsDeep<T>(input: T): T {
  if (Array.isArray(input)) {
    return input.map((v) => normalizeIdsDeep(v)) as unknown as T;
  }
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (ID_KEYS.has(k)) {
        if (Array.isArray(v)) out[k] = toIdArray(v as Array<string | number>);
        else if (v !== undefined && v !== null) out[k] = toId(v as string | number);
        else out[k] = v;
      } else {
        out[k] = normalizeIdsDeep(v);
      }
    }
    return out as unknown as T;
  }
  return input;
}
