import { Tag, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { HierRow } from './useHierarchy';

/* 账户明细表切到「广告组 / 创意」时的列定义。
 * 与账户表保持同一套指标口径（同源 /api/report/level），只是多了账户/计划/组归属列。 */

const fmtMoney = (n: number) => n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtInt = (n: number) => Math.round(n).toLocaleString('zh-CN');
const fmtPct = (n: number) => (n > 0 ? `${(n * 100).toFixed(2)}%` : '—');

const BID_TYPE_TEXT: Record<number, string> = {
  1: 'CPM',
  2: 'CPC',
  6: 'OCPC',
  10: 'OCPM',
  12: '最大转化',
};

const monoStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#888780',
  fontFamily: 'ui-monospace, Consolas, monospace',
};

/** 账户名 + ID（点击进入该账户的计划/组/创意抽屉） */
function accountCell(row: HierRow, onOpenAccount: (id: string) => void) {
  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{ fontSize: 13, cursor: 'pointer', color: '#534AB7', fontWeight: 500 }}
        title="点击进入该账户，逐层查看计划 / 广告组 / 创意"
        onClick={() => onOpenAccount(row.advertiserId)}
      >
        {row.accountName ?? '未命名账户'}
      </div>
      <div style={monoStyle}>{row.advertiserId}</div>
    </div>
  );
}

/** 名称 + ID 两行（计划 / 组 / 创意通用） */
function nameCell(name: string | null, id: string | null, opts?: { bold?: boolean; tip?: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          fontSize: 13,
          fontWeight: opts?.bold ? 500 : 400,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={opts?.tip ?? name ?? undefined}
      >
        {name ?? <span style={{ color: '#B8B5AC' }}>未命名</span>}
      </div>
      {id && <div style={monoStyle}>{id}</div>}
    </div>
  );
}

function statusCell(row: HierRow) {
  const deleted = row.putStatus === 3;
  const running = row.putStatus === 1;
  const color = deleted ? '#A32D2D' : running ? '#0F6E56' : '#B27B18';
  return <span style={{ fontSize: 12, color }}>{row.putStatusText}</span>;
}

const metricColumns = (opts: { withBudget: boolean; withBid: boolean }): ColumnsType<HierRow> => [
  {
    title: '消耗(元)',
    key: 'charge',
    dataIndex: 'charge',
    width: 96,
    align: 'right',
    sorter: (a, b) => a.charge - b.charge,
    defaultSortOrder: 'descend',
    render: (_, r) => <b>{fmtMoney(r.charge)}</b>,
  },
  {
    title: '展示数',
    key: 'show',
    dataIndex: 'show',
    width: 92,
    align: 'right',
    sorter: (a, b) => a.show - b.show,
    render: (_, r) => (r.show > 0 ? fmtInt(r.show) : '—'),
  },
  {
    title: '点击率',
    key: 'clickRatio',
    dataIndex: 'clickRatio',
    width: 84,
    align: 'right',
    sorter: (a, b) => a.clickRatio - b.clickRatio,
    render: (_, r) => fmtPct(r.clickRatio),
  },
  {
    title: '转化数',
    key: 'conversionNum',
    dataIndex: 'conversionNum',
    width: 84,
    align: 'right',
    sorter: (a, b) => a.conversionNum - b.conversionNum,
    render: (_, r) => (r.conversionNum > 0 ? fmtInt(r.conversionNum) : '—'),
  },
  {
    title: '转化率',
    key: 'conversionRatio',
    dataIndex: 'conversionRatio',
    width: 84,
    align: 'right',
    sorter: (a, b) => a.conversionRatio - b.conversionRatio,
    render: (_, r) => fmtPct(r.conversionRatio),
  },
  {
    title: '激活数',
    key: 'activation',
    dataIndex: 'activation',
    width: 80,
    align: 'right',
    sorter: (a, b) => a.activation - b.activation,
    render: (_, r) => (r.activation > 0 ? fmtInt(r.activation) : '—'),
  },
  {
    title: '激活成本(元)',
    key: 'activationCost',
    dataIndex: 'activationCost',
    width: 104,
    align: 'right',
    sorter: (a, b) => a.activationCost - b.activationCost,
    render: (_, r) => (r.activationCost > 0 ? fmtMoney(r.activationCost) : '—'),
  },
  {
    title: '注册数',
    key: 'registerCount',
    dataIndex: 'registerCount',
    width: 80,
    align: 'right',
    sorter: (a, b) => a.registerCount - b.registerCount,
    render: (_, r) => (r.registerCount > 0 ? fmtInt(r.registerCount) : '—'),
  },
  {
    title: '付费次数',
    key: 'payCount',
    dataIndex: 'payCount',
    width: 84,
    align: 'right',
    sorter: (a, b) => a.payCount - b.payCount,
    render: (_, r) => (r.payCount > 0 ? fmtInt(r.payCount) : '—'),
  },
  ...(opts.withBudget
    ? [
        {
          title: '日预算(元)',
          key: 'dayBudget',
          dataIndex: 'dayBudgetYuan',
          width: 100,
          align: 'right' as const,
          render: (_: unknown, r: HierRow) =>
            r.dayBudgetYuan === 0 ? (
              <Tooltip title="0 = 不限">
                <span style={{ fontSize: 12 }}>不限</span>
              </Tooltip>
            ) : (
              <span style={{ fontSize: 12 }}>{fmtMoney(r.dayBudgetYuan)}</span>
            ),
        },
      ]
    : []),
  ...(opts.withBid
    ? [
        {
          title: '出价(元)',
          key: 'bid',
          dataIndex: 'bidYuan',
          width: 104,
          align: 'right' as const,
          render: (_: unknown, r: HierRow) => (
            <span style={{ fontSize: 12 }}>
              {r.bidYuan > 0 ? fmtMoney(r.bidYuan) : '—'}
              {r.bidType != null && (
                <Tag style={{ fontSize: 10, lineHeight: '16px', marginInlineEnd: 0, marginLeft: 4 }}>
                  {BID_TYPE_TEXT[r.bidType] ?? r.bidType}
                </Tag>
              )}
            </span>
          ),
        },
      ]
    : []),
];

