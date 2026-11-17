import { FireOutlined, ReloadOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { App, Button, Empty, Input, Spin, Table, Tabs, Tag, Typography } from 'antd';
import { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useMemo, useState } from 'react';
import { api } from '../api/client';

interface HotItem {
  platform: string;
  rank: number;
  title: string;
  hotValue: string | null;
  url: string | null;
}

interface HotTopicResult {
  updatedAt: string | null;
  platforms: Array<{ id: string; name: string; fetchedAt: string | null; error?: string }>;
  items: HotItem[];
}

const dayjsFmt = (iso: string) => dayjs(iso).format('HH:mm:ss');

export default function HotTopicsPage() {
  const { message } = App.useApp();
  const [active, setActive] = useState<string>('weibo');
  const [keyword, setKeyword] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const { data, isLoading, refetch } = useQuery<HotTopicResult>({
    queryKey: ['hot-topics'],
    queryFn: () => api.get<HotTopicResult>('/api/hot-topics'),
    // 后端每 10 分钟自动抓一次；前端 5 分钟轮询兜底（页面开着时也能看到更新）
    refetchInterval: 5 * 60_000,
  });

  const doRefresh = async () => {
    setRefreshing(true);
    try {
      await api.post('/api/hot-topics/refresh');
      await refetch();
      message.success('已刷新');
    } catch (err) {
      message.error(`刷新失败：${(err as Error).message}`);
    } finally {
      setRefreshing(false);
    }
  };

  const rows = useMemo(() => (data?.items ?? []).filter((r) => r.platform === active), [data, active]);
  const kw = keyword.trim().toLowerCase();
  const filtered = useMemo(() => (kw ? rows.filter((r) => r.title.toLowerCase().includes(kw)) : rows), [rows, kw]);

  const platformMeta = data?.platforms.find((p) => p.id === active);

  const columns: ColumnsType<HotItem> = [
    {
      title: '#',
      dataIndex: 'rank',
      width: 56,
      render: (v: number) => {
        const color = v <= 3 ? '#E24B4A' : v <= 10 ? '#EF9F27' : '#B4B2A9';
        return <span style={{ fontWeight: 500, color, fontVariantNumeric: 'tabular-nums' }}>{v}</span>;
      },
    },
    {
      title: '热点标题',
      dataIndex: 'title',
      render: (v: string, row) =>
        row.url ? (
          <a href={row.url} target="_blank" rel="noreferrer" style={{ fontSize: 13 }}>
            {v}
          </a>
        ) : (
          <span style={{ fontSize: 13 }}>{v}</span>
        ),
    },
    {
      title: '热度',
      dataIndex: 'hotValue',
      width: 110,
      align: 'right',
      render: (v: string | null) => (v ? <Tag style={{ marginInlineEnd: 0 }}>{v}</Tag> : <span style={{ color: '#B4B2A9' }}>—</span>),
    },
  ];

  return (
    <div>
      <div className="page-header">
        <h2>实时热点</h2>
        <p>微博 / 百度 / 头条 / B站 / 知乎热榜聚合，每 10 分钟自动更新，可作素材选题参考</p>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
        <Input
          allowClear
          placeholder="按关键字过滤标题"
          prefix={<FireOutlined style={{ color: '#B4B2A9' }} />}
          style={{ width: 260 }}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <Button icon={<ReloadOutlined />} loading={refreshing} onClick={() => void doRefresh()}>
          立即刷新
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 'auto' }}>
          {platformMeta?.fetchedAt ? `更新于 ${dayjsFmt(platformMeta.fetchedAt)}` : '尚未抓取'}
        </Typography.Text>
      </div>

      <Tabs
        activeKey={active}
        onChange={setActive}
        items={(data?.platforms ?? []).map((p) => ({
          key: p.id,
          label: <span style={p.error ? { color: '#B4B2A9' } : undefined}>{p.name}</span>,
          children: (
            <div>
              {platformMeta?.error && <Typography.Text type="secondary">{platformMeta.error}</Typography.Text>}
              {!platformMeta?.error && (isLoading ? (
                <div style={{ padding: 40, textAlign: 'center' }}>
                  <Spin />
                </div>
              ) : filtered.length === 0 ? (
                <Empty description={kw ? '没有匹配的热点' : '暂无数据'} />
              ) : (
                <Table<HotItem>
                  rowKey={(r) => `${r.platform}-${r.rank}`}
                  size="small"
                  columns={columns}
                  dataSource={filtered}
                  pagination={false}
                  sticky
                  scroll={{ y: 'calc(100vh - 300px)' }}
                  onRow={(r) => ({
                    style: { cursor: r.url ? 'pointer' : 'default' },
                    onClick: () => {
                      if (r.url) window.open(r.url, '_blank');
                    },
                  })}
                />
              ))}
            </div>
          ),
        }))}
      />
    </div>
  );
}
