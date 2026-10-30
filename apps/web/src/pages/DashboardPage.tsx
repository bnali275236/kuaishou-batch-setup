import { QuestionCircleOutlined, ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, DatePicker, Empty, Segmented, Select, Space, Table, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { Dayjs } from 'dayjs';
import ReactECharts from 'echarts-for-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, explainError } from '../api/client';
import type { AccountSummary } from '@wkbd/shared';
import { useBoardTable } from '../components/BoardTable';
import { quickPresets } from '../components/QuickRanges';
import { AccountDrawer } from './dashboard/AccountDrawer';

interface OverviewTotals {
  charge: number;
  show: number;
  photoClick: number;
  bclick: number;
  photoClickRatio: number;
  actionRatio: number;
  impression1kCost: number;
  photoClickCost: number;
  actionCost: number;
  conversionNum: number;
  conversionRatio: number;
  activation: number;
  activationCost: number;
  registerCount: number;
  registerCost: number;
  payCount: number;
  payCost: number;
  payFirstDayCount: number;
  payFirstDayCost: number;
}

interface OverviewAccountRow {
  advertiserId: string;
  accountName: string | null;
  charge: number;
  show: number;
  impression1kCost: number;
  photoClickRatio: number;
  actionRatio: number;
  conversionRatio: number;
  activation: number;
  activationCost: number;
  registerCount: number;
  registerCost: number;
  payCount: number;
  payCost: number;
  payFirstDayCount: number;
  payFirstDayCost: number;
  /** 本地缺失的历史天数（超出平台窗口且工作台没运行过的日期） */
  missingDays?: number;
  error?: string;
}

/** 走势行：hour 有了是小时行、date 有了是日行；label 由调用方给（HH:00 / MM-DD） */
interface TrendRow {
  hour?: number;
  /** 日行的日期（yyyy-MM-dd）；小时行无 */
  statDate?: string;
  charge: number;
  show: number;
  photoClick?: number;
  bclick: number;
  conversionNum: number;
  activation: number;
  registerCount: number;
  payCount: number;
  payFirstDayCount: number;
  photoClickCost?: number;
}

interface OverviewResult {
  totals: OverviewTotals;
  accounts: OverviewAccountRow[];
  /** 多账户按天聚合的原始计数（多天区间走势图数据源） */
  daily: Array<{
    statDate: string;
    charge: number;
    show: number;
    bclick: number;
    conversionNum: number;
    activation: number;
    registerCount: number;
    payCount: number;
    payFirstDayCount: number;
  }>;
  fetchedAt: string;
  range: { startDate: string; endDate: string; granularity: 'DAILY' | 'HOURLY' };
}

interface ReportMeta {
  realtimeLookbackDays: number;
  /** 本地历史最早/最新日期（历史数据已永久留存，日期选择器以此为准） */
  earliestDate: string | null;
  latestDate: string | null;
  storedDays: number;
  /** 6 个月历史异步回补进度 */
  backfill?: {
    targetDays: number;
    targetStartDate: string;
    done: number;
    total: number;
    quotaUsed: number;
    quotaLimit: number;
  };
  note: string;
}

const fmtMoney = (n: number) => n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtInt = (n: number) => Math.round(n).toLocaleString('zh-CN');
const fmtPct = (n: number) => `${(n * 100).toFixed(2)}%`;

/* ------------------------------------------------------------------
 * 分时趋势可选指标（与上方核心指标同一套口径）
 * 官方字段字典核实（2026-09，广告主数据文档）：
 *   show        = 封面曝光数
 *   aclick      = 素材曝光数（恒等于播放数）
 *   photo_click = 封面点击数
 *   bclick      = 行为数（快手把「点击」称为行为数）
 *   action_ratio(行为率) = bclick / aclick
 *   impression_1k_cost   = 平均千次【封面】曝光花费
 * 本工作台的「展示数 / 千展 / 点击率」统一走**素材曝光数 aclick** 口径：
 * 展示数=aclick、千展=消耗÷aclick×1000、点击率=bclick÷aclick，
 * 三列可互相验算，也与素材看板保持一致。
 * ------------------------------------------------------------------ */
type TrendMetricKey =
  | 'charge'
  | 'impression1kCost'
  | 'actionRatio'
  | 'conversionRatio'
  | 'activation'
  | 'activationCost'
  | 'registerCount'
  | 'registerCost'
  | 'payCount'
  | 'payCost'
  | 'payFirstDayCount'
  | 'payFirstDayCost';

const TREND_METRICS: Array<{ key: TrendMetricKey; label: string; value: (r: TrendRow) => number }> = [
  { key: 'charge', label: '消耗(元)', value: (r) => r.charge },
  { key: 'impression1kCost', label: '千展(元)', value: (r) => (r.show > 0 ? r.charge / r.show * 1000 : 0) },
  { key: 'actionRatio', label: '点击率', value: (r) => (r.show > 0 ? r.bclick / r.show : 0) },
  { key: 'conversionRatio', label: '转化率', value: (r) => (r.bclick > 0 ? r.conversionNum / r.bclick : 0) },
  { key: 'activation', label: '激活数', value: (r) => r.activation },
  { key: 'activationCost', label: '激活成本(元)', value: (r) => (r.activation > 0 ? r.charge / r.activation : 0) },
  { key: 'registerCount', label: '注册数', value: (r) => r.registerCount },
  { key: 'registerCost', label: '注册成本(元)', value: (r) => (r.registerCount > 0 ? r.charge / r.registerCount : 0) },
  { key: 'payCount', label: '付费次数', value: (r) => r.payCount },
  { key: 'payCost', label: '付费成本(元)', value: (r) => (r.payCount > 0 ? r.charge / r.payCount : 0) },
  { key: 'payFirstDayCount', label: '首日付费次数', value: (r) => r.payFirstDayCount },
  { key: 'payFirstDayCost', label: '首日付费成本(元)', value: (r) => (r.payFirstDayCount > 0 ? r.charge / r.payFirstDayCount : 0) },
];
const trendMetricOf = (key: TrendMetricKey) => TREND_METRICS.find((m) => m.key === key) ?? TREND_METRICS[0];

/* ------------------------------------------------------------------
 * 本地缓存：切走再切回、切历史日期都直接展示上次数据；
 * 「拉取数据」按钮才强制重新请求，新参数没有缓存时自动拉一次
 * ------------------------------------------------------------------ */
const CACHE_KEY = 'wkbd_dash_cache_v1';

interface CacheEntry {
  result: OverviewResult;
  trend: TrendRow[] | null;
  savedAt: string;
}

type CacheMap = Record<string, CacheEntry>;

function readCache(): CacheMap {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as CacheMap) : {};
  } catch {
    return {};
  }
}

