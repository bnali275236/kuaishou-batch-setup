import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';

/* ------------------------------------------------------------------
 * 盯盘看板「账户明细」的层级展示：账户 / 广告组 / 创意
 *
 * 账户层数据来自 /api/report/overview（一次多账户）。
 * 组/创意层平台只提供单账户接口，所以按账户扇出：
 *   结构（名称/状态/预算/出价）← POST /api/manage/structure
 *   指标（消耗/展示/点击率/转化…）← POST /api/report/level/:level
 * 结构数据 5 分钟内复用（切组/创意视图不重复拉），指标按「层级+账户集+日期」缓存一份。
 * ------------------------------------------------------------------ */

export type DetailLevel = 'account' | 'unit' | 'creative';

interface StructureItem {
  id: string;
  name: string | null;
  putStatus: number;
  putStatusText: string;
  campaignId: string | null;
  unitId: string | null;
  dayBudgetYuan: number;
  bidYuan: number;
  bidType: number | null;
}

interface LevelMetricRow {
  campaignId: string | null;
  unitId: string | null;
  creativeId: string | null;
  charge: number;
  show: number;
  bclick: number;
  conversionNum: number;
  activation: number;
  registerCount: number;
  payCount: number;
  payFirstDayCount: number;
}

/** 组/创意层级的一行（已合并结构 + 指标） */
export interface HierRow {
  advertiserId: string;
  accountName: string | null;
  campaignId: string | null;
  campaignName: string | null;
  unitId: string | null;
  unitName: string | null;
  creativeId: string | null;
  creativeName: string | null;
  putStatus: number;
  putStatusText: string;
  dayBudgetYuan: number;
  bidYuan: number;
  bidType: number | null;
  charge: number;
  show: number;
  bclick: number;
  clickRatio: number;
  conversionNum: number;
  conversionRatio: number;
  activation: number;
  activationCost: number;
  registerCount: number;
  payCount: number;
  payFirstDayCount: number;
  hasMetric: boolean;
}

export interface HierFailure {
  advertiserId: string;
  message: string;
}

export interface HierAccountRef {
  advertiserId: string;
  accountName: string | null;
}

const STRUCT_TTL_MS = 5 * 60_000;
/** 结构缓存（进程级）：账户 × 层级；切「组/创意」视图时不必重复拉同一份列表 */
const structCache = new Map<string, { at: number; items: StructureItem[] }>();

async function structureOf(
  advertiserId: string,
  level: 'campaign' | 'unit' | 'creative',
  force: boolean,
): Promise<{ items: StructureItem[]; error?: string }> {
  const key = `${advertiserId}|${level}`;
  const hit = structCache.get(key);
  if (!force && hit && Date.now() - hit.at < STRUCT_TTL_MS) return { items: hit.items };
  try {
    const items = await api.post<StructureItem[]>('/api/manage/structure', { advertiserId, level });
    const list = Array.isArray(items) ? items : [];
    structCache.set(key, { at: Date.now(), items: list });
    return { items: list };
  } catch (err) {
    return { items: [], error: (err as Error)?.message ?? '结构拉取失败' };
  }
}

/** 多天区间：报表按天返回，这里按实体 ID 汇总计数，比率由汇总计数现算 */
function aggregateMetrics(
  rows: LevelMetricRow[],
  keyOf: (r: LevelMetricRow) => string | null,
): Map<string, LevelMetricRow> {
  const map = new Map<string, LevelMetricRow>();
  for (const r of rows) {
    const key = keyOf(r);
    if (!key) continue;
    const prev = map.get(key);
    if (prev) {
      prev.charge += r.charge;
      prev.show += r.show;
      prev.bclick += r.bclick;
      prev.conversionNum += r.conversionNum;
      prev.activation += r.activation;
      prev.registerCount += r.registerCount;
      prev.payCount += r.payCount;
      prev.payFirstDayCount += r.payFirstDayCount;
    } else {
      map.set(key, { ...r });
    }
  }
  return map;
}

function buildRow(
  base: {
    advertiserId: string;
    accountName: string | null;
    campaignId: string | null;
    campaignName: string | null;
    unitId: string | null;
    unitName: string | null;
    creativeId: string | null;
    creativeName: string | null;
    putStatus: number;
    putStatusText: string;
    dayBudgetYuan: number;
    bidYuan: number;
    bidType: number | null;
  },
  m: LevelMetricRow | undefined,
): HierRow {
  return {
    ...base,
    charge: m?.charge ?? 0,
    show: m?.show ?? 0,
    bclick: m?.bclick ?? 0,
    clickRatio: m && m.show > 0 ? m.bclick / m.show : 0,
    conversionNum: m?.conversionNum ?? 0,
    conversionRatio: m && m.bclick > 0 ? m.conversionNum / m.bclick : 0,
    activation: m?.activation ?? 0,
    activationCost: m && m.activation > 0 ? m.charge / m.activation : 0,
    registerCount: m?.registerCount ?? 0,
    payCount: m?.payCount ?? 0,
    payFirstDayCount: m?.payFirstDayCount ?? 0,
    hasMetric: Boolean(m),
  };
}

