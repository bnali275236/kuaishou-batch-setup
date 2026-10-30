import { useEffect, useMemo, useState } from 'react';
import { Button, Input, Modal, Select, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { SearchOutlined } from '@ant-design/icons';
import type { AccountSummary } from '@wkbd/shared';

/**
 * 媒体账户选择弹窗（对照创量「选择媒体账户」的表格多选形态）。
 *
 * 为什么改成弹窗：账户一多（200+），原来「可选账户」一栏平铺 Tag 会把
 * 页面撑得非常长，既难看也难选。收进弹窗后：搜索、按授权凭证筛选、
 * 分页勾选，确定后按钮上只展示「已选 X/Y」。
 */

const PAGE_SIZE_OPTIONS = ['20', '50', '100'];

export function AccountPickerModal(props: {
  open: boolean;
  accounts: AccountSummary[];
  /** null = 全选（尚未手动筛选过） */
  initialSelected: string[] | null;
  onClose: () => void;
  onOk: (ids: string[] | null) => void;
}) {
  const { open, accounts, initialSelected, onClose, onOk } = props;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMode, setAllMode] = useState(true);
  const [keyword, setKeyword] = useState('');
  const [grantId, setGrantId] = useState<number | 'ALL'>('ALL');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  // 每次打开时以外部状态初始化
  useEffect(() => {
    if (!open) return;
    setAllMode(initialSelected === null);
    setSelected(new Set(initialSelected ?? accounts.map((a) => a.advertiserId)));
    setKeyword('');
    setGrantId('ALL');
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const grantOptions = useMemo<Array<{ value: number | 'ALL'; label: string }>>(() => {
    const map = new Map<number, string>();
    for (const a of accounts) {
      if (!map.has(a.grantId)) map.set(a.grantId, a.grantLabel ?? `授权凭证 #${a.grantId}`);
    }
    return (
      [
        { value: 'ALL', label: '全部授权' },
      ] as Array<{ value: number | 'ALL'; label: string }>
    ).concat([...map.entries()].map(([value, label]) => ({ value, label })));
  }, [accounts]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return accounts.filter((a) => {
      if (grantId !== 'ALL' && a.grantId !== grantId) return false;
      if (
        kw &&
        !a.advertiserId.toLowerCase().includes(kw) &&
        !(a.accountName ?? '').toLowerCase().includes(kw)
      ) {
        return false;
      }
      return true;
    });
  }, [accounts, keyword, grantId]);

  const pageItems = filtered.slice((page - 1) * pageSize, page * pageSize);

  const toggleOne = (id: string, on: boolean) => {
    setAllMode(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const togglePage = (on: boolean) => {
    setAllMode(false);
    setSelected((prev) => {
      const next = new Set(prev);
      for (const a of pageItems) {
        if (on) next.add(a.advertiserId);
        else next.delete(a.advertiserId);
      }
      return next;
    });
  };

  const columns: ColumnsType<AccountSummary> = [
    {
      title: '账户名称',
      dataIndex: 'accountName',
      render: (v: string | null, row) => (
        <div>
          <div style={{ fontSize: 13 }}>{v ?? '未命名账户'}</div>
          <div style={{ fontSize: 11, color: '#888780' }}>{row.advertiserId}</div>
        </div>
      ),
    },
    {
      title: '授权凭证',
      dataIndex: 'grantLabel',
      width: 240,
      render: (v: string | null, row) => (
        <Space size={4}>
          <Tag style={{ margin: 0 }} color={row.grantStatus === 'ACTIVE' ? 'success' : 'warning'}>
            {row.grantStatus === 'ACTIVE' ? '正常' : row.grantStatus}
          </Tag>
          <span style={{ fontSize: 12 }}>{v ?? `#${row.grantId}`}</span>
        </Space>
      ),
    },
  ];

  return (
    <Modal
      title="选择媒体账户"
      open={open}
      onCancel={onClose}
      width={860}
      footer={
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <Typography.Link
            style={{ fontSize: 12 }}
            onClick={(e) => {
              e.preventDefault();
              setAllMode(false);
              setSelected(new Set());
            }}
          >
            清空已选
          </Typography.Link>
          <div style={{ flex: 1 }} />
          <Button onClick={onClose}>取消</Button>
          <Button
            type="primary"
            disabled={!allMode && selected.size === 0}
            onClick={() => onOk(allMode ? null : [...selected])}
          >
            确定
          </Button>
        </div>
      }
    >
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <Select
          style={{ width: 220 }}
          value={grantId}
          onChange={(v) => {
            setGrantId(v);
            setPage(1);
          }}
          options={grantOptions}
        />
        <Input
          allowClear
          prefix={<SearchOutlined style={{ color: '#B8B5AC' }} />}
          placeholder="搜索账户名称或账户 ID"
          style={{ width: 240 }}
          value={keyword}
          onChange={(e) => {
            setKeyword(e.target.value);
            setPage(1);
          }}
        />
        <Typography.Link
          style={{ fontSize: 12, lineHeight: '32px' }}
          onClick={(e) => {
            e.preventDefault();
            setKeyword('');
            setGrantId('ALL');
            setPage(1);
          }}
        >
          清空
        </Typography.Link>
      </div>

      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {allMode
          ? `当前选中全部 ${accounts.length} 个账户，可取消勾选剔除部分账户`
          : `已选 ${selected.size} / ${accounts.length} 个账户`}
      </Typography.Text>

      <Table<AccountSummary>
        rowKey="advertiserId"
        size="small"
        style={{ marginTop: 6 }}
        columns={columns}
        dataSource={pageItems}
        rowSelection={{
          selectedRowKeys: pageItems
            .map((a) => a.advertiserId)
            .filter((id) => selected.has(id)),
          onSelect: (row, on) => toggleOne(row.advertiserId, on),
          onSelectAll: (on) => togglePage(on),
          selections: [
            {
              key: 'all-page',
              text: `全选本页（${pageItems.length}）`,
              onSelect: () => togglePage(true),
            },
          ],
        }}
        pagination={{
          size: 'small',
          current: page,
          pageSize,
          total: filtered.length,
          showSizeChanger: true,
          pageSizeOptions: PAGE_SIZE_OPTIONS,
          showQuickJumper: true,
          showTotal: (t) => `共 ${t} 条`,
          onChange: (p, ps) => {
            setPage(p);
            setPageSize(ps);
          },
        }}
        locale={{ emptyText: '没有符合条件的账户' }}
      />
    </Modal>
  );
}
