/**
 * 平台返回体解析工具。
 *
 * 快手各接口的 data 结构并不统一（details / list / records / data 都出现过），
 * 这里做统一防御式解析，避免每个业务方法各写一遍。
 */

/** 从返回体里取出第一个对象（优先数组的第一项） */
export function firstObject(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;

  for (const key of ['details', 'list', 'records', 'items', 'rows', 'data']) {
    const arr = obj[key];
    if (Array.isArray(arr) && arr.length > 0 && typeof arr[0] === 'object' && arr[0] !== null) {
      return arr[0] as Record<string, unknown>;
    }
  }
  return obj;
}

/** 从返回体里取出列表 */
export function pickArray(data: unknown, extraKeys: string[] = []): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (!data || typeof data !== 'object') return [];

  const obj = data as Record<string, unknown>;
  for (const key of [...extraKeys, 'details', 'list', 'records', 'items', 'rows']) {
    const arr = obj[key];
    if (Array.isArray(arr)) return arr as Record<string, unknown>[];
  }
  return [];
}

/** 取总数（不同接口字段名不同） */
export function pickTotal(data: unknown, fallback: number): number {
  if (!data || typeof data !== 'object') return fallback;
  const obj = data as Record<string, unknown>;
  for (const key of ['total_count', 'totalCount', 'total', 'count']) {
    const v = obj[key];
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  }
  return fallback;
}

/** 安全取数：null/undefined/空串/非数字 一律回落到 default */
export function num(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return fallback;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

export function str(value: unknown, fallback = ''): string {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

/** 分片：把大数组按 size 拆成若干批（平台限制单次查询 ID ≤ 5000） */
export function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
