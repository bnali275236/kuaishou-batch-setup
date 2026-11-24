import {
  CloudUploadOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SearchOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  DatePicker,
  Empty,
  Input,
  Modal,
  Pagination,
  Progress,
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
import { api, explainError, uploadBinary } from '../api/client';
import { useBoardTable } from '../components/BoardTable';
import { quickPresets } from '../components/QuickRanges';
import type { AssetItem } from './plan/pickers';

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

/* ------------------------------------------------------------------
 * 素材库面板：账户素材库管理（浏览 / 本地上传 / 平台同步）。
 * 数据源 = 平台素材库列表（/api/plan/assets/videos），与「素材看板」
 * 的本地日报库是两回事：这里是「现在账户里有什么素材」。
 * ------------------------------------------------------------------ */

const VIDEO_MAX_BYTES = 500 * 1024 * 1024;

/**
 * 从平台原始条目里挑出可用地址。
 * 实测 video/list 的字段：`cover_url` = 封面 jpg，`url` = 视频播放地址（mp4）——
 * 注意不是 photo_url（那个字段在 list 里根本没有，早期取错导致弹窗只显示封面）。
 */
function videoUrlsOf(item: AssetItem): { cover?: string; video?: string } {
  const raw = (item.raw ?? {}) as Record<string, unknown>;
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = raw[k];
      if (typeof v === 'string' && v) return v;
    }
    return undefined;
  };
  const imageLike = (u?: string) => /\.(jpe?g|png|webp|gif)(\?|#|$)/i.test(u ?? '');
  const videoLike = (u?: string) => /\.(mp4|mov|webm|m3u8)(\?|#|$)/i.test(u ?? '');
  const cover =
    pick('cover_url', 'image_url', 'poster_url') ?? (imageLike(item.cover) ? item.cover : undefined);
  const video =
    pick('url', 'photo_url', 'play_url', 'video_url') ??
    (videoLike(item.cover) ? item.cover : undefined);
  return { cover, video };
}

/** 素材库详情弹窗：视频播放 + 基本信息 + 同步主页操作 */
function LibraryPreviewModal({
  item,
  onClose,
  onPush,
  pushing,
}: {
  item: AssetItem | null;
  onClose: () => void;
  onPush?: (item: AssetItem) => void;
  pushing?: boolean;
}) {
  const { cover, video } = item ? videoUrlsOf(item) : { cover: undefined, video: undefined };
  const [videoBroken, setVideoBroken] = useState(false);
  useEffect(() => {
    setVideoBroken(false);
  }, [item?.id]);
  return (
    <Modal
      open={Boolean(item)}
      title={item?.name ?? '素材详情'}
      onCancel={onClose}
      footer={
        item && onPush ? (
          <Button
            type="primary"
            ghost
            loading={pushing}
            onClick={() => onPush(item)}
            title="把该视频推送到账户绑定的快手号主页（平台接口 pushToProfile）"
          >
            推送到快手主页
          </Button>
        ) : null
      }
      width={640}
      destroyOnClose
    >
      {item && (
        <div style={{ display: 'flex', gap: 16 }}>
          <div style={{ width: 240, flex: 'none' }}>
            {video && !videoBroken ? (
              <video
                src={video}
                poster={cover}
                controls
                preload="metadata"
                onError={() => setVideoBroken(true)}
                style={{ width: '100%', borderRadius: 8, background: '#000' }}
              />
            ) : cover ? (
              <div>
                <img src={cover} alt="" style={{ width: '100%', borderRadius: 8 }} />
                {video && (
                  <Typography.Link
                    href={video}
                    target="_blank"
                    rel="noreferrer"
                    style={{ fontSize: 12, display: 'block', marginTop: 6 }}
                  >
                    播放器加载失败，点此在新窗口打开视频
                  </Typography.Link>
                )}
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="平台未返回预览地址" />
            )}
          </div>
          <Space direction="vertical" size={6} style={{ flex: 1 }}>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                素材 ID
              </Typography.Text>
              <div style={{ fontFamily: 'ui-monospace, Consolas, monospace', wordBreak: 'break-all' }}>
                {item.id}
              </div>
            </div>
            {item.uploadTime && (
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  上传时间
                </Typography.Text>
                <div>{item.uploadTime}</div>
              </div>
            )}
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                消耗（今日 / 昨日 / 近 7 天）
              </Typography.Text>
              <div>
                {item.costToday != null || item.costYesterday != null || item.cost7d != null
                  ? `¥${fmtMoney(item.costToday ?? 0)} / ¥${fmtMoney(item.costYesterday ?? 0)} / ¥${fmtMoney(item.cost7d ?? 0)}`
                  : '—'}
              </div>
            </div>
          </Space>
        </div>
      )}
    </Modal>
  );
}

function MaterialLibraryPanel({ accounts }: { accounts: AccountSummary[] }) {
  const { modal, message } = App.useApp();

  /* 账户：单选，上传目标 = 该账户素材库；代投白名单账户禁止上传 */
  const [advertiserId, setAdvertiserId] = useState('');
  useEffect(() => {
    if (!advertiserId && accounts.length > 0) {
      const first = accounts.find((a) => !a.readOnly) ?? accounts[0];
      setAdvertiserId(first.advertiserId);
    }
  }, [accounts, advertiserId]);
  const current = accounts.find((a) => a.advertiserId === advertiserId);
  const writable = Boolean(current && !current.readOnly);

  const listQuery = useQuery<AssetItem[]>({
    queryKey: ['material-library', advertiserId],
    queryFn: () => api.get<AssetItem[]>(`/api/plan/assets/videos?advertiserId=${advertiserId}`),
    enabled: Boolean(advertiserId),
  });

  const [syncing, setSyncing] = useState(false);
  const syncVideos = async () => {
    if (!advertiserId) return;
    setSyncing(true);
    try {
      await api.get<AssetItem[]>(`/api/plan/assets/videos?advertiserId=${advertiserId}&force=1`);
      message.success('已从平台同步最新素材库');
    } catch (err) {
      modal.error({ title: '同步素材失败', content: explainError(err) });
    } finally {
      setSyncing(false);
    }
  };

  /* 本地上传（与创编页「选择素材」弹窗同一接口：裸二进制直传账户素材库） */
  const [uploading, setUploading] = useState(false);
  const [percent, setPercent] = useState(0);
  const [uploadName, setUploadName] = useState('');
  /** 上传后是否同步到账户绑定的快手号主页（shield_backward_switch） */
  const [pushToProfile, setPushToProfile] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    if (!advertiserId) {
      message.warning('请先选择账户，再上传素材');
      return;
    }
    if (file.size > VIDEO_MAX_BYTES) {
      message.error(`文件 ${(file.size / 1024 / 1024).toFixed(1)}MB，超过 500MB 上限`);
      return;
    }
    if (!/\.(mp4|mov|webm)$/i.test(file.name)) {
      message.error('只支持 mp4 / mov / webm 视频文件');
      return;
    }
    setUploading(true);
    setPercent(0);
    setUploadName(file.name);
    try {
      const name = file.name.replace(/\.[^.]+$/, '').slice(0, 50);
      const res = await uploadBinary<{ photoId: string; sizeBytes: number }>(
        `/api/plan/assets/videos/upload?advertiserId=${encodeURIComponent(
          advertiserId,
        )}&name=${encodeURIComponent(name)}&pushToProfile=${pushToProfile ? '1' : '0'}`,
        file,
        { fileName: file.name, onProgress: (p) => setPercent(p.percent) },
      );
      message.success(
        `「${name}」已上传到账户素材库${pushToProfile ? '，并同步到快手主页' : '（未同步主页）'}`,
      );
      void listQuery.refetch();
      setPreviewId(res.photoId);
    } catch (err) {
      modal.error({ title: '上传失败', content: explainError(err) });
    } finally {
      setUploading(false);
      setPercent(0);
      setUploadName('');
    }
  };

  /* 已上传视频补推主页（pushToProfile 接口） */
  const [pushingId, setPushingId] = useState<string | null>(null);
  const pushToProfileAction = (item: AssetItem) => {
    if (!advertiserId) return;
    modal.confirm({
      title: `把「${item.name || item.id}」推送到快手主页？`,
      content:
        '推送后该视频会出现在该账户绑定的快手号个人主页，对外可见。平台接口为 pushToProfile，推送结果以平台返回为准。',
      okText: '推送',
      onOk: async () => {
        setPushingId(item.id);
        try {
          await api.post('/api/plan/assets/videos/push-to-profile', {
            advertiserId,
            photoId: item.id,
          });
          message.success('已推送到快手主页');
        } catch (err) {
          modal.error({ title: '推送失败', content: explainError(err) });
        } finally {
          setPushingId(null);
        }
      },
    });
  };

  /* 筛选：关键词 + 排序；数据量大时分页 */
  const [keyword, setKeyword] = useState('');
  const [sortBy, setSortBy] = useState<'uploadTime' | 'cost7d' | 'costToday'>('uploadTime');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(30);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const previewItem = useMemo(
    () => (listQuery.data ?? []).find((v) => v.id === previewId) ?? null,
    [listQuery.data, previewId],
  );

  useEffect(() => {
    setPage(1);
  }, [keyword, sortBy, advertiserId]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    const num = (x: number | undefined) => (x === undefined ? -1 : x);
    return (listQuery.data ?? [])
      .filter((v) => !kw || v.name.toLowerCase().includes(kw) || v.id.includes(kw))
      .sort((a, b) =>
        sortBy === 'uploadTime'
          ? (b.uploadTime ?? '').localeCompare(a.uploadTime ?? '')
          : num(b[sortBy]) - num(a[sortBy]),
      );
  }, [listQuery.data, keyword, sortBy]);

  const pageItems = filtered.slice((page - 1) * pageSize, page * pageSize);
  /** 封面加载失败表：key = photoId，用于把破图占位成「无封面」 */
  const [brokenCovers, setBrokenCovers] = useState<Record<string, boolean>>({});

  const accountOptions = accounts.map((a) => ({
    value: a.advertiserId,
    label: `${a.accountName ?? '未命名账户'}（${a.advertiserId}）${a.readOnly ? ' · 只读' : ''}`,
  }));

  return (
    <Card size="small">
      {/* 工具条：账户 + 上传 + 同步 + 搜索 + 排序 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <Select
          showSearch
          optionFilterProp="label"
          style={{ minWidth: 260, maxWidth: 420, flex: '1 1 260px' }}
          placeholder="选择账户"
          value={advertiserId || undefined}
          onChange={setAdvertiserId}
          options={accountOptions}
          disabled={accounts.length === 0}
        />
        <input
          ref={fileRef}
          type="file"
          accept="video/mp4,video/quicktime,video/webm"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.currentTarget.value = '';
            void handleFile(f);
          }}
        />
        <Button
          type="primary"
          icon={<CloudUploadOutlined />}
          loading={uploading}
          disabled={!writable}
          title={
            writable
              ? '从本机选择视频，上传到该账户素材库'
              : current?.readOnly
                ? '该账户在代投白名单内，禁止上传'
                : '先选择账户'
          }
          onClick={() => fileRef.current?.click()}
        >
          {uploading ? '上传中' : '上传本地视频'}
        </Button>
        <Checkbox
          checked={pushToProfile}
          disabled={!writable || uploading}
          onChange={(e) => setPushToProfile(e.target.checked)}
        >
          <Tooltip title="勾选后，本次上传的视频会自动同步到该账户绑定的快手号个人主页（shield_backward_switch=true）；不勾选则屏蔽、不上主页">
            上传后同步到快手主页
          </Tooltip>
        </Checkbox>
        <Button icon={<SyncOutlined />} loading={syncing} disabled={!advertiserId} onClick={() => void syncVideos()}>
          同步素材
        </Button>
        <Button icon={<ReloadOutlined />} loading={listQuery.isFetching} disabled={!advertiserId} onClick={() => void listQuery.refetch()}>
          刷新
        </Button>
        <Input
          allowClear
          prefix={<SearchOutlined style={{ color: '#B8B5AC' }} />}
          placeholder="搜索素材名称或 ID"
          style={{ width: 200 }}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <Select
          style={{ width: 180 }}
          value={sortBy}
          onChange={(v) => setSortBy(v as typeof sortBy)}
          options={[
            { value: 'uploadTime', label: '按上传时间 新→旧' },
            { value: 'cost7d', label: '按近7天消耗 高→低' },
            { value: 'costToday', label: '按今日消耗 高→低' },
          ]}
        />
      </div>

      {uploading && (
        <div style={{ marginBottom: 10 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            正在上传 {uploadName} 到账户素材库（大文件请勿关闭页面）
          </Typography.Text>
          <Progress percent={percent} size="small" status="active" />
        </div>
      )}

      <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 8 }}>
        这里是账户素材库（平台实时列表），共 {filtered.length} 个素材；消耗为素材维度实时口径，平台仅开放近 7 天。
        上传后即可在「上计划 → 选择素材」里直接勾选使用。
      </Typography.Text>

      {listQuery.isLoading ? (
        <div style={{ textAlign: 'center', padding: 40 }}>
          <Spin />
        </div>
      ) : filtered.length === 0 ? (
        <Empty
          description={
            (listQuery.data ?? []).length === 0
              ? '该账户素材库为空，先点「同步素材」从平台拉取，或直接「上传本地视频」'
              : '没有符合搜索条件的素材'
          }
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          style={{ padding: 32 }}
        />
      ) : (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(128px, 1fr))',
              gap: 10,
            }}
          >
            {pageItems.map((v) => {
              const { cover } = videoUrlsOf(v);
              const broken = Boolean(brokenCovers[v.id]);
              return (
                <div
                  key={v.id}
                  onClick={() => setPreviewId(v.id)}
                  style={{
                    cursor: 'pointer',
                    border: '1px solid #E8E6E1',
                    borderRadius: 8,
                    overflow: 'hidden',
                    background: '#fff',
                  }}
                  title={`${v.name || v.id}（点击预览）`}
                >
                  <div style={{ position: 'relative', height: 140, background: '#F5F4F0' }}>
                    {cover && !broken ? (
                      <img
                        src={cover}
                        alt={v.name || v.id}
                        onError={() => setBrokenCovers((m) => ({ ...m, [v.id]: true }))}
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        loading="lazy"
                      />
                    ) : (
                      <div
                        style={{
                          width: '100%',
                          height: '100%',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          color: '#B8B5AC',
                          fontSize: 12,
                        }}
                      >
                        无封面
                      </div>
                    )}
                    <PlayCircleOutlined
                      style={{
                        position: 'absolute',
                        bottom: 4,
                        right: 5,
                        fontSize: 16,
                        color: '#fff',
                        filter: 'drop-shadow(0 0 2px rgba(0,0,0,.85))',
                      }}
                    />
                  </div>
                  <div style={{ padding: '6px 8px' }}>
                    <div
                      style={{
                        fontSize: 12,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={v.name || v.id}
                    >
                      {v.name || v.id}
                    </div>
                    <div style={{ fontSize: 11, color: '#888780', marginTop: 2 }}>
                      {v.uploadTime ? v.uploadTime.slice(0, 10) : '—'}
                      {v.cost7d != null && v.cost7d > 0 ? ` · 7天 ¥${v.cost7d >= 100 ? Math.round(v.cost7d) : v.cost7d.toFixed(2)}` : ''}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
            <Pagination
              size="small"
              current={page}
              pageSize={pageSize}
              total={filtered.length}
              showSizeChanger
              pageSizeOptions={[30, 60, 120]}
              showTotal={(t) => `共 ${t} 条`}
              onChange={(p, ps) => {
                setPage(p);
                setPageSize(ps);
              }}
            />
          </div>
        </>
      )}

      <LibraryPreviewModal
        item={previewItem}
        onClose={() => setPreviewId(null)}
        onPush={writable ? pushToProfileAction : undefined}
        pushing={previewItem ? pushingId === previewItem.id : false}
      />
    </Card>
  );
}

/** 一级面板切换，记住用户上次停留在哪 */
const CENTER_VIEW_KEY = 'wkbd_material_center_view';

/* ------------------------------------------------------------------
 * 创意属性面板（细则 1124 赛马追踪）：按「标签组合 / 单标签 / 广告语 /
 * 原生广告语 / 创意分类 / 行动号召」聚合创意报表，回答哪句文案跑得好。
 * 数据口径 = 创意级实时报表（平台仅开放近 7 天）× 本地创意属性快照。
 * ------------------------------------------------------------------ */

interface AttrRankRow {
  key: string;
  creatives: number;
  charge: number;
  activation: number;
  actCost: number | null;
  payCount: number;
  payCost: number | null;
}

interface AttrRankResult {
  groupBy: string;
  synced: { count: number; skipped: boolean };
  rows: AttrRankRow[];
}

const ATTR_DIMS: Array<{ value: string; label: string }> = [
  { value: 'tags', label: '标签组合' },
  { value: 'tag', label: '单标签' },
  { value: 'description', label: '广告语' },
  { value: 'plcDescription', label: '原生广告语' },
  { value: 'category', label: '创意分类' },
  { value: 'actionBar', label: '行动号召' },
];

function CreativeAttrsPanel({ accounts }: { accounts: AccountSummary[] }) {
  const { modal, message } = App.useApp();

  /** 多账户汇总：默认全选（同名广告语/标签跨账户合计），可缩小到单账户 */
  const [advertiserIds, setAdvertiserIds] = useState<string[]>([]);
  useEffect(() => {
    if (advertiserIds.length === 0 && accounts.length > 0) setAdvertiserIds(accounts.map((a) => a.advertiserId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts]);

  /** 实时报表仅近 7 天，日期钳制在窗口内 */
  const [lookback, setLookback] = useState(7);
  useEffect(() => {
    api
      .get<{ realtimeLookbackDays: number }>('/api/report/meta')
      .then((m) => setLookback(Math.max(m.realtimeLookbackDays, 1)))
      .catch(() => setLookback(7));
  }, []);
  const [range, setRange] = useState<[Dayjs, Dayjs]>(() => [
    dayjs().subtract(6, 'day'),
    dayjs(),
  ]);

  const [groupBy, setGroupBy] = useState<string>('tags');
  const [result, setResult] = useState<AttrRankResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const loadedRef = useRef<string | null>(null);

  /** 日期钳制：起止都限制在实时窗口内（最早 = 今天-(lookback-1)） */
  const clampDate = (d: Dayjs) => {
    const min = dayjs().subtract(lookback - 1, 'day');
    if (d.isBefore(min, 'day')) return min;
    if (d.isAfter(dayjs(), 'day')) return dayjs();
    return d;
  };

  const load = useCallback(
    async (sync = false) => {
      if (advertiserIds.length === 0) return;
      sync ? setSyncing(true) : setLoading(true);
      try {
        const qs = new URLSearchParams({
          advertiserIds: advertiserIds.join(','),
          startDate: range[0].format('YYYY-MM-DD'),
          endDate: range[1].format('YYYY-MM-DD'),
          groupBy,
          ...(sync ? { sync: '1' } : {}),
        });
        const r = await api.get<AttrRankResult>(`/api/report/creative-attrs?${qs.toString()}`);
        setResult(r);
        loadedRef.current = `${advertiserIds.join(',')}|${groupBy}|${range[0].format('YYYY-MM-DD')}|${range[1].format('YYYY-MM-DD')}`;
        if (sync && r.synced?.count > 0) message.success(`已同步 ${r.synced.count} 条创意属性`);
      } catch (err) {
        modal.error({ title: '创意属性聚合失败', content: explainError(err) });
      } finally {
        setSyncing(false);
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [advertiserIds, groupBy, range],
  );

  // 首次进入 / 条件变化自动加载一次
  const condKey = advertiserIds.length > 0 ? `${advertiserIds.join(',')}|${groupBy}|${range[0].format('YYYY-MM-DD')}|${range[1].format('YYYY-MM-DD')}` : '';
  useEffect(() => {
    if (!condKey || loadedRef.current === condKey) return;
    loadedRef.current = condKey;
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [condKey]);

  const columns: ColumnsType<AttrRankRow> = [
    {
      title: '维度值',
      dataIndex: 'key',
      width: 380,
      render: (v: string) => (
        <div
          style={{
            fontSize: 13,
            wordBreak: 'break-all',
            maxHeight: 66,
            overflow: 'hidden',
          }}
          title={v}
        >
          {v}
        </div>
      ),
    },
    {
      title: '创意数',
      dataIndex: 'creatives',
      align: 'right',
      width: 90,
      sorter: (a, b) => a.creatives - b.creatives,
      render: (v: number) => fmtInt(v),
    },
    {
      title: '消耗(元)',
      dataIndex: 'charge',
      align: 'right',
      width: 110,
      sorter: (a, b) => a.charge - b.charge,
      defaultSortOrder: 'descend',
      render: (v: number) => <b>{fmtMoney(v)}</b>,
    },
    {
      title: '激活数',
      dataIndex: 'activation',
      align: 'right',
      width: 90,
      sorter: (a, b) => a.activation - b.activation,
      render: (v: number) => (v > 0 ? fmtInt(v) : '—'),
    },
    {
      title: (
        <Tooltip title="激活成本 = 消耗 ÷ 激活数">
          <span>激活成本(元)</span>
        </Tooltip>
      ),
      dataIndex: 'actCost',
      align: 'right',
      width: 110,
      sorter: (a, b) => (a.actCost ?? 1e9) - (b.actCost ?? 1e9),
      render: (v: number | null) => (v != null ? fmtMoney(v) : '—'),
    },
    {
      title: '付费次数',
      dataIndex: 'payCount',
      align: 'right',
      width: 90,
      sorter: (a, b) => a.payCount - b.payCount,
      render: (v: number) => (v > 0 ? fmtInt(v) : '—'),
    },
    {
      title: (
        <Tooltip title="付费成本 = 消耗 ÷ 付费次数">
          <span>付费成本(元)</span>
        </Tooltip>
      ),
      dataIndex: 'payCost',
      align: 'right',
      width: 110,
      sorter: (a, b) => (a.payCost ?? 1e9) - (b.payCost ?? 1e9),
      render: (v: number | null) => (v != null ? fmtMoney(v) : '—'),
    },
  ];

  const accountOptions = accounts.map((a) => ({
    value: a.advertiserId,
    label: a.accountName ? `${a.accountName}（${a.advertiserId}）` : a.advertiserId,
  }));

  return (
    <Card size="small">
      {/* 工具条：账户（多选默认全选=汇总） + 日期 + 维度 + 操作 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <Select
          showSearch
          mode="multiple"
          allowClear
          optionFilterProp="label"
          maxTagCount="responsive"
          placeholder="选择账户（不选 = 全部账户汇总）"
          style={{ minWidth: 320, maxWidth: 620, flex: '1 1 320px' }}
          value={advertiserIds}
          onChange={(v) => {
            loadedRef.current = null;
            setAdvertiserIds(v);
          }}
          options={accountOptions}
          disabled={accounts.length === 0}
        />
        <DatePicker.RangePicker
          value={[clampDate(range[0]), clampDate(range[1])]}
          allowClear={false}
          disabledDate={(d) => {
            const min = dayjs().subtract(lookback - 1, 'day');
            return d.isAfter(dayjs(), 'day') || d.isBefore(min, 'day');
          }}
          onChange={(v) => {
            if (v?.[0] && v?.[1]) {
              loadedRef.current = null;
              setRange([clampDate(v[0]), clampDate(v[1])]);
            }
          }}
        />
        <Select
          style={{ width: 140 }}
          value={groupBy}
          onChange={(v) => {
            loadedRef.current = null;
            setGroupBy(v);
          }}
          options={ATTR_DIMS}
        />
        <Button
          icon={<SyncOutlined />}
          loading={syncing}
          disabled={advertiserIds.length === 0}
          title="从平台全量回读创意列表，更新本地属性快照（创建创意时已入库，一般无需手点）"
          onClick={() => void load(true)}
        >
          同步属性
        </Button>
        <Button icon={<ReloadOutlined />} loading={loading} disabled={advertiserIds.length === 0} onClick={() => void load(false)}>
          刷新
        </Button>
      </div>

      <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 8 }}>
        按「{ATTR_DIMS.find((d) => d.value === groupBy)?.label}」维度聚合创意报表（实时口径，平台仅开放近 7 天），
        属性快照来自本地创意属性库（创编时入库 + 平台列表同步）。
        当前范围：{advertiserIds.length === 0 ? '未选账户' : advertiserIds.length === accounts.length ? `全部 ${advertiserIds.length} 个账户汇总` : `${advertiserIds.length} 个账户汇总`}。
        用途：赛马追踪哪句广告语 / 哪组标签 / 哪个行动号召跑得好，优选复用。
      </Typography.Text>

      {advertiserIds.length === 0 ? (
        <Empty description="暂无可用账户" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ padding: 32 }} />
      ) : loading && !result ? (
        <div style={{ textAlign: 'center', padding: 40 }}>
          <Spin />
        </div>
      ) : !result || result.rows.length === 0 ? (
        <Empty
          description="该区间没有创意投放数据（或创意属性还没同步，点「同步属性」后重试）"
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          style={{ padding: 32 }}
        />
      ) : (
        <Table<AttrRankRow>
          rowKey={(r) => r.key}
          size="small"
          columns={columns}
          dataSource={result.rows}
          pagination={{ pageSize: 20, showSizeChanger: true, pageSizeOptions: [20, 50, 100], showTotal: (t) => `共 ${t} 条` }}
          footer={() => (
            <span style={{ fontSize: 12, color: '#888780' }}>
              数据时间：{dayjs().format('YYYY-MM-DD HH:mm:ss')}（平台实时）
              {result.synced?.skipped === false && result.synced.count > 0 ? ` · 本次同步 ${result.synced.count} 条属性` : ''}
            </span>
          )}
        />
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------
 * 人群包面板：各账户 dmp/population/list 汇总展示。
 * 人群包是账户级资产 —— 同一个包在 N 个账户下各有一份授权，
 * 这里按人群包 ID 去重合并，并标记它出现在哪些账户下（建计划选定向时参考）。
 * ------------------------------------------------------------------ */

interface PopRow {
  id: string;
  name: string;
  /** 包内人数（record_size，标签包退 cover_num） */
  recordSize: number;
  status: number;
  usable: boolean;
  coverWan: number;
  /** 平台侧校验/创建时间（有值才显示） */
  verifiedAt: string | null;
  /** 归属账户显示名列表 */
  owners: string[];
}

function PopulationPanel({ accounts }: { accounts: AccountSummary[] }) {
  const { modal } = App.useApp();

  /** 多账户：默认全选 */
  const [advertiserIds, setAdvertiserIds] = useState<string[]>([]);
  useEffect(() => {
    if (advertiserIds.length === 0 && accounts.length > 0) setAdvertiserIds(accounts.map((a) => a.advertiserId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts]);

  const [rows, setRows] = useState<PopRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const loadedRef = useRef<string | null>(null);

  const nameOf = useCallback(
    (id: string) => {
      const a = accounts.find((x) => x.advertiserId === id);
      return a?.accountName ? `${a.accountName}（${id}）` : id;
    },
    [accounts],
  );

  const load = useCallback(
    async (force = false) => {
      if (advertiserIds.length === 0) return;
      setLoading(true);
      const key = `${advertiserIds.join(',')}|${force ? 'f1' : 'f0'}`;
      try {
        const lists = await Promise.all(
          advertiserIds.map(async (id) => {
            try {
              return await api.get<Array<Record<string, unknown>>>(
                `/api/plan/assets/populations?advertiserId=${encodeURIComponent(id)}${force ? '&force=1' : ''}`,
              );
            } catch {
              return [] as Array<Record<string, unknown>>;
            }
          }),
        );
        // 按 ID 合并，同一包出现在多个账户时汇总归属
        const merged = new Map<string, PopRow>();
        lists.forEach((list, idx) => {
          const accId = advertiserIds[idx];
          for (const it of list ?? []) {
            const id = String(it.id ?? '');
            if (!id) continue;
            const prev = merged.get(id);
            if (prev) {
              if (!prev.owners.includes(nameOf(accId))) prev.owners.push(nameOf(accId));
              continue;
            }
            merged.set(id, {
              id,
              name: String(it.name ?? id),
              recordSize: Number(it.recordSize ?? 0),
              status: Number(it.status ?? 0),
              usable: Boolean(it.usable),
              coverWan: Number(it.coverWan ?? 0),
              verifiedAt: (it.raw as Record<string, unknown> | undefined)?.verify_time
                ? String((it.raw as Record<string, unknown>).verify_time)
                : null,
              owners: [nameOf(accId)],
            });
          }
        });
        const out = [...merged.values()].sort((a, b) => b.recordSize - a.recordSize);
        setRows(out);
        loadedRef.current = key;
      } catch (err) {
        modal.error({ title: '人群包读取失败', content: explainError(err) });
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [advertiserIds, nameOf],
  );

  const condKey = advertiserIds.length > 0 ? advertiserIds.join(',') : '';
  useEffect(() => {
    if (!condKey || loadedRef.current === condKey) return;
    loadedRef.current = condKey;
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [condKey]);

  const popColumns: ColumnsType<PopRow> = [
    {
      title: '人群包名称',
      dataIndex: 'name',
      width: 340,
      render: (v: string) => (
        <div style={{ fontSize: 13, wordBreak: 'break-all', maxHeight: 66, overflow: 'hidden' }} title={v}>
          {v}
        </div>
      ),
    },
    {
      title: '人群包 ID',
      dataIndex: 'id',
      width: 130,
      render: (v: string) => <Typography.Text copyable={{ text: v }} style={{ fontSize: 12 }}>{v}</Typography.Text>,
    },
    {
      title: (
        <Tooltip title="包内人数：上传/推送包取 record_size，标签包退 cover_num">
          <span>规模(万)</span>
        </Tooltip>
      ),
      dataIndex: 'coverWan',
      align: 'right',
      width: 110,
      sorter: (a, b) => a.recordSize - b.recordSize,
      defaultSortOrder: 'descend',
      render: (v: number) => fmtInt(v),
    },
    {
      title: '状态',
      dataIndex: 'usable',
      align: 'center',
      width: 90,
      filters: [
        { text: '可用', value: 'usable' },
        { text: '不可用', value: 'unusable' },
      ],
      onFilter: (v, r) => (v === 'usable' ? r.usable : !r.usable),
      render: (_: unknown, r: PopRow) =>
        r.usable ? <Tag color="green">可用</Tag> : <Tag color="default">不可用</Tag>,
    },
    {
      title: '归属账户',
      dataIndex: 'owners',
      width: 220,
      render: (v: string[]) =>
        v.length <= 2 ? (
          <span style={{ fontSize: 12 }}>{v.join('、')}</span>
        ) : (
          <Tooltip title={v.join('、')}>
            <span style={{ fontSize: 12 }}>{v.length} 个账户</span>
          </Tooltip>
        ),
    },
    {
      title: '平台校验时间',
      dataIndex: 'verifiedAt',
      width: 160,
      render: (v: string | null) => <span style={{ fontSize: 12, color: '#888780' }}>{v ?? '—'}</span>,
    },
  ];

  const accountOptions = accounts.map((a) => ({
    value: a.advertiserId,
    label: a.accountName ? `${a.accountName}（${a.advertiserId}）` : a.advertiserId,
  }));

  return (
    <Card size="small">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <Select
          showSearch
          mode="multiple"
          allowClear
          optionFilterProp="label"
          maxTagCount="responsive"
          placeholder="选择账户（不选 = 全部账户）"
          style={{ minWidth: 320, maxWidth: 620, flex: '1 1 320px' }}
          value={advertiserIds}
          onChange={(v) => {
            loadedRef.current = null;
            setAdvertiserIds(v);
          }}
          options={accountOptions}
          disabled={accounts.length === 0}
        />
        <Button
          icon={<SyncOutlined />}
          loading={loading}
          disabled={advertiserIds.length === 0}
          title="绕开 10 分钟缓存，直接从平台重拉人群包"
          onClick={() => void load(true)}
        >
          强制刷新
        </Button>
      </div>

      <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 8 }}>
        账户人群包资产汇总（平台 dmp/population/list，本地缓存 10 分钟）。
        当前范围：{advertiserIds.length === 0 ? '未选账户' : advertiserIds.length === accounts.length ? `全部 ${advertiserIds.length} 个账户` : `${advertiserIds.length} 个账户`}。
        同名包在多个账户各有一份授权 → 已按 ID 合并并在「归属账户」里标记，建计划选定向时直接复制 ID 使用。
      </Typography.Text>

      {advertiserIds.length === 0 ? (
        <Empty description="暂无可用账户" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ padding: 32 }} />
      ) : loading && !rows ? (
        <div style={{ textAlign: 'center', padding: 40 }}>
          <Spin />
        </div>
      ) : !rows || rows.length === 0 ? (
        <Empty description="所选账户下没有人群包（可在磁力引擎 DMP 或本工作台建计划流程里创建）" image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ padding: 32 }} />
      ) : (
        <Table<PopRow>
          rowKey={(r) => r.id}
          size="small"
          columns={popColumns}
          dataSource={rows}
          pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t) => `共 ${t} 个` }}
          footer={() => (
            <span style={{ fontSize: 12, color: '#888780' }}>
              可用 {rows.filter((r) => r.usable).length} / {rows.length} 个 · 数据时间：{dayjs().format('YYYY-MM-DD HH:mm:ss')}
            </span>
          )}
        />
      )}
    </Card>
  );
}

export default function MaterialBoardPage() {
  const { modal, message } = App.useApp();

  const [view, setView] = useState<'board' | 'library' | 'attrs' | 'pops'>(() => {
    const v = (() => {
      try {
        return localStorage.getItem(CENTER_VIEW_KEY);
      } catch {
        return null;
      }
    })();
    return v === 'library' || v === 'attrs' || v === 'pops' ? v : 'board';
  });
  const switchView = (v: 'board' | 'library' | 'attrs' | 'pops') => {
    setView(v);
    try {
      localStorage.setItem(CENTER_VIEW_KEY, v);
    } catch {
      /* 存不了就算了，不影响切换 */
    }
  };

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
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0 }}>素材中心</h2>
          <Segmented
            value={view}
            onChange={(v) => switchView(v as 'board' | 'library' | 'attrs' | 'pops')}
            options={[
              { value: 'board', label: '素材看板' },
              { value: 'library', label: '素材库' },
              { value: 'attrs', label: '创意属性' },
              { value: 'pops', label: '人群包' },
            ]}
          />
        </div>
        <p>
          {view === 'board'
            ? '覆盖全部账户的全部素材。历史数据取自本地永久库 —— 平台实时报表只开放近 7 天，工作台每天自动同步并永久保留，因此可长期回溯与分析；今日数据为平台实时值。点素材行可展开查看该素材在各账户下的明细。'
            : view === 'library'
              ? '账户素材库管理：浏览平台素材、上传本地视频到账户素材库。上传的素材可直接在「上计划 → 选择素材」里勾选使用。'
              : view === 'attrs'
                ? '创意属性赛马（细则 1124）：按标签组合 / 单标签 / 广告语 / 原生广告语 / 创意分类 / 行动号召聚合创意报表，默认汇总全部账户，同名文案跨账户合计，追踪哪句文案、哪组标签跑得好，优选复用。'
                : '账户人群包列表：查看各账户可用的人群定向包（含规模与可用状态），供建计划选定向时参考。'}
        </p>
      </div>

      {view === 'library' ? (
        <MaterialLibraryPanel accounts={usable} />
      ) : view === 'attrs' ? (
        <CreativeAttrsPanel accounts={usable} />
      ) : view === 'pops' ? (
        <PopulationPanel accounts={usable} />
      ) : (
        <>
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
        </>
      )}

      {view === 'board' && (
        <MaterialPreviewModal row={preview} rangeText={rangeText} onClose={() => setPreview(null)} />
      )}
    </div>
  );
}
