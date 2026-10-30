import { ReloadOutlined } from '@ant-design/icons';
import {
  App,
  Button,
  Drawer,
  InputNumber,
  Modal,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, explainError } from '../../api/client';

/* ------------------------------------------------------------------
 * 盯盘看板「进入账户」抽屉：账户 → 计划 → 广告组 → 创意 逐层下钻。
 *
 * 数据两路合并：
 *   结构（名称/状态/预算/出价/时段）← /api/manage/structure
 *   指标（消耗/展示/点击率/转化…） ← /api/report/level/:level
 * 平台层级报表同样只开近 7 天，超出部分自动裁到窗口起点并在页头说明。
 *
 * 🚫 代投白名单账户：整个抽屉的操作区隐藏（后端同样拦截，双保险）。
 * ------------------------------------------------------------------ */

interface StructureItem {
  id: string;
  name: string | null;
  putStatus: number;
  campaignId: string | null;
  unitId: string | null;
  dayBudgetYuan: number;
  bidYuan: number;
  bidType: number | null;
  scheduleTime: string | null;
  putStatusText: string;
}

/** /api/report/level/:level 返回的指标行（只取下钻用得到的字段） */
interface LevelMetricRow {
  campaignId: string | null;
  unitId: string | null;
  creativeId: string | null;
  charge: number;
  show: number;
  bclick: number;
  conversionNum: number;
  activation: number;
}

type Level = 'campaign' | 'unit' | 'creative';

interface DrillRow {
  item: StructureItem;
  charge: number;
  show: number;
  click: number;
  clickRatio: number;
  conversionNum: number;
  conversionRatio: number;
  activation: number;
  activationCost: number;
  hasMetric: boolean;
}

const LEVEL_LABEL: Record<Level, string> = { campaign: '计划', unit: '广告组', creative: '创意' };
const DAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
const BID_TYPE_TEXT: Record<number, string> = {
  1: 'CPM',
  2: 'CPC',
  6: 'OCPC',
  10: 'OCPM',
  12: '最大转化',
};

const fmtMoney = (n: number) =>
  n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtInt = (n: number) => Math.round(n).toLocaleString('zh-CN');
const fmtPct = (n: number) => (n > 0 ? `${(n * 100).toFixed(2)}%` : '—');

/** 把 24*7 的 0/1 串解析成布尔网格；解析失败按全投放处理 */
function parseSchedule(s: string | null): boolean[] {
  const grid = new Array(168).fill(true);
  if (s && s.length === 168 && /^[01]+$/.test(s)) {
    for (let i = 0; i < 168; i += 1) grid[i] = s[i] === '1';
  }
  return grid;
}

/* ---------------- 时段编辑弹窗 ---------------- */

function ScheduleEditorModal({
  open,
  unit,
  saving,
  onCancel,
  onSave,
}: {
  open: boolean;
  unit: StructureItem | null;
  saving: boolean;
  onCancel: () => void;
  onSave: (scheduleTime: string) => void;
}) {
  const [grid, setGrid] = useState<boolean[]>(() => parseSchedule(unit?.scheduleTime ?? null));

  useEffect(() => {
    if (open) setGrid(parseSchedule(unit?.scheduleTime ?? null));
  }, [open, unit]);

  const toggle = (idx: number) => {
    setGrid((p) => {
      const next = [...p];
      next[idx] = !next[idx];
      return next;
    });
  };

  const applyPreset = (preset: 'all' | 'none' | 'weekday' | 'weekend' | 'daytime') => {
    setGrid((prev) => {
      const next = [...prev];
      for (let day = 0; day < 7; day += 1) {
        for (let hour = 0; hour < 24; hour += 1) {
          const idx = day * 24 + hour;
          if (preset === 'all') next[idx] = true;
          else if (preset === 'none') next[idx] = false;
          else if (preset === 'weekday') next[idx] = day < 5;
          else if (preset === 'weekend') next[idx] = day >= 5;
          else next[idx] = hour >= 8 && hour <= 23;
        }
      }
      return next;
    });
  };

  const onHours = grid.filter(Boolean).length;

  return (
    <Modal
      open={open}
      title={`修改投放时段 —— ${unit?.name ?? ''}`}
      onCancel={onCancel}
      width={640}
      destroyOnClose
      footer={[
        <Button key="cancel" onClick={onCancel}>
          取消
        </Button>,
        <Button
          key="save"
          type="primary"
          loading={saving}
          onClick={() => onSave(grid.map((v) => (v ? '1' : '0')).join(''))}
        >
          保存时段（{onHours} 小时）
        </Button>,
      ]}
    >
      <Space wrap size={6} style={{ marginBottom: 10 }}>
        <Button size="small" onClick={() => applyPreset('all')}>全时段</Button>
        <Button size="small" onClick={() => applyPreset('weekday')}>仅工作日</Button>
        <Button size="small" onClick={() => applyPreset('weekend')}>仅周末</Button>
        <Button size="small" onClick={() => applyPreset('daytime')}>每天 8-24 点</Button>
        <Button size="small" onClick={() => applyPreset('none')}>清空</Button>
      </Space>
      <div className="schedule-grid">
        <div />
        {Array.from({ length: 24 }, (_, h) => (
          <Typography.Text key={h} type="secondary" style={{ fontSize: 9, textAlign: 'center' }}>
            {h}
          </Typography.Text>
        ))}
        {DAY_LABELS.map((label, day) => (
          <ScheduleRow
            key={label}
            label={label}
            day={day}
            grid={grid}
            onToggle={toggle}
          />
        ))}
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 8 }}>
        点击格子切换该小时是否投放。注意：清空全部时段视为「全时段投放」（平台规则）。
      </Typography.Text>
    </Modal>
  );
}

