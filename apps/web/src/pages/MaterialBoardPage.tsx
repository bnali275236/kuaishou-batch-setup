import { PlayCircleOutlined, ReloadOutlined, SyncOutlined } from '@ant-design/icons';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Empty,
  Modal,
  Segmented,
  Select,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { Dayjs } from 'dayjs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AccountSummary,
  MaterialAccountRow,
  MaterialBoardResult,
  MaterialMetrics,
  MaterialRow,
  MaterialSyncResult,
} from '@wkbd/shared';
import { api, explainError } from '../api/client';
import { useBoardTable } from '../components/BoardTable';
import { quickPresets } from '../components/QuickRanges';

/**
 * 素材看板 —— 素材维度的数据观察与投放结论输出。
 *
 * 两块数据来源截然不同，界面必须让用户看得懂这个区别：
 *   历史数据 = 读**本地永久库**。平台实时素材报表只开放近 7 天，
 *              工作台每天自动同步并永久累积，所以这里能选任意时间周期、长期回溯；
 *   今日数据 = 平台**实时**值（当天消耗还在涨，必须现拉）。
 *
 * 素材是账户级资产：同一个视频在 N 个账户下各有独立数据，
 * 因此主表按「素材」聚合，展开行给出「该素材在各账户下的明细」。
 */

const fmtMoney = (n: number) =>
  n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtInt = (n: number) => Math.round(n).toLocaleString('zh-CN');
const fmtPct = (n: number) => (n > 0 ? `${(n * 100).toFixed(2)}%` : '—');

/* ------------------------------------------------------------------
 * 上次查询结果缓存：进入页面直接秒开，不再每次都重新聚合加载。
 * 「刷新 / 同步并刷新」按钮才真正重新读库或同步平台 —— 由用户显式触发。
 * ------------------------------------------------------------------ */
const MCACHE_KEY = 'wkbd_material_cache_v1';

interface MaterialCacheEntry {
  key: string;
  data: MaterialBoardResult;
  savedAt: string;
}

interface MaterialCache {
  history?: MaterialCacheEntry;
  today?: MaterialCacheEntry;
}

function readMaterialCache(): MaterialCache {
  try {
    const raw = localStorage.getItem(MCACHE_KEY);
    return raw ? (JSON.parse(raw) as MaterialCache) : {};
  } catch {
    return {};
  }
}

function writeMaterialCache(slot: 'history' | 'today', key: string, data: MaterialBoardResult): void {
  try {
    const c = readMaterialCache();
    c[slot] = { key, data, savedAt: new Date().toISOString() };
    localStorage.setItem(MCACHE_KEY, JSON.stringify(c));
  } catch {
    /* 存储超限就丢弃缓存，功能不受影响 */
  }
}

interface StorageMeta {
  rows: number;
  materialCount: number;
  accountCount: number;
  earliestDate: string | null;
  latestDate: string | null;
  storedDays: number;
  windowDays: number;
}