async function loadLevel(
  level: 'unit' | 'creative',
  accounts: HierAccountRef[],
  startDate: string,
  endDate: string,
  force: boolean,
  onTick: (done: number, total: number) => void,
  isAlive: () => boolean,
): Promise<{ rows: HierRow[]; failures: HierFailure[] }> {
  const rows: HierRow[] = [];
  const failures: HierFailure[] = [];
  const queue = [...accounts];
  let done = 0;

  const worker = async () => {
    for (;;) {
      const acct = queue.shift();
      if (!acct) return;
      try {
        const [campaigns, units, creatives, report] = await Promise.all([
          structureOf(acct.advertiserId, 'campaign', force),
          structureOf(acct.advertiserId, 'unit', force),
          level === 'creative'
            ? structureOf(acct.advertiserId, 'creative', force)
            : Promise.resolve({ items: [] as StructureItem[], error: undefined as string | undefined }),
          api
            .post<{ rows: LevelMetricRow[] }>(`/api/report/level/${level}`, {
              advertiserId: acct.advertiserId,
              startDate,
              endDate,
              granularity: 'DAILY',
              pageSize: 2000,
            })
            .catch(() => ({ rows: [] as LevelMetricRow[] })),
        ]);

        const err = campaigns.error || units.error || creatives.error;
        if (err) failures.push({ advertiserId: acct.advertiserId, message: err });

        const campName = new Map(campaigns.items.map((c) => [c.id, c.name]));
        if (!isAlive()) return;

        if (level === 'unit') {
          const metricMap = aggregateMetrics(report.rows ?? [], (r) => r.unitId);
          const seen = new Set<string>();
          for (const u of units.items) {
            seen.add(u.id);
            rows.push(
              buildRow(
                {
                  advertiserId: acct.advertiserId,
                  accountName: acct.accountName,
                  campaignId: u.campaignId,
                  campaignName: u.campaignId ? campName.get(u.campaignId) ?? null : null,
                  unitId: u.id,
                  unitName: u.name,
                  creativeId: null,
                  creativeName: null,
                  putStatus: u.putStatus,
                  putStatusText: u.putStatusText,
                  dayBudgetYuan: u.dayBudgetYuan,
                  bidYuan: u.bidYuan,
                  bidType: u.bidType,
                },
                metricMap.get(u.id),
              ),
            );
          }
          // 结构列表没返回但报表有消耗的组（部分账户列表接口不全）：仍然展示，别让钱凭空消失
          for (const [id, m] of metricMap) {
            if (seen.has(id)) continue;
            rows.push(
              buildRow(
                {
                  advertiserId: acct.advertiserId,
                  accountName: acct.accountName,
                  campaignId: m.campaignId,
                  campaignName: m.campaignId ? campName.get(m.campaignId) ?? null : null,
                  unitId: id,
                  unitName: null,
                  creativeId: null,
                  creativeName: null,
                  putStatus: 0,
                  putStatusText: '—',
                  dayBudgetYuan: 0,
                  bidYuan: 0,
                  bidType: null,
                },
                m,
              ),
            );
          }
        } else {
          const unitName = new Map(units.items.map((u) => [u.id, u.name]));
          const unitCampaign = new Map(units.items.map((u) => [u.id, u.campaignId]));
          const metricMap = aggregateMetrics(report.rows ?? [], (r) => r.creativeId);
          const seen = new Set<string>();
          for (const c of creatives.items) {
            seen.add(c.id);
            const campaignId = c.campaignId ?? (c.unitId ? unitCampaign.get(c.unitId) ?? null : null);
            rows.push(
              buildRow(
                {
                  advertiserId: acct.advertiserId,
                  accountName: acct.accountName,
                  campaignId,
                  campaignName: campaignId ? campName.get(campaignId) ?? null : null,
                  unitId: c.unitId,
                  unitName: c.unitId ? unitName.get(c.unitId) ?? null : null,
                  creativeId: c.id,
                  creativeName: c.name,
                  putStatus: c.putStatus,
                  putStatusText: c.putStatusText,
                  dayBudgetYuan: c.dayBudgetYuan,
                  bidYuan: c.bidYuan,
                  bidType: c.bidType,
                },
                metricMap.get(c.id),
              ),
            );
          }
          for (const [id, m] of metricMap) {
            if (seen.has(id)) continue;
            rows.push(
              buildRow(
                {
                  advertiserId: acct.advertiserId,
                  accountName: acct.accountName,
                  campaignId: m.campaignId,
                  campaignName: m.campaignId ? campName.get(m.campaignId) ?? null : null,
                  unitId: m.unitId,
                  unitName: m.unitId ? unitName.get(m.unitId) ?? null : null,
                  creativeId: id,
                  creativeName: null,
                  putStatus: 0,
                  putStatusText: '—',
                  dayBudgetYuan: 0,
                  bidYuan: 0,
                  bidType: null,
                },
                m,
              ),
            );
          }
        }
      } catch (err) {
        failures.push({ advertiserId: acct.advertiserId, message: (err as Error)?.message ?? '未知错误' });
      } finally {
        done += 1;
        onTick(done, accounts.length);
      }
    }
  };

  // 5 路并发：21 个账户大约 10~20 秒；平台限流 1000 QPM，这个量级远低于阈值
  await Promise.all(Array.from({ length: Math.min(5, accounts.length) }, () => worker()));
  return { rows, failures };
}