function ScheduleRow({
  label,
  day,
  grid,
  onToggle,
}: {
  label: string;
  day: number;
  grid: boolean[];
  onToggle: (idx: number) => void;
}) {
  const cells = [];
  cells.push(
    <Typography.Text key="l" style={{ fontSize: 12, gridColumn: '1' }}>
      周{label}
    </Typography.Text>,
  );
  for (let hour = 0; hour < 24; hour += 1) {
    const idx = day * 24 + hour;
    cells.push(
      <button
        key={hour}
        type="button"
        className={`schedule-cell${grid[idx] ? ' on' : ''}`}
        onClick={() => onToggle(idx)}
        title={`周${label} ${hour}:00 - ${hour + 1}:00`}
      />,
    );
  }
  return <>{cells}</>;
}

/* ---------------- 数字编辑弹窗（预算 / 出价） ---------------- */

function NumberEditModal({
  open,
  title,
  label,
  min,
  note,
  initialValue,
  saving,
  onCancel,
  onSave,
}: {
  open: boolean;
  title: string;
  label: string;
  min: number;
  note?: string;
  initialValue: number;
  saving: boolean;
  onCancel: () => void;
  onSave: (value: number) => void;
}) {
  const [value, setValue] = useState<number | null>(initialValue);
  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);
  return (
    <Modal
      open={open}
      title={title}
      onCancel={onCancel}
      destroyOnClose
      footer={[
        <Button key="cancel" onClick={onCancel}>取消</Button>,
        <Button key="save" type="primary" loading={saving} disabled={value == null} onClick={() => onSave(value as number)}>
          保存
        </Button>,
      ]}
    >
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Space>
          <Typography.Text style={{ fontSize: 13 }}>{label}</Typography.Text>
          <InputNumber
            value={value}
            min={min}
            max={100000000}
            precision={0}
            step={100}
            addonAfter="元"
            style={{ width: 180 }}
            onChange={(v) => setValue(v)}
          />
        </Space>
        {note && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {note}
          </Typography.Text>
        )}
      </Space>
    </Modal>
  );
}

/* ---------------- 主抽屉 ---------------- */