/** 指标列（主表与展开的账户明细共用同一份定义，保证两处口径不会漂移） */
function metricColumns<T extends MaterialMetrics>(compact = false): ColumnsType<T> {
  const w = compact ? 88 : 92;
  return [
    {
      title: '消耗(元)',
      dataIndex: 'charge',
      align: 'right',
      width: w,
      sorter: (a, b) => a.charge - b.charge,
      defaultSortOrder: 'descend',
      render: (v: number) => <b>{fmtMoney(v)}</b>,
    },
    {
      title: (
        <Tooltip title="展示数 = 素材曝光数（平台 aclick），与播放数同口径。它才是「消耗÷展示数×1000=千展」「点击数÷展示数=点击率」的分母">
          <span>展示数</span>
        </Tooltip>
      ),
      dataIndex: 'show',
      align: 'right',
      width: w,
      sorter: (a, b) => a.show - b.show,
      render: (v: number) => fmtInt(v),
    },
    {
      title: (
        <Tooltip title="千展(元) = 消耗 ÷ 展示数 × 1000">
          <span>千展(元)</span>
        </Tooltip>
      ),
      dataIndex: 'impression1kCost',
      align: 'right',
      width: w,
      sorter: (a, b) => a.impression1kCost - b.impression1kCost,
      render: (v: number) => (v > 0 ? fmtMoney(v) : '—'),
    },
    {
      title: (
        <Tooltip title="点击数 = 平台「行为数」。快手把真正带来转化的点击记为行为数（bclick），封面点击（photo_click）数值远小于它，两者不是一回事">
          <span>点击数</span>
        </Tooltip>
      ),
      dataIndex: 'click',
      align: 'right',
      width: w,
      sorter: (a, b) => a.click - b.click,
      render: (v: number) => fmtInt(v),
    },
    {
      title: (
        <Tooltip title="点击率 = 点击数（行为数 bclick）÷ 展示数（素材曝光 aclick），与平台 action_ratio 一致">
          <span>点击率</span>
        </Tooltip>
      ),
      dataIndex: 'clickRatio',
      align: 'right',
      width: w,
      sorter: (a, b) => a.clickRatio - b.clickRatio,
      render: (v: number) => fmtPct(v),
    },
    {
      title: '激活数',
      dataIndex: 'activation',
      align: 'right',
      width: w,
      sorter: (a, b) => a.activation - b.activation,
      render: (v: number) => (v > 0 ? fmtInt(v) : '—'),
    },
    {
      title: (
        <Tooltip title="激活成本 = 消耗 ÷ 激活数">
          <span>激活成本(元)</span>
        </Tooltip>
      ),
      dataIndex: 'activationCost',
      align: 'right',
      width: w,
      sorter: (a, b) => a.charge / Math.max(a.activation, 1) - b.charge / Math.max(b.activation, 1),
      render: (_v: unknown, row) => (row.activation > 0 ? fmtMoney(row.charge / row.activation) : '—'),
    },
    {
      title: (
        <Tooltip title="激活率 = 激活数 ÷ 点击数">
          <span>激活率</span>
        </Tooltip>
      ),
      dataIndex: 'activationRatio',
      align: 'right',
      width: w,
      sorter: (a, b) => a.activationRatio - b.activationRatio,
      render: (v: number) => fmtPct(v),
    },
    {
      title: '注册数',
      dataIndex: 'registerCount',
      align: 'right',
      width: w,
      sorter: (a, b) => a.registerCount - b.registerCount,
      render: (v: number) => (v > 0 ? fmtInt(v) : '—'),
    },
    {
      title: (
        <Tooltip title="注册成本 = 消耗 ÷ 注册数">
          <span>注册成本(元)</span>
        </Tooltip>
      ),
      dataIndex: 'registerCost',
      align: 'right',
      width: w,
      sorter: (a, b) => a.charge / Math.max(a.registerCount, 1) - b.charge / Math.max(b.registerCount, 1),
      render: (_v: unknown, row) => (row.registerCount > 0 ? fmtMoney(row.charge / row.registerCount) : '—'),
    },
    {
      title: (
        <Tooltip title="注册率 = 注册数 ÷ 点击数">
          <span>注册率</span>
        </Tooltip>
      ),
      dataIndex: 'registerRatio',
      align: 'right',
      width: w,
      sorter: (a, b) => a.registerRatio - b.registerRatio,
      render: (v: number) => fmtPct(v),
    },
    {
      title: '转化数',
      dataIndex: 'conversionNum',
      align: 'right',
      width: w,
      sorter: (a, b) => a.conversionNum - b.conversionNum,
      render: (v: number) => (v > 0 ? fmtInt(v) : '—'),
    },
    {
      title: (
        <Tooltip title="转化成本 = 消耗 ÷ 转化数">
          <span>转化成本(元)</span>
        </Tooltip>
      ),
      dataIndex: 'conversionCost',
      align: 'right',
      width: w,
      sorter: (a, b) => a.charge / Math.max(a.conversionNum, 1) - b.charge / Math.max(b.conversionNum, 1),
      render: (_v: unknown, row) => (row.conversionNum > 0 ? fmtMoney(row.charge / row.conversionNum) : '—'),
    },
    {
      title: (
        <Tooltip title="转化率 = 转化数 ÷ 点击数">
          <span>转化率</span>
        </Tooltip>
      ),
      dataIndex: 'conversionRatio',
      align: 'right',
      width: w,
      sorter: (a, b) => a.conversionRatio - b.conversionRatio,
      render: (v: number) => fmtPct(v),
    },
    {
      title: '3s播放率',
      dataIndex: 'play3sRatio',
      align: 'right',
      width: w,
      sorter: (a, b) => a.play3sRatio - b.play3sRatio,
      render: (v: number) => fmtPct(v),
    },
    {
      title: (
        <Tooltip title="视频完播率（平台 play_end_ratio；多天汇总按播放量加权）">
          <span>完播率</span>
        </Tooltip>
      ),
      dataIndex: 'playEndRatio',
      align: 'right',
      width: w,
      sorter: (a, b) => a.playEndRatio - b.playEndRatio,
      render: (v: number) => fmtPct(v),
    },
  ];
}