/* ---------------- 本地缓存（一种层级留一份，避免 localStorage 膨胀） ---------------- */

interface HierCache {
  key: string;
  rows: HierRow[];
  savedAt: string;
  failures: HierFailure[];
}

const cacheStorageKey = (level: 'unit' | 'creative') => `wkbd_hier_cache_${level}`;

function readHierCache(level: 'unit' | 'creative'): HierCache | null {
  try {
    const raw = localStorage.getItem(cacheStorageKey(level));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as HierCache;
    return Array.isArray(parsed.rows) ? parsed : null;
  } catch {
    return null;
  }
}

function writeHierCache(level: 'unit' | 'creative', data: HierCache): void {
  try {
    localStorage.setItem(cacheStorageKey(level), JSON.stringify(data));
  } catch {
    try {
      localStorage.removeItem(cacheStorageKey(level));
    } catch {
      /* ignore */
    }
  }
}

/* ---------------- Hook ---------------- */

export function useHierarchy(params: {
  level: DetailLevel;
  accounts: HierAccountRef[];
  /** 已裁剪到平台 7 天窗口内的日期 */
  startDate: string;
  endDate: string;
}) {
  const { level, startDate, endDate } = params;
  const accountsRef = useRef(params.accounts);
  accountsRef.current = params.accounts;

  const [rows, setRows] = useState<HierRow[]>([]);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [failures, setFailures] = useState<HierFailure[]>([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [tick, setTick] = useState(0);

  const reqRef = useRef(0);
  const forceRef = useRef(false);
  const aliveRef = useRef(true);

  const accountKey = params.accounts.map((a) => a.advertiserId).join(',');
  const cacheKey = `${level}|${accountKey}|${startDate}|${endDate}`;

  useEffect(
    () => () => {
      aliveRef.current = false;
    },
    [],
  );

  useEffect(() => {
    if (level === 'account') return;
    const accounts = accountsRef.current;
    if (accounts.length === 0) return;

    const force = forceRef.current;
    forceRef.current = false;

    if (!force) {
      const cached = readHierCache(level);
      if (cached && cached.key === cacheKey) {
        setRows(cached.rows);
        setSavedAt(cached.savedAt);
        setFailures(cached.failures ?? []);
        setLoading(false);
        return;
      }
    }

    const my = ++reqRef.current;
    aliveRef.current = true;
    setLoading(true);
    setProgress({ done: 0, total: accounts.length });
    void loadLevel(
      level,
      accounts,
      startDate,
      endDate,
      force,
      (done, total) => {
        if (my === reqRef.current) setProgress({ done, total });
      },
      () => my === reqRef.current && aliveRef.current,
    )
      .then((res) => {
        if (my !== reqRef.current) return;
        // 消耗大的排前面，与账户表的习惯一致
        const sorted = [...res.rows].sort((a, b) => b.charge - a.charge);
        const at = new Date().toISOString();
        setRows(sorted);
        setSavedAt(at);
        setFailures(res.failures);
        writeHierCache(level, { key: cacheKey, rows: sorted, savedAt: at, failures: res.failures });
      })
      .finally(() => {
        if (my === reqRef.current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level, cacheKey, tick]);

  /** 手动刷新：跳过缓存，同时重拉结构（预算/状态可能刚被改过） */
  const reload = useCallback(() => {
    forceRef.current = true;
    setTick((v) => v + 1);
  }, []);

  return { rows, savedAt, failures, loading, progress, reload };
}

/** 关键字筛选：账户名/ID、计划名、组名、创意名、各层 ID 任意命中即保留 */
export function hierRowMatches(row: HierRow, kw: string): boolean {
  if (!kw) return true;
  const hay = [
    row.accountName ?? '',
    row.advertiserId,
    row.campaignName ?? '',
    row.campaignId ?? '',
    row.unitName ?? '',
    row.unitId ?? '',
    row.creativeName ?? '',
    row.creativeId ?? '',
  ]
    .join('\u0001')
    .toLowerCase();
  return hay.includes(kw);
}