export function AccountDrawer({
  open,
  advertiserId,
  accountName,
  readOnly,
  range,
  onClose,
}: {
  open: boolean;
  advertiserId: string;
  accountName: string | null;
  readOnly: boolean;
  range: [string, string];
  onClose: () => void;
}) {
  const { modal, message } = App.useApp();

  const [level, setLevel] = useState<Level>('campaign');
  const [campaign, setCampaign] = useState<StructureItem | null>(null);
  const [unit, setUnit] = useState<StructureItem | null>(null);
  const [structure, setStructure] = useState<StructureItem[]>([]);
  const [metricMap, setMetricMap] = useState<Map<string, LevelMetricRow>>(new Map());
  const [loading, setLoading] = useState(false);
  const [opLoading, setOpLoading] = useState(false);

  // 数字编辑弹窗
  const [budgetEdit, setBudgetEdit] = useState<{ item: StructureItem; isCampaign: boolean } | null>(null);
  const [bidEdit, setBidEdit] = useState<StructureItem | null>(null);
  const [scheduleEdit, setScheduleEdit] = useState<StructureItem | null>(null);

  // 层级报表只有近 7 天：起点超出窗口就裁到窗口
  const today = dayjs().format('YYYY-MM-DD');
  const minDrillDate = dayjs().subtract(6, 'day').format('YYYY-MM-DD');
  const drillStart = range[0] < minDrillDate ? minDrillDate : range[0];
  const drillEnd = range[1] > today ? today : range[1];
  const rangeClamped = drillStart !== range[0] || drillEnd !== range[1];

  const load = useCallback(async () => {
    if (!open || !advertiserId) return;
    setLoading(true);
    try {
      const body: Record<string, unknown> = {
        advertiserId,
        level,
        ...(level === 'unit' && campaign ? { campaignId: campaign.id } : {}),
        ...(level === 'creative' && unit ? { unitId: unit.id } : {}),
      };
      const items = await api.post<StructureItem[]>('/api/manage/structure', body);
      const metricBody: Record<string, unknown> = {
        advertiserId,
        startDate: drillStart,
        endDate: drillEnd,
        granularity: 'DAILY',
        pageSize: 2000,
      };
      if (level === 'unit' && campaign) metricBody.campaignIds = [campaign.id];
      if (level === 'creative' && unit) metricBody.unitIds = [unit.id];
      const page = await api
        .post<{ rows: LevelMetricRow[] }>('/api/report/level/' + level, metricBody)
        .catch(() => ({ rows: [] as LevelMetricRow[] }));

      // 区间可能跨多天：按实体 ID 聚合计数，比率由聚合计数现算
      const map = new Map<string, LevelMetricRow>();
      for (const r of page.rows ?? []) {
        const key =
          level === 'campaign' ? r.campaignId : level === 'unit' ? r.unitId : r.creativeId;
        if (!key) continue;
        const prev = map.get(key);
        if (prev) {
          prev.charge += r.charge;
          prev.show += r.show;
          prev.bclick += r.bclick;
          prev.conversionNum += r.conversionNum;
          prev.activation += r.activation;
        } else {
          map.set(key, { ...r });
        }
      }
      setStructure(items ?? []);
      setMetricMap(map);
    } catch (err) {
      modal.error({ title: '层级数据读取失败', content: explainError(err) });
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, advertiserId, level, campaign?.id, unit?.id, drillStart, drillEnd]);

  useEffect(() => {
    void load();
  }, [load]);

  // 关闭时重置下钻层级
  useEffect(() => {
    if (!open) {
      setLevel('campaign');
      setCampaign(null);
      setUnit(null);
      setStructure([]);
      setMetricMap(new Map());
    }
  }, [open]);

  const rows: DrillRow[] = useMemo(
    () =>
      structure.map((item) => {
        const m = metricMap.get(item.id);
        const clickRatio = m && m.show > 0 ? m.bclick / m.show : 0;
        return {
          item,
          charge: m?.charge ?? 0,
          show: m?.show ?? 0,
          click: m?.bclick ?? 0,
          clickRatio,
          conversionNum: m?.conversionNum ?? 0,
          conversionRatio: m && m.bclick > 0 ? m.conversionNum / m.bclick : 0,
          activation: m?.activation ?? 0,
          activationCost: m && m.activation > 0 ? m.charge / m.activation : 0,
          hasMetric: Boolean(m),
        };
      }),
    [structure, metricMap],
  );

  const setStatus = async (item: StructureItem, action: 'RUN' | 'PAUSE' | 'DELETE') => {
    if (action === 'DELETE') {
      const label = LEVEL_LABEL[level];
      modal.confirm({
        title: `删除${label}「${item.name ?? item.id}」？`,
        content: '删除后不可恢复，其下所有层级（如组/创意）会一并失效。',
        okText: '确认删除',
        okButtonProps: { danger: true },
        onOk: () => doSetStatus(item, 'DELETE'),
      });
      return;
    }
    await doSetStatus(item, action);
  };

  const doSetStatus = async (item: StructureItem, action: 'RUN' | 'PAUSE' | 'DELETE') => {
    setOpLoading(true);
    try {
      const r = await api.post<{ succeeded: string[]; errors: unknown[] }>('/api/manage/status', {
        advertiserId,
        level,
        ids: [item.id],
        action,
      });
      if (r.errors?.length > 0) {
        modal.warning({
          title: '平台返回部分失败',
          content: JSON.stringify(r.errors).slice(0, 400),
        });
      } else {
        message.success(action === 'RUN' ? '已开启投放' : action === 'PAUSE' ? '已暂停' : '已删除');
      }
      void load();
    } catch (err) {
      modal.error({ title: '状态调整失败', content: explainError(err) });
    } finally {
      setOpLoading(false);
    }
  };

  const saveBudget = async (budgetYuan: number) => {
    if (!budgetEdit) return;
    setOpLoading(true);
    try {
      if (budgetEdit.isCampaign) {
        await api.post('/api/manage/campaign-budget', {
          advertiserId,
          campaignId: budgetEdit.item.id,
          budgetYuan,
        });
      } else {
        await api.post('/api/manage/unit-budget', {
          advertiserId,
          unitId: budgetEdit.item.id,
          budgetYuan,
        });
      }
      message.success('预算已更新');
      setBudgetEdit(null);
      void load();
    } catch (err) {
      modal.error({ title: '预算修改失败', content: explainError(err) });
    } finally {
      setOpLoading(false);
    }
  };

  const saveBid = async (bidYuan: number) => {
    if (!bidEdit) return;
    setOpLoading(true);
    try {
      await api.post('/api/manage/unit-bid', {
        advertiserId,
        unitIds: [bidEdit.id],
        bidYuan,
      });
      message.success('出价已更新');
      setBidEdit(null);
      void load();
    } catch (err) {
      modal.error({ title: '出价修改失败', content: explainError(err) });
    } finally {
      setOpLoading(false);
    }
  };

  const saveSchedule = async (scheduleTime: string) => {
    if (!scheduleEdit) return;
    setOpLoading(true);
    try {
      await api.post('/api/manage/unit-schedule', {
        advertiserId,
        unitId: scheduleEdit.id,
        scheduleTime,
      });
      message.success('投放时段已更新');
      setScheduleEdit(null);
      void load();
    } catch (err) {
      modal.error({ title: '时段修改失败', content: explainError(err) });
    } finally {
      setOpLoading(false);
    }
  };

  const drillInto = (item: StructureItem) => {
    if (level === 'campaign') {
      setCampaign(item);
      setUnit(null);
      setLevel('unit');
    } else if (level === 'unit') {
      setUnit(item);
      setLevel('creative');
    }
  };

  const columns: ColumnsType<DrillRow> = [
    {
      title: LEVEL_LABEL[level] + '名称',
      key: 'name',
      width: 240,
      fixed: 'left',
      render: (_, r) => (
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              ...(level !== 'creative'
                ? { cursor: 'pointer', color: '#534AB7', fontWeight: 500 }
                : {}),
            }}
            title={level !== 'creative' ? '点击查看下级' : (r.item.name ?? undefined)}
            onClick={() => level !== 'creative' && drillInto(r.item)}
          >
            {r.item.name ?? <span style={{ color: '#888780' }}>未命名</span>}
          </div>
          <div style={{ fontSize: 11, color: '#888780', fontFamily: 'ui-monospace, Consolas, monospace' }}>
            {r.item.id}
          </div>
        </div>
      ),
    },
    {
      title: '投放状态',
      key: 'putStatus',
      width: 130,
      render: (_, r) => {
        const deleted = r.item.putStatus === 3;
        return (
          <Space size={6}>
            <Switch
              size="small"
              checked={r.item.putStatus === 1}
              disabled={deleted || readOnly || opLoading}
              onChange={(checked) => void setStatus(r.item, checked ? 'RUN' : 'PAUSE')}
            />
            <span style={{ fontSize: 12, color: deleted ? '#A32D2D' : undefined }}>
              {r.item.putStatusText}
            </span>
          </Space>
        );
      },
    },
    {
      title: '消耗(元)',
      key: 'charge',
      width: 96,
      align: 'right',
      sorter: (a, b) => a.charge - b.charge,
      defaultSortOrder: 'descend',
      render: (_, r) => <b>{fmtMoney(r.charge)}</b>,
    },
    {
      title: '展示数',
      key: 'show',
      width: 92,
      align: 'right',
      sorter: (a, b) => a.show - b.show,
      render: (_, r) => fmtInt(r.show),
    },
    {
      title: '点击率',
      key: 'clickRatio',
      width: 84,
      align: 'right',
      sorter: (a, b) => a.clickRatio - b.clickRatio,
      render: (_, r) => fmtPct(r.clickRatio),
    },
    {
      title: '转化数',
      key: 'conversionNum',
      width: 84,
      align: 'right',
      sorter: (a, b) => a.conversionNum - b.conversionNum,
      render: (_, r) => (r.conversionNum > 0 ? fmtInt(r.conversionNum) : '—'),
    },
    {
      title: '转化率',
      key: 'conversionRatio',
      width: 84,
      align: 'right',
      sorter: (a, b) => a.conversionRatio - b.conversionRatio,
      render: (_, r) => fmtPct(r.conversionRatio),
    },
    {
      title: '激活数',
      key: 'activation',
      width: 80,
      align: 'right',
      sorter: (a, b) => a.activation - b.activation,
      render: (_, r) => (r.activation > 0 ? fmtInt(r.activation) : '—'),
    },
    {
      title: '激活成本(元)',
      key: 'activationCost',
      width: 104,
      align: 'right',
      sorter: (a, b) => a.activationCost - b.activationCost,
      render: (_, r) => (r.activationCost > 0 ? fmtMoney(r.activationCost) : '—'),
    },
    ...(level === 'creative'
      ? []
      : [
          {
            title: '日预算(元)',
            key: 'dayBudget',
            width: 110,
            align: 'right' as const,
            render: (_: unknown, r: DrillRow) => {
              const unlimited = r.item.dayBudgetYuan === 0;
              const text = unlimited ? '不限' : fmtMoney(r.item.dayBudgetYuan);
              if (readOnly) return <span style={{ fontSize: 12 }}>{text}</span>;
              return (
                <a style={{ fontSize: 12 }} onClick={() => setBudgetEdit({ item: r.item, isCampaign: level === 'campaign' })} title="点击修改预算">
                  {text}
                </a>
              );
            },
          },
        ]),
    ...(level === 'unit'
      ? [
          {
            title: '出价(元)',
            key: 'bid',
            width: 100,
            align: 'right' as const,
            render: (_: unknown, r: DrillRow) => (
              <Space size={4}>
                {readOnly ? (
                  <span style={{ fontSize: 12 }}>{fmtMoney(r.item.bidYuan)}</span>
                ) : (
                  <a style={{ fontSize: 12 }} onClick={() => setBidEdit(r.item)} title="点击修改出价">
                    {fmtMoney(r.item.bidYuan)}
                  </a>
                )}
                {r.item.bidType != null && (
                  <Tag style={{ fontSize: 10, lineHeight: '16px', marginRight: 0 }}>{BID_TYPE_TEXT[r.item.bidType] ?? r.item.bidType}</Tag>
                )}
              </Space>
            ),
          },
          {
            title: '投放时段',
            key: 'schedule',
            width: 96,
            render: (_: unknown, r: DrillRow) => {
              const grid = parseSchedule(r.item.scheduleTime);
              const onHours = grid.filter(Boolean).length;
              const all = onHours === 168;
              if (readOnly) return <span style={{ fontSize: 12 }}>{all ? '全时段' : `${onHours} 小时`}</span>;
              return (
                <a style={{ fontSize: 12 }} onClick={() => setScheduleEdit(r.item)} title="点击修改投放时段">
                  {all ? '全时段' : `${onHours} 小时`}
                </a>
              );
            },
          },
        ]
      : []),
    {
      title: '操作',
      key: 'ops',
      width: 170,
      fixed: 'right',
      render: (_, r) => {
        if (readOnly) return <Tag style={{ fontSize: 11 }}>代投只读</Tag>;
        const deleted = r.item.putStatus === 3;
        return (
          <Space size={4}>
            {level !== 'creative' && (
              <Button size="small" type="link" style={{ padding: 0, fontSize: 12 }} onClick={() => drillInto(r.item)}>
                查看下级
              </Button>
            )}
            {!deleted && (
              <Button
                size="small"
                type="link"
                danger
                style={{ padding: 0, fontSize: 12 }}
                disabled={opLoading}
                onClick={() => void setStatus(r.item, 'DELETE')}
              >
                删除
              </Button>
            )}
          </Space>
        );
      },
    },
  ];

  const breadcrumb = (
    <Space size={4} wrap style={{ marginBottom: 10 }}>
      <a onClick={() => { setLevel('campaign'); setCampaign(null); setUnit(null); }} style={{ fontSize: 13 }}>
        {accountName ?? advertiserId}
      </a>
      {level !== 'campaign' && campaign && (
        <>
          <Typography.Text type="secondary">/</Typography.Text>
          <a
            onClick={() => {
              setLevel('unit');
              setUnit(null);
            }}
            style={{ fontSize: 13 }}
          >
            {campaign.name ?? campaign.id}
          </a>
        </>
      )}
      {level === 'creative' && unit && (
        <>
          <Typography.Text type="secondary">/</Typography.Text>
          <Typography.Text style={{ fontSize: 13 }}>{unit.name ?? unit.id}</Typography.Text>
        </>
      )}
    </Space>
  );

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={1180}
      title={
        <Space size={8}>
          <span>{accountName ?? advertiserId}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
            投放明细 {drillStart} ~ {drillEnd}
            {rangeClamped && '（层级明细仅支持近 7 天，已自动裁剪）'}
          </Typography.Text>
        </Space>
      }
      destroyOnClose
    >
      {breadcrumb}
      <Space style={{ marginBottom: 10 }}>
        <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          刷新
        </Button>
        {readOnly && (
          <Tooltip title="代投白名单账户仅可查看数据，不能调整">
            <Tag color="orange">代投只读</Tag>
          </Tooltip>
        )}
      </Space>
      <Table<DrillRow>
        rowKey={(r) => r.item.id}
        size="small"
        columns={columns}
        dataSource={rows}
        loading={loading}
        locale={{
          emptyText:
            level === 'creative'
              ? '没有自定义创意（全自动投放 UAX 账户的创意由系统自动生成，不在自定义创意列表中）'
              : '暂无数据',
        }}
        pagination={{ pageSize: 50, showSizeChanger: false, showTotal: (t) => `共 ${t} 条` }}
        scroll={{ x: 1400 }}
      />

      {budgetEdit && (
        <NumberEditModal
          open
          title={`修改${LEVEL_LABEL[level]}日预算 —— ${budgetEdit.item.name ?? budgetEdit.item.id}`}
          label="单日预算"
          min={budgetEdit.isCampaign ? 500 : 100}
          initialValue={budgetEdit.item.dayBudgetYuan}
          saving={opLoading}
          note={
            budgetEdit.isCampaign
              ? '计划预算不低于 500 元；0 = 不限。平台要求不得低于「当日花费 120% 与原预算的较小者」且不低于组出价，否则会被平台拒绝。'
              : '组预算不低于 100 元；0 = 不限。平台要求不得低于当日花费的 120%，且不能低于组出价。'
          }
          onCancel={() => setBudgetEdit(null)}
          onSave={(v) => void saveBudget(v)}
        />
      )}

      {bidEdit && (
        <NumberEditModal
          open
          title={`修改出价 —— ${bidEdit.name ?? bidEdit.id}`}
          label="目标出价"
          min={1}
          initialValue={bidEdit.bidYuan}
          saving={opLoading}
          note="OCPC/OCPM 行为出价不低于 1 元、激活出价不低于 5 元；CPC 不低于 0.2 元。低于平台下限会被拒绝。"
          onCancel={() => setBidEdit(null)}
          onSave={(v) => void saveBid(v)}
        />
      )}

      {scheduleEdit && (
        <ScheduleEditorModal
          open
          unit={scheduleEdit}
          saving={opLoading}
          onCancel={() => setScheduleEdit(null)}
          onSave={(s) => void saveSchedule(s)}
        />
      )}
    </Drawer>
  );
}