function writeCache(key: string, entry: CacheEntry): void {
  try {
    const map = readCache();
    map[key] = entry;
    // 只保留最近 60 份，防止无限膨胀
    const keys = Object.keys(map);
    if (keys.length > 60) {
      for (const k of keys.slice(0, keys.length - 60)) delete map[k];
    }
    localStorage.setItem(CACHE_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

export default function DashboardPage() {
  const { modal } = App.useApp();

  const { data: meta, reload: metaReload } = useQuerySilent<ReportMeta>('/api/report/meta');
  const { data: accounts } = useQuerySilent<AccountSummary[]>('/api/oauth/accounts');

  // 账户本身启用、且所属授权凭证未失效，才算可用
  const usable = useMemo(
    () =>
      (accounts ?? []).filter(
        (a) => a.status === 'ACTIVE' && (a.grantStatus === 'ACTIVE' || a.grantStatus === 'REFRESHING'),
      ),
    [accounts],
  );

  const [selected, setSelected] = useState<string[]>([]);
  const [range, setRange] = useState<[Dayjs, Dayjs]>(() => [dayjs(), dayjs()]);
  const [granularity, setGranularity] = useState<'DAILY' | 'HOURLY'>('DAILY');
  const [autoRefresh, setAutoRefresh] = useState(false);

  const [result, setResult] = useState<OverviewResult | null>(null);
  const [trend, setTrend] = useState<TrendRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  /** 下钻抽屉：非空 = 正在查看该账户的 计划/组/创意 层级 */
  const [drill, setDrill] = useState<string | null>(null);

  // 默认全选可用账户
  const effectiveSelection = selected.length > 0 ? selected : usable.map((a) => a.advertiserId);
  const startDate = range[0].format('YYYY-MM-DD');
  const endDate = range[1].format('YYYY-MM-DD');
  const isSingleDay = startDate === endDate;
  // 历史数据已本地永久留存：日期下限看本地库（没积累过就不限），上限只拦未来
  const histMinDate = meta?.earliestDate ? dayjs(meta.earliestDate) : null;

  const paramKey = `${effectiveSelection.join(',')}|${startDate}|${endDate}|${granularity}`;
  const paramKeyRef = useRef(paramKey);
  paramKeyRef.current = paramKey;

  const fetchData = useCallback(
    async (key: string) => {
      // 解析参数
      const [ids, start, end, gran] = [
        key.split('|')[0] ? key.split('|')[0].split(',').filter(Boolean) : [],
        key.split('|')[1],
        key.split('|')[2],
        key.split('|')[3] as 'DAILY' | 'HOURLY',
      ];
      if (ids.length === 0) return;
      setLoading(true);
      try {
        const overview = await api.post<OverviewResult>('/api/report/overview', {
          advertiserIds: ids,
          startDate: start,
          endDate: end,
          granularity: gran,
        });
        let trendRows: TrendRow[] | null = null;
        if (start === end) {
          // 单日：小时走势实时查；多天区间不再请求小时数据 —— 走势图直接用 overview.daily（按天横坐标）
          trendRows = await api
            .post<TrendRow[]>('/api/report/trend', { advertiserIds: ids, date: start })
            .catch(() => null);
        }
        if (paramKeyRef.current !== key) return; // 参数已变，丢弃过期响应
        setResult(overview);
        setTrend(trendRows);
        writeCache(key, {
          result: overview,
          trend: trendRows,
          savedAt: new Date().toISOString(),
        });
      } catch (err) {
        modal.error({ title: '数据拉取失败', content: explainError(err) });
      } finally {
        if (paramKeyRef.current === key) setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // 参数变化：有缓存直接展示；没有缓存自动拉一次（切换历史日期无需手动同步）
  useEffect(() => {
    const cache = readCache()[paramKey];
    if (cache) {
      setResult(cache.result);
      setTrend(cache.trend);
      return;
    }
    setResult(null);
    setTrend(null);
    if (usable.length > 0) void fetchData(paramKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramKey, usable.length]);

  // 自动刷新：每 5 分钟重拉一次并写缓存
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => void fetchData(paramKeyRef.current), 5 * 60_000);
    return () => clearInterval(timer);
  }, [autoRefresh, fetchData]);

  /* ---------------- 图表 ---------------- */

  const [barMetric, setBarMetric] = useState<TrendMetricKey>('charge');
  const [lineMetric, setLineMetric] = useState<TrendMetricKey>('payCount');

  /** 图表数据源：单日 = 小时行（HH:00 横坐标）；多天 = overview.daily（MM-DD 横坐标），始终有图 */
  const chartRows = useMemo<TrendRow[]>(() => {
    if (isSingleDay) return trend ?? [];
    return (result?.daily ?? []).map((d) => ({
      statDate: d.statDate,
      charge: d.charge,
      show: d.show,
      bclick: d.bclick,
      conversionNum: d.conversionNum,
      activation: d.activation,
      registerCount: d.registerCount,
      payCount: d.payCount,
      payFirstDayCount: d.payFirstDayCount,
    }));
  }, [isSingleDay, trend, result]);

  const chartLabels = useMemo(
    () =>
      chartRows.map((r) =>
        r.hour !== undefined ? `${String(r.hour).padStart(2, '0')}:00` : dayjs(r.statDate).format('MM-DD'),
      ),
    [chartRows],
  );

  const trendOption = useMemo(() => {
    if (chartRows.length === 0) return null;
    const bar = trendMetricOf(barMetric);
    const line = trendMetricOf(lineMetric);
    return {
      grid: { left: 56, right: 56, top: 32, bottom: 28 },
      tooltip: { trigger: 'axis' },
      legend: { data: [bar.label, line.label], top: 0, textStyle: { fontSize: 12 } },
      xAxis: {
        type: 'category',
        data: chartLabels,
        axisLabel: { fontSize: 11, color: '#888780' },
        axisLine: { lineStyle: { color: 'rgba(0,0,0,.12)' } },
      },
      yAxis: [
        {
          type: 'value',
          name: bar.label,
          nameTextStyle: { fontSize: 11, color: '#888780' },
          axisLabel: { fontSize: 11, color: '#888780' },
          splitLine: { lineStyle: { color: 'rgba(0,0,0,.06)' } },
        },
        {
          type: 'value',
          name: line.label,
          nameTextStyle: { fontSize: 11, color: '#888780' },
          axisLabel: { fontSize: 11, color: '#888780' },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: bar.label,
          type: 'bar',
          data: chartRows.map(bar.value),
          itemStyle: { color: '#7F77DD', borderRadius: [3, 3, 0, 0] },
          barMaxWidth: 18,
        },
        {
          name: line.label,
          type: 'line',
          yAxisIndex: 1,
          smooth: true,
          data: chartRows.map(line.value),
          itemStyle: { color: '#1D9E75' },
          lineStyle: { width: 2 },
          symbolSize: 5,
        },
      ],
    };
  }, [chartRows, chartLabels, barMetric, lineMetric]);

  const columns: ColumnsType<OverviewAccountRow> = [
    {
      title: '广告账户',
      dataIndex: 'advertiserId',
      render: (v: string, row) => (
        <div>
          <div
            style={{ fontSize: 13, cursor: 'pointer', color: '#534AB7', fontWeight: 500 }}
            title="点击查看该账户的计划/广告组/创意并调整"
            onClick={() => setDrill(row.advertiserId)}
          >
            {row.accountName ?? '未命名账户'}
          </div>
          <div style={{ fontSize: 11, color: '#888780', fontFamily: 'ui-monospace, Consolas, monospace' }}>
            {v}
          </div>
        </div>
      ),
    },
    {
      title: '消耗(元)',
      dataIndex: 'charge',
      align: 'right',
      sorter: (a, b) => a.charge - b.charge,
      defaultSortOrder: 'descend',
      render: (v: number) => fmtMoney(v),
    },
    {
      title: (
        <span>
          千展(元){' '}
          <Tooltip title="消耗 ÷ 展示数 × 1000。展示数取素材曝光数（aclick），与点击率同一分母">
            <QuestionCircleOutlined style={{ fontSize: 11, color: '#B8B5AC', cursor: 'help' }} />
          </Tooltip>
        </span>
      ),
      dataIndex: 'impression1kCost',
      align: 'right',
      sorter: (a, b) => a.impression1kCost - b.impression1kCost,
      render: (v: number) => (v > 0 ? fmtMoney(v) : '—'),
    },
    {
      title: (
        <span>
          点击率{' '}
          <Tooltip title="行为数 ÷ 展示数（素材曝光数 aclick）。快手把「点击」称为行为数；封面点击率是另一个指标（封面点击 ÷ 封面曝光）">
            <QuestionCircleOutlined style={{ fontSize: 11, color: '#B8B5AC', cursor: 'help' }} />
          </Tooltip>
        </span>
      ),
      dataIndex: 'actionRatio',
      align: 'right',
      sorter: (a, b) => a.actionRatio - b.actionRatio,
      render: (v: number) => (v > 0 ? fmtPct(v) : '—'),
    },
    {
      title: '转化率',
      dataIndex: 'conversionRatio',
      align: 'right',
      sorter: (a, b) => a.conversionRatio - b.conversionRatio,
      render: (v: number) => (v > 0 ? fmtPct(v) : '—'),
    },
    {
      title: '激活数',
      dataIndex: 'activation',
      align: 'right',
      sorter: (a, b) => a.activation - b.activation,
      render: (v: number) => (v > 0 ? fmtInt(v) : '—'),
    },
    {
      title: '激活成本(元)',
      dataIndex: 'activationCost',
      align: 'right',
      sorter: (a, b) => a.activationCost - b.activationCost,
      render: (v: number) => (v > 0 ? fmtMoney(v) : '—'),
    },
    {
      title: '注册数',
      dataIndex: 'registerCount',
      align: 'right',
      sorter: (a, b) => a.registerCount - b.registerCount,
      render: (v: number) => (v > 0 ? fmtInt(v) : '—'),
    },
    {
      title: '注册成本(元)',
      dataIndex: 'registerCost',
      align: 'right',
      sorter: (a, b) => a.registerCost - b.registerCost,
      render: (v: number) => (v > 0 ? fmtMoney(v) : '—'),
    },
    {
      title: '付费次数',
      dataIndex: 'payCount',
      align: 'right',
      sorter: (a, b) => a.payCount - b.payCount,
      render: (v: number) => (v > 0 ? fmtInt(v) : '—'),
    },
    {
      title: '付费成本(元)',
      dataIndex: 'payCost',
      align: 'right',
      sorter: (a, b) => a.payCost - b.payCost,
      render: (v: number) => (v > 0 ? fmtMoney(v) : '—'),
    },
    {
      title: '首日付费次数',
      dataIndex: 'payFirstDayCount',
      align: 'right',
      sorter: (a, b) => a.payFirstDayCount - b.payFirstDayCount,
      render: (v: number) => (v > 0 ? fmtInt(v) : '—'),
    },
    {
      title: '首日付费成本(元)',
      dataIndex: 'payFirstDayCost',
      align: 'right',
      sorter: (a, b) => a.payFirstDayCost - b.payFirstDayCost,
      render: (v: number) => (v > 0 ? fmtMoney(v) : '—'),
    },
    {
      title: '状态',
      key: 'state',
      width: 110,
      render: (_, row) =>
        row.error ? (
          <Tooltip title={row.error}>
            <span style={{ color: '#A32D2D', fontSize: 12 }}>拉取失败</span>
          </Tooltip>
        ) : row.missingDays && row.missingDays > 0 ? (
          <Tooltip title={`本地缺少 ${row.missingDays} 天历史数据（超出平台 7 天窗口且工作台当时未运行），该账户合计偏小`}>
            <span style={{ color: '#B27B18', fontSize: 12 }}>缺 {row.missingDays} 天</span>
          </Tooltip>
        ) : (
          <span style={{ color: '#0F6E56', fontSize: 12 }}>正常</span>
        ),
    },
    {
      title: '操作',
      key: 'ops',
      width: 90,
      render: (_, row) => (
        <Button size="small" type="link" style={{ padding: 0, fontSize: 12 }} onClick={() => setDrill(row.advertiserId)}>
          进入账户
        </Button>
      ),
    },
  ];

  /* —— 看板工具条：导出 xlsx / 重置列宽 / 自定义列（列宽可拖拽） —— */
  const board = useBoardTable<OverviewAccountRow>({
    storageKey: 'dashboard-accounts',
    columns,
    exportFileName: `盯盘看板_${startDate}_${endDate}`,
    exportRows: () => (result?.accounts ?? []) as unknown as Array<Record<string, unknown>>,
    exportValueOf: {
      advertiserId: (row) => {
        const r = row as unknown as OverviewAccountRow;
        return r.accountName ? `${r.accountName}（${r.advertiserId}）` : r.advertiserId;
      },
    },
  });

  /** 代投白名单（只读）账户集合：下钻抽屉里隐藏全部调整操作 */
  const readOnlySet = useMemo(
    () => new Set((accounts ?? []).filter((a) => a.readOnly).map((a) => a.advertiserId)),
    [accounts],
  );

  const noAccounts = usable.length === 0;
  const cache = result ? readCache()[paramKey] : undefined;
  // 单日：分时走势有数据才显示；多天：始终显示按天走势（横坐标=日期，不让图表消失）
  const showChart = isSingleDay
    ? trend?.some((r) => r.charge > 0 || r.show > 0) ?? false
    : (result?.daily?.length ?? 0) > 0;

  /* —— 6 个月历史异步回补：进度提示 + 手动加速 —— */
  const [backfilling, setBackfilling] = useState(false);
  const runBackfill = async () => {
    setBackfilling(true);
    try {
      const results = await api.post<Array<{ advertiserId: string; ok: boolean; message?: string; dataDays?: number }>>(
        '/api/report/backfill',
        { limit: 8 },
      );
      const ok = results.filter((r) => r.ok).length;
      const firstFail = results.find((r) => !r.ok);
      if (ok > 0) {
        modal.success({
          title: `历史回补完成 ${ok}/${results.length} 个账户`,
          content: firstFail ? `部分失败：${firstFail.advertiserId} ${firstFail.message ?? ''}` : '到「盯盘看板」选择更早的日期即可查看',
        });
        metaReload();
      } else {
        modal.warning({
          title: '本次没有账户回补成功',
          content: firstFail?.message ?? '可能今日异步任务配额已用完（每日 18 个账户，明天自动继续）',
        });
      }
    } catch (err) {
      modal.error({ title: '回补请求失败', content: explainError(err) });
    } finally {
      setBackfilling(false);
    }
  };
  const bf = meta?.backfill;
  const backfillPending = bf ? bf.done < bf.total : false;

  return (
    <div>
      <div className="page-header">
        <h2>盯盘看板</h2>
        <p>多账户投放数据聚合。展示的是本地缓存数据，「拉取数据」手动更新</p>
      </div>

      {noAccounts && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="还没有可用的授权账户"
          description="请先到「接入设置」完成开发者应用配置与广告账户授权。"
        />
      )}

      <Card size="small" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
          <Select
            mode="multiple"
            allowClear
            style={{ minWidth: 320, maxWidth: 520, flex: '1 1 320px' }}
            placeholder={noAccounts ? '暂无可用账户' : '选择广告账户（默认全部）'}
            value={selected}
            onChange={setSelected}
            disabled={noAccounts}
            maxTagCount="responsive"
            options={usable.map((a) => ({
              value: a.advertiserId,
              label: a.accountName ? `${a.accountName}（${a.advertiserId}）` : a.advertiserId,
            }))}
          />

          <DatePicker.RangePicker
            value={range}
            allowClear={false}
            presets={quickPresets(histMinDate)}
            disabledDate={(d) => d.isAfter(dayjs()) || (histMinDate ? d.isBefore(histMinDate) : false)}
            onChange={(v) => {
              if (v?.[0] && v?.[1]) setRange([v[0], v[1]]);
            }}
          />

          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginLeft: 'auto' }}>
            <Segmented
              value={granularity}
              onChange={(v) => setGranularity(v as 'DAILY' | 'HOURLY')}
              options={[
                { label: '按天', value: 'DAILY' },
                { label: '按小时', value: 'HOURLY' },
              ]}
            />

            <Button
              type="primary"
              icon={<ReloadOutlined />}
              loading={loading}
              disabled={noAccounts}
              onClick={() => void fetchData(paramKey)}
            >
              拉取数据
            </Button>

            <Segmented
              value={autoRefresh ? 'on' : 'off'}
              onChange={(v) => setAutoRefresh(v === 'on')}
              options={[
                { label: '手动刷新', value: 'off' },
                { label: '自动 5 分钟', value: 'on' },
              ]}
            />
          </div>
        </div>

        <div style={{ fontSize: 12, color: '#888780', marginTop: 10 }}>
          {histMinDate ? (
            <>
              历史数据已本地留存（可回溯至 <b>{histMinDate.format('YYYY-MM-DD')}</b>，已积累{' '}
              {meta?.storedDays ?? 0} 天）；今日部分实时查平台。
            </>
          ) : (
            <>历史数据从现在开始本地留存（平台窗口 {meta?.realtimeLookbackDays ?? 7} 天）；今日部分实时查平台。</>
          )}
          {cache && <> 当前为缓存数据（{dayjs(cache.savedAt).format('HH:mm:ss')} 拉取），点「拉取数据」更新。</>}
          {backfillPending && bf && (
            <span style={{ color: '#B27B18', marginLeft: 8 }}>
              ⚡ 6 个月历史回补中：已覆盖 {bf.done}/{bf.total} 个账户（实时接口只开近 7 天，更早历史由异步任务每日补{' '}
              {bf.quotaLimit} 个账户）
              <Button
                size="small"
                type="link"
                icon={<ThunderboltOutlined />}
                loading={backfilling}
                style={{ padding: 0, fontSize: 12 }}
                onClick={() => void runBackfill()}
              >
                立即回补一批
              </Button>
            </span>
          )}
        </div>
      </Card>

      {result && (
        <>
          <div className="metric-grid">
            <MetricCard label="消耗" value={fmtMoney(result.totals.charge)} unit="元" />
            <MetricCard
              label="千展"
              tip="消耗 ÷ 展示数 × 1000。展示数取素材曝光数（aclick），与点击率同一分母"
              value={result.totals.impression1kCost > 0 ? fmtMoney(result.totals.impression1kCost) : '—'}
              unit={result.totals.impression1kCost > 0 ? '元' : undefined}
            />
            <MetricCard
              label="点击率"
              tip="行为数 ÷ 展示数（素材曝光数 aclick）。快手把「点击」称为行为数；封面点击率是另一个指标"
              value={result.totals.actionRatio > 0 ? fmtPct(result.totals.actionRatio) : '—'}
            />
            <MetricCard label="转化率" value={result.totals.conversionRatio > 0 ? fmtPct(result.totals.conversionRatio) : '—'} />
            <MetricCard label="激活数" value={result.totals.activation > 0 ? fmtInt(result.totals.activation) : '—'} />
            <MetricCard label="激活成本" value={result.totals.activationCost > 0 ? fmtMoney(result.totals.activationCost) : '—'} unit={result.totals.activationCost > 0 ? '元' : undefined} />
            <MetricCard label="注册数" value={result.totals.registerCount > 0 ? fmtInt(result.totals.registerCount) : '—'} />
            <MetricCard label="注册成本" value={result.totals.registerCost > 0 ? fmtMoney(result.totals.registerCost) : '—'} unit={result.totals.registerCost > 0 ? '元' : undefined} />
            <MetricCard label="付费次数" value={result.totals.payCount > 0 ? fmtInt(result.totals.payCount) : '—'} />
            <MetricCard label="付费成本" value={result.totals.payCost > 0 ? fmtMoney(result.totals.payCost) : '—'} unit={result.totals.payCost > 0 ? '元' : undefined} />
            <MetricCard label="首日付费次数" value={result.totals.payFirstDayCount > 0 ? fmtInt(result.totals.payFirstDayCount) : '—'} />
            <MetricCard label="首日付费成本" value={result.totals.payFirstDayCost > 0 ? fmtMoney(result.totals.payFirstDayCost) : '—'} unit={result.totals.payFirstDayCost > 0 ? '元' : undefined} />
          </div>

          {showChart && (
            <Card
              size="small"
              title={
                <span>
                  {isSingleDay ? '分时走势' : '按天走势'}
                  <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 'normal', marginLeft: 8 }}>
                    {range[0].format('YYYY-MM-DD')}
                    {isSingleDay ? '' : ` ~ ${range[1].format('YYYY-MM-DD')}`}
                  </Typography.Text>
                </span>
              }
              style={{ marginBottom: 16 }}
              extra={
                <Space size={8}>
                  <Select
                    size="small"
                    style={{ width: 130 }}
                    value={barMetric}
                    onChange={setBarMetric}
                    options={TREND_METRICS.map((m) => ({ value: m.key, label: m.label }))}
                  />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>+</Typography.Text>
                  <Select
                    size="small"
                    style={{ width: 130 }}
                    value={lineMetric}
                    onChange={setLineMetric}
                    options={TREND_METRICS.map((m) => ({ value: m.key, label: m.label }))}
                  />
                </Space>
              }
            >
              <ReactECharts option={trendOption} style={{ height: 340 }} notMerge />
            </Card>
          )}

          <Card
            size="small"
            title={`账户明细（${result.accounts.length} 个）—— 点击「进入账户」查看计划/组/创意并调整`}
            extra={board.toolbar}
          >
            <Table<OverviewAccountRow>
              rowKey="advertiserId"
              size="small"
              columns={board.columns}
              components={board.tableComponents}
              dataSource={result.accounts}
              pagination={false}
              scroll={{ x: 1560 }}
              footer={() => (
                <span style={{ fontSize: 12, color: '#888780' }}>
                  数据获取时间：{dayjs(cache?.savedAt ?? result.fetchedAt).format('YYYY-MM-DD HH:mm:ss')}
                </span>
              )}
            />
          </Card>
        </>
      )}

      {!result && !noAccounts && (
        <Card size="small">
          <Empty description={loading ? '数据加载中…' : '暂无数据，点「拉取数据」开始查看投放情况'} />
        </Card>
      )}

      {drill && (
        <AccountDrawer
          open
          advertiserId={drill}
          accountName={result?.accounts.find((a) => a.advertiserId === drill)?.accountName ?? null}
          readOnly={readOnlySet.has(drill)}
          range={[startDate, endDate]}
          onClose={() => setDrill(null)}
        />
      )}
    </div>
  );
}

function MetricCard(props: { label: string; value: string; unit?: string; tip?: string }) {
  const { label, value, unit, tip } = props;
  return (
    <div className="metric-card">
      <div className="label">
        {label}
        {tip && (
          <Tooltip title={tip}>
            <QuestionCircleOutlined style={{ fontSize: 11, color: '#B8B5AC', marginLeft: 4, cursor: 'help' }} />
          </Tooltip>
        )}
      </div>
      <div className="value">
        {value}
        {unit && <span className="unit">{unit}</span>}
      </div>
    </div>
  );
}

/** 轻量包装：失败静默（accounts/meta 拉不到时页面已有兜底提示）；reload 手动重拉 */
function useQuerySilent<T>(path: string): { data: T | undefined; reload: () => void } {
  const [data, setData] = useState<T | undefined>(undefined);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    api.get<T>(path).then((d) => alive && setData(d)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [path, tick]);
  return { data, reload: () => setTick((t) => t + 1) };
}