/** 广告组明细：账户 / 计划 / 组 / 状态 / 指标 / 预算 / 出价 */
export function buildUnitColumns(onOpenAccount: (id: string) => void): ColumnsType<HierRow> {
  return [
    {
      title: '广告账户',
      key: 'account',
      width: 200,
      fixed: 'left',
      render: (_, r) => accountCell(r, onOpenAccount),
    },
    {
      title: '计划',
      key: 'campaign',
      width: 190,
      render: (_, r) => nameCell(r.campaignName, r.campaignId),
    },
    {
      title: '广告组',
      key: 'unit',
      width: 220,
      render: (_, r) => nameCell(r.unitName, r.unitId, { bold: true, tip: r.unitName ?? undefined }),
    },
    { title: '状态', key: 'status', dataIndex: 'putStatusText', width: 90, render: (_, r) => statusCell(r) },
    ...metricColumns({ withBudget: true, withBid: true }),
    {
      title: '操作',
      key: 'ops',
      width: 92,
      fixed: 'right',
      render: (_, r) => (
        <a style={{ fontSize: 12 }} onClick={() => onOpenAccount(r.advertiserId)}>
          进入账户
        </a>
      ),
    },
  ];
}

/** 创意明细：账户 / 计划 / 组 / 创意 / 状态 / 指标 */
export function buildCreativeColumns(onOpenAccount: (id: string) => void): ColumnsType<HierRow> {
  return [
    {
      title: '广告账户',
      key: 'account',
      width: 190,
      fixed: 'left',
      render: (_, r) => accountCell(r, onOpenAccount),
    },
    {
      title: '计划',
      key: 'campaign',
      width: 170,
      render: (_, r) => nameCell(r.campaignName, r.campaignId),
    },
    {
      title: '广告组',
      key: 'unit',
      width: 190,
      render: (_, r) => nameCell(r.unitName, r.unitId),
    },
    {
      title: '创意',
      key: 'creative',
      width: 280,
      render: (_, r) => nameCell(r.creativeName, r.creativeId, { bold: true, tip: r.creativeName ?? undefined }),
    },
    { title: '状态', key: 'status', dataIndex: 'putStatusText', width: 90, render: (_, r) => statusCell(r) },
    ...metricColumns({ withBudget: false, withBid: false }),
    {
      title: '操作',
      key: 'ops',
      width: 92,
      fixed: 'right',
      render: (_, r) => (
        <a style={{ fontSize: 12 }} onClick={() => onOpenAccount(r.advertiserId)}>
          进入账户
        </a>
      ),
    },
  ];
}