/** 素材缩略图：有封面用封面，点击打开视频详情 */
function MaterialThumb({ row, onOpen }: { row: MaterialRow; onOpen: () => void }) {
  const [broken, setBroken] = useState(false);
  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      style={{
        width: 54,
        height: 72,
        borderRadius: 6,
        overflow: 'hidden',
        position: 'relative',
        cursor: 'pointer',
        background: 'rgba(128,128,128,.15)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 'none',
      }}
      title="点击查看视频详情"
    >
      {row.coverUrl && !broken ? (
        <img
          src={row.coverUrl}
          alt=""
          onError={() => setBroken(true)}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : (
        <Typography.Text type="secondary" style={{ fontSize: 10 }}>
          无封面
        </Typography.Text>
      )}
      {row.photoUrl && (
        <PlayCircleOutlined
          style={{
            position: 'absolute',
            bottom: 3,
            right: 3,
            fontSize: 15,
            color: '#fff',
            filter: 'drop-shadow(0 0 2px rgba(0,0,0,.85))',
          }}
        />
      )}
    </div>
  );
}

/** 素材详情弹窗：视频预览 + 关键指标 */
function MaterialPreviewModal({
  row,
  rangeText,
  onClose,
}: {
  row: MaterialRow | null;
  rangeText: string;
  onClose: () => void;
}) {
  return (
    <Modal
      open={Boolean(row)}
      title={row?.materialName ?? '素材详情'}
      onCancel={onClose}
      footer={null}
      width={780}
      destroyOnClose
    >
      {row && (
        <div style={{ display: 'flex', gap: 16 }}>
          <div style={{ width: 260, flex: 'none' }}>
            {row.photoUrl ? (
              <video
                src={row.photoUrl}
                poster={row.coverUrl ?? undefined}
                controls
                style={{ width: '100%', borderRadius: 8, background: '#000' }}
              />
            ) : row.coverUrl ? (
              <img src={row.coverUrl} alt="" style={{ width: '100%', borderRadius: 8 }} />
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  <span style={{ fontSize: 12 }}>
                    平台未返回预览地址
                    <br />
                    （素材可能已从素材库删除，历史数据仍保留）
                  </span>
                }
              />
            )}
            <div style={{ marginTop: 8, fontSize: 12, color: '#888780', wordBreak: 'break-all' }}>
              素材 ID：{row.photoId}
            </div>
          </div>
          <div style={{ flex: 1 }}>
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  时间
                </Typography.Text>
                <div>{row.statDate ?? rangeText}</div>
              </div>
              {row.caption && (
                <div>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    作品广告语
                  </Typography.Text>
                  <div>{row.caption}</div>
                </div>
              )}
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  覆盖账户
                </Typography.Text>
                <div>
                  <Tag color="purple">{row.accountCount} 个账户</Tag>
                </div>
              </div>
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  消耗 / 展示数 / 点击数
                </Typography.Text>
                <div>
                  {fmtMoney(row.charge)} 元 · {fmtInt(row.show)} · {fmtInt(row.click)}
                </div>
              </div>
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  激活 / 注册 / 转化
                </Typography.Text>
                <div>
                  {fmtInt(row.activation)} · {fmtInt(row.registerCount)} · {fmtInt(row.conversionNum)}
                </div>
              </div>
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  点击率 / 激活率 / 注册率 / 转化率
                </Typography.Text>
                <div>
                  {fmtPct(row.clickRatio)} · {fmtPct(row.activationRatio)} · {fmtPct(row.registerRatio)} ·{' '}
                  {fmtPct(row.conversionRatio)}
                </div>
              </div>
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  3s 播放率 / 完播率
                </Typography.Text>
                <div>
                  {fmtPct(row.play3sRatio)} · {fmtPct(row.playEndRatio)}
                </div>
              </div>
            </Space>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** 表格主体（两个 Tab 共用；rowKey 在按日粒度下必须带日期） */
function MaterialTable({
  data,
  onPreview,
  mode,
}: {
  data: MaterialBoardResult;
  onPreview: (row: MaterialRow) => void;
  mode: 'history' | 'today';
}) {
  const columns: ColumnsType<MaterialRow> = [    {
      title: '时间',
      dataIndex: 'statDate',
      width: 118,
      fixed: 'left',
      render: (v: string | null) => v ?? `${data.startDate} ~ ${data.endDate}`,
    },
    {
      title: '素材预览',
      dataIndex: 'photoId',
      width: 76,
      fixed: 'left',
      render: (_v: unknown, row) => <MaterialThumb row={row} onOpen={() => onPreview(row)} />,
    },
    {
      title: '素材名称',
      dataIndex: 'materialName',
      width: 230,
      fixed: 'left',
      render: (v: string | null, row) => (
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={v ?? undefined}
          >
            {v ?? <span style={{ color: '#888780' }}>未获取到名称</span>}
          </div>
          <div
            style={{
              fontSize: 11,
              color: '#888780',
              fontFamily: 'ui-monospace, Consolas, monospace',
            }}
          >
            {row.photoId}
          </div>
        </div>
      ),
    },
    ...metricColumns<MaterialRow>(),
  ];

  const accountColumns: ColumnsType<MaterialAccountRow> = [
    {
      title: '账户',
      dataIndex: 'advertiserId',
      width: 210,
      fixed: 'left',
      render: (v: string, row) => (
        <div>
          <div style={{ fontSize: 13 }}>{row.accountName ?? '未命名账户'}</div>
          <div
            style={{
              fontSize: 11,
              color: '#888780',
              fontFamily: 'ui-monospace, Consolas, monospace',
            }}
          >
            {v}
          </div>
        </div>
      ),
    },
    ...metricColumns<MaterialAccountRow>(true),
  ];

  /* —— 看板工具条：导出 xlsx / 重置列宽 / 自定义列（列宽可拖拽） —— */
  const board = useBoardTable<MaterialRow>({
    storageKey: 'material-board',
    columns,
    exportFileName: `素材看板_${data.startDate}_${data.endDate}`,
    exportRows: () => data.rows as unknown as Array<Record<string, unknown>>,
    exportValueOf: {
      statDate: (row) => (row as unknown as MaterialRow).statDate ?? `${data.startDate}~${data.endDate}`,
      // 成本列是前端现算的（消耗÷对应数），导出时同样现算
      activationCost: (row) => {
        const r = row as unknown as MaterialRow;
        return r.activation > 0 ? Math.round((r.charge / r.activation) * 100) / 100 : '';
      },
      registerCost: (row) => {
        const r = row as unknown as MaterialRow;
        return r.registerCount > 0 ? Math.round((r.charge / r.registerCount) * 100) / 100 : '';
      },
      conversionCost: (row) => {
        const r = row as unknown as MaterialRow;
        return r.conversionNum > 0 ? Math.round((r.charge / r.conversionNum) * 100) / 100 : '';
      },
    },
  });

  return (
    <Card
      size="small"
      title={`素材明细（${data.rows.length} 个）`}
      extra={board.toolbar}
    >
      <Table<MaterialRow>
        rowKey={(r) => (r.statDate ? `${r.statDate}|${r.photoId}` : r.photoId)}
        size="small"
        columns={board.columns}
        components={board.tableComponents}
        dataSource={data.rows}
        pagination={{
          pageSize: 20,
          showSizeChanger: true,
          pageSizeOptions: [20, 50, 100],
          showTotal: (t) => `共 ${t} 条`,
        }}
        scroll={{ x: 2060 }}
        expandable={{
          expandedRowRender: (row) => (
            <Table<MaterialAccountRow>
              rowKey="advertiserId"
              size="small"
              columns={accountColumns}
              dataSource={row.accounts}
              pagination={false}
              scroll={{ x: 1700 }}
            />
          ),
          rowExpandable: (row) => row.accounts.length > 0,
        }}
        footer={() => (
          <span style={{ fontSize: 12, color: '#888780' }}>
            数据时间：{dayjs(data.fetchedAt).format('YYYY-MM-DD HH:mm:ss')}
            {mode === 'history' ? '（本地留存数据，可长期回溯）' : '（平台实时）'}
          </span>
        )}
      />
    </Card>
  );
}

export default function MaterialBoardPage() {
  const { modal, message } = App.useApp();

  const { data: accounts } = useQuery<AccountSummary[]>({
    queryKey: ['material-accounts'],
    queryFn: () => api.get<AccountSummary[]>('/api/oauth/accounts'),
  });

  const { data: storage, refetch: refetchStorage } = useQuery<StorageMeta>({
    queryKey: ['material-meta'],
    queryFn: () => api.get<StorageMeta>('/api/material/meta'),
  });

  const usable = useMemo(
    () =>
      (accounts ?? []).filter(
        (a) =>
          a.status === 'ACTIVE' && (a.grantStatus === 'ACTIVE' || a.grantStatus === 'REFRESHING'),
      ),
    [accounts],
  );

  const [tab, setTab] = useState<'history' | 'today'>('history');
  const [selected, setSelected] = useState<string[]>([]);
  const [range, setRange] = useState<[Dayjs, Dayjs]>(() => [dayjs().subtract(6, 'day'), dayjs()]);
  const [granularity, setGranularity] = useState<'TOTAL' | 'DAILY'>('TOTAL');
  const [history, setHistory] = useState<MaterialBoardResult | null>(null);
  const [today, setToday] = useState<MaterialBoardResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<MaterialRow | null>(null);
  /** 历史数据当前缓存对应的查询条件；与当前条件不一致时提示刷新 */
  const [historyCacheKey, setHistoryCacheKey] = useState<string | null>(null);
  const bootedRef = useRef(false);

  const accountOptions = useMemo(
    () =>
      usable.map((a) => ({
        value: a.advertiserId,
        label: a.accountName ? `${a.accountName}（${a.advertiserId}）` : a.advertiserId,
      })),
    [usable],
  );

  const historyKey = `${selected.join(',')}|${range[0].format('YYYY-MM-DD')}|${range[1].format(
    'YYYY-MM-DD',
  )}|${granularity}`;
  const todayKey = selected.join(',');

  const loadHistory = useCallback(
    async (syncFirst = false) => {
      setLoading(true);
      try {
        const r = await api.post<MaterialBoardResult>('/api/material/history', {
          advertiserIds: selected,
          startDate: range[0].format('YYYY-MM-DD'),
          endDate: range[1].format('YYYY-MM-DD'),
          granularity,
          syncFirst,
        });
        setHistory(r);
        setHistoryCacheKey(
          `${selected.join(',')}|${range[0].format('YYYY-MM-DD')}|${range[1].format('YYYY-MM-DD')}|${granularity}`,
        );
        writeMaterialCache('history', historyKey, r);
        if (syncFirst) {
          void refetchStorage();
          message.success('已同步平台最新数据并刷新');
        }
      } catch (err) {
        modal.error({ title: '历史数据读取失败', content: explainError(err) });
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected, range, granularity],
  );

  const loadToday = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.post<MaterialBoardResult>('/api/material/today', {
        advertiserIds: selected,
      });
      setToday(r);
      writeMaterialCache('today', todayKey, r);
    } catch (err) {
      modal.error({ title: '今日实时数据获取失败', content: explainError(err) });
    } finally {
      setLoading(false);
    }
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  // 进入页面：有缓存直接秒开，不自动加载；没有缓存（首次使用）才读一次本地库
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    const c = readMaterialCache();
    if (c.history?.data) {
      setHistory(c.history.data);
      setHistoryCacheKey(c.history.key);
    } else {
      void loadHistory(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const syncMutation = useMutation({
    mutationFn: () =>
      api.post<MaterialSyncResult>('/api/material/sync', {
        advertiserIds: selected,
        startDate: dayjs().subtract(6, 'day').format('YYYY-MM-DD'),
        endDate: dayjs().format('YYYY-MM-DD'),
      }),
    onSuccess: (r) => {
      if (r.failures.length > 0) {
        modal.warning({
          title: `同步完成（写入 ${r.rows} 行），${r.failures.length} 个账户失败`,
          content: r.failures
            .slice(0, 8)
            .map((f) => `${f.advertiserId}：${f.message}`)
            .join('\n'),
        });
      } else {
        message.success(`同步完成：${r.accounts} 个账户，写入 ${r.rows} 行`);
      }
      void refetchStorage();
      void loadHistory(false);
    },
    onError: (err) => modal.error({ title: '同步失败', content: explainError(err) }),
  });

  const active = tab === 'today' ? today : history;

  const summary = (
    <>
      {active && active.failures.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={`${active.failures.length} 个账户数据拉取失败（其余账户数据正常展示）`}
          description={active.failures
            .slice(0, 6)
            .map((f) => `${f.advertiserId}：${f.message}`)
            .join('；')}
        />
      )}

      {active && (
        <div className="metric-grid">
          <div className="metric-card">
            <div className="label">素材数</div>
            <div className="value">
              {active.rows.length}
              <span className="unit">个</span>
            </div>
          </div>
          <div className="metric-card">
            <div className="label">总消耗</div>
            <div className="value">
              {fmtMoney(active.totals.charge)}
              <span className="unit">元</span>
            </div>
          </div>
          <div className="metric-card">
            <div className="label">总展示</div>
            <div className="value">{fmtInt(active.totals.show)}</div>
          </div>
          <div className="metric-card">
            <div className="label">总点击</div>
            <div className="value">{fmtInt(active.totals.click)}</div>
          </div>
          <div className="metric-card">
            <div className="label">总激活</div>
            <div className="value">{fmtInt(active.totals.activation)}</div>
          </div>
          <div className="metric-card">
            <div className="label">平均点击率</div>
            <div className="value">{fmtPct(active.totals.clickRatio)}</div>
          </div>
        </div>
      )}
    </>
  );

  const panel = (data: MaterialBoardResult | null, mode: 'history' | 'today') => {
    if (loading && !data) {
      return (
        <Card size="small">
          <div style={{ textAlign: 'center', padding: 40 }}>
            <Spin />
          </div>
        </Card>
      );
    }
    if (!data) {
      return (
        <Card size="small">
          <Empty description={mode === 'today' ? '正在获取今日实时数据…' : '暂无数据'} />
        </Card>
      );
    }
    if (data.rows.length === 0) {
      return (
        <Card size="small">
          <Empty
            description={
              mode === 'history'
                ? '该区间本地没有素材数据。区间在近 7 天内时点「同步并刷新」直接从平台拉取；更早的历史需要工作台持续运行积累。'
                : '今日还没有素材投放数据'
            }
          />
        </Card>
      );
    }
    return <MaterialTable data={data} mode={mode} onPreview={setPreview} />;
  };

  const rangeText = `${range[0].format('YYYY-MM-DD')} ~ ${range[1].format('YYYY-MM-DD')}`;

  return (
    <div>
      <div className="page-header">
        <h2>素材看板</h2>
        <p>
          覆盖全部账户的全部素材。历史数据取自本地永久库 —— 平台实时报表只开放近 7 天，
          工作台每天自动同步并永久保留，因此可长期回溯与分析；今日数据为平台实时值。
          点素材行可展开查看该素材在各账户下的明细。
        </p>
      </div>

      <Card size="small" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
          <Select
            mode="multiple"
            allowClear
            style={{ minWidth: 300, maxWidth: 520, flex: '1 1 300px' }}
            placeholder={usable.length === 0 ? '暂无可用账户' : '全部账户（默认）'}
            value={selected}
            onChange={setSelected}
            maxTagCount="responsive"
            options={accountOptions}
            disabled={usable.length === 0}
          />
          {tab === 'history' && (
            <DatePicker.RangePicker
              value={range}
              allowClear={false}
              presets={quickPresets(storage?.earliestDate ? dayjs(storage.earliestDate) : null)}
              disabledDate={(d) => d.isAfter(dayjs())}
              onChange={(v) => {
                if (v?.[0] && v?.[1]) setRange([v[0], v[1]]);
              }}
            />
          )}

          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginLeft: 'auto' }}>
            {tab === 'history' && (
              <>
                <Segmented
                  value={granularity}
                  onChange={(v) => setGranularity(v as 'TOTAL' | 'DAILY')}
                  options={[
                    { value: 'TOTAL', label: '区间汇总' },
                    { value: 'DAILY', label: '按日展开' },
                  ]}
                />
                <Button
                  type="primary"
                  icon={<SyncOutlined />}
                  loading={loading}
                  onClick={() => void loadHistory(true)}
                >
                  同步并刷新
                </Button>
                <Button
                  icon={<SyncOutlined />}
                  loading={syncMutation.isPending}
                  onClick={() => syncMutation.mutate()}
                >
                  补历史（近 7 天）
                </Button>
              </>
            )}
            <Button
              icon={<ReloadOutlined />}
              loading={loading}
              onClick={() => (tab === 'history' ? void loadHistory(false) : void loadToday())}
            >
              刷新
            </Button>
          </div>
        </div>
        <div style={{ marginTop: 8, fontSize: 12, color: '#888780' }}>
          {storage ? (
            <>
              本地已留存 <b>{storage.materialCount}</b> 个素材 / {storage.rows} 行日报，覆盖{' '}
              {storage.accountCount} 个账户
              {storage.earliestDate
                ? `，可回溯至 ${storage.earliestDate}（已积累 ${storage.storedDays} 天）`
                : '（还没有历史数据，点「补历史（近 7 天）」开始积累）'}
            </>
          ) : (
            '正在读取本地留存情况…'
          )}
          {historyCacheKey !== null && historyCacheKey !== historyKey && (
            <div style={{ color: '#B27B18' }}>
              当前显示的是上次查询结果（与所选筛选条件不同），点「刷新」按新条件重新加载。
            </div>
          )}
        </div>
      </Card>

      {summary}

      <Spin spinning={loading}>
        <Tabs
          activeKey={tab}
          onChange={(k) => {
            const next = k as 'history' | 'today';
            setTab(next);
            if (next === 'today' && !today) void loadToday();
          }}
          items={[
            { key: 'history', label: '历史数据', children: panel(history, 'history') },
            { key: 'today', label: '今日数据（实时）', children: panel(today, 'today') },
          ]}
        />
      </Spin>

      <MaterialPreviewModal row={preview} rangeText={rangeText} onClose={() => setPreview(null)} />
    </div>
  );
}
