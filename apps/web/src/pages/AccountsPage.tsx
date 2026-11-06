import { DeleteOutlined, ReloadOutlined, SyncOutlined, TeamOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  Collapse,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useMemo, useState } from 'react';
import { api, explainError } from '../api/client';
import { ALL_AUTH_ENTRIES, AUTH_ENTRY_META, AUTH_TYPE_META } from '@wkbd/shared';
import type { AccountSummary, AuthEntry, AuthGrantSummary, ResyncResult } from '@wkbd/shared';

const GRANT_STATUS_META: Record<string, { color: string; text: string; hint: string }> = {
  ACTIVE: { color: 'success', text: '正常', hint: 'token 有效，可正常调用' },
  REFRESHING: { color: 'processing', text: '刷新中', hint: '正在续期 token' },
  NEED_REAUTH: {
    color: 'error',
    text: '需重新授权',
    hint: 'refresh_token 已失效，必须重新走授权流程。该凭证下所有账户都会受影响',
  },
  DISABLED: { color: 'default', text: '已停用', hint: '已手动停用，其下账户不参与任何拉数与创编' },
};

const ACCOUNT_STATUS_META: Record<string, { color: string; text: string }> = {
  ACTIVE: { color: 'success', text: '启用' },
  DISABLED: { color: 'default', text: '停用' },
};

export default function AccountsPage() {
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();

  const { data: grants, isLoading: grantsLoading } = useQuery<AuthGrantSummary[]>({
    queryKey: ['oauth-grants'],
    queryFn: () => api.get<AuthGrantSummary[]>('/api/oauth/grants'),
  });

  const { data: accounts, isLoading: accountsLoading } = useQuery<AccountSummary[]>({
    queryKey: ['oauth-accounts'],
    queryFn: () => api.get<AccountSummary[]>('/api/oauth/accounts'),
  });

  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: ['oauth-grants'] });
    void queryClient.invalidateQueries({ queryKey: ['oauth-accounts'] });
    void queryClient.invalidateQueries({ queryKey: ['system-health'] });
  };

  const resyncMutation = useMutation({
    mutationFn: (grantId?: number) =>
      api.post<ResyncResult>('/api/oauth/resync', grantId ? { grantId } : {}),
    onSuccess: (data) => {
      message.success(
        `已对齐 ${data.grants} 份授权：发现 ${data.found} 个账户，新增 ${data.added} 个` +
          (data.removed > 0 ? `，停用 ${data.removed} 个` : ''),
      );
      invalidateAll();
    },
    onError: (err) => modal.error({ title: '账户对齐失败', content: explainError(err) }),
  });

  const syncOneMutation = useMutation({
    mutationFn: (grantId: number) => api.post(`/api/oauth/grants/${grantId}/sync`),
    onSuccess: () => {
      message.success('已与平台对齐该凭证下的账户列表');
      invalidateAll();
    },
    onError: (err) => modal.error({ title: '对齐失败', content: explainError(err) }),
  });

  const refreshGrantMutation = useMutation({
    mutationFn: (grantId: number) => api.post(`/api/oauth/grants/${grantId}/refresh`),
    onSuccess: () => {
      message.success('凭证 token 已刷新，其下全部账户同时生效');
      invalidateAll();
    },
    onError: (err) => modal.error({ title: '刷新失败', content: explainError(err) }),
  });

  const renameGrantMutation = useMutation({
    mutationFn: ({ id, label }: { id: number; label: string }) =>
      api.patch(`/api/oauth/grants/${id}`, { label }),
    onSuccess: () => {
      message.success('名称已更新');
      invalidateAll();
    },
    onError: (err) => modal.error({ title: '改名失败', content: explainError(err) }),
  });

  const setAuthTypeMutation = useMutation({
    mutationFn: ({ id, authType }: { id: number; authType: string }) =>
      api.patch(`/api/oauth/grants/${id}`, { authType }),
    onSuccess: () => {
      message.success('授权方式已更正');
      invalidateAll();
    },
    onError: (err) => modal.error({ title: '更正失败', content: explainError(err) }),
  });

  const setAuthEntryMutation = useMutation({
    mutationFn: ({ id, authEntry }: { id: number; authEntry: string }) =>
      api.patch(`/api/oauth/grants/${id}`, { authEntry }),
    onSuccess: () => {
      message.success('授权入口已更正（仅影响本工作台的标记，不改变快手侧授权关系）');
      invalidateAll();
    },
    onError: (err) => modal.error({ title: '更正失败', content: explainError(err) }),
  });

  const toggleGrantMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      api.patch(`/api/oauth/grants/${id}/enabled`, { enabled }),
    onSuccess: () => {
      message.success('凭证状态已更新');
      invalidateAll();
    },
    onError: (err) => modal.error({ title: '操作失败', content: explainError(err) }),
  });

  const removeGrantMutation = useMutation({
    mutationFn: (id: number) => api.del(`/api/oauth/grants/${id}`),
    onSuccess: () => {
      message.success('授权凭证及其账户已从工作台移除');
      invalidateAll();
    },
    onError: (err) => modal.error({ title: '移除失败', content: explainError(err) }),
  });

  const refreshAccountMutation = useMutation({
    mutationFn: (advertiserId: string) => api.post(`/api/oauth/accounts/${advertiserId}/refresh`),
    onSuccess: () => {
      message.success('凭证 token 已刷新');
      invalidateAll();
    },
    onError: (err) => modal.error({ title: '刷新失败', content: explainError(err) }),
  });

  const refreshNameMutation = useMutation({
    mutationFn: (advertiserId: string) =>
      api.post<{ ok: boolean; name: string | null; previous: string | null }>(
        `/api/oauth/accounts/${advertiserId}/refresh-name`,
      ),
    onSuccess: (data) => {
      message.success(
        data.previous && data.previous !== data.name
          ? `账户名称已更新：${data.previous} → ${data.name}`
          : `名称已是最新：${data.name ?? ''}`,
      );
      invalidateAll();
    },
    onError: (err) => modal.error({ title: '刷新名称失败', content: explainError(err) }),
  });

  const whiteListMutation = useMutation({
    mutationFn: (id: string) => api.post(`/api/accounts/${id}/white-list/sync`),
    onSuccess: (data: unknown) => {
      const items = (data as { items?: string[] })?.items ?? [];
      modal.info({
        title: '白名单已同步',
        content: items.length
          ? `共 ${items.length} 项能力：${items.join('、')}`
          : '该账户暂未查询到白名单能力。多数创编能力需要联系快手运营加白后才能使用。',
      });
    },
    onError: (err) => modal.error({ title: '白名单同步失败', content: explainError(err) }),
  });

  const toggleAccountMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.patch(`/api/oauth/accounts/${id}/enabled`, { enabled }),
    onSuccess: () => {
      message.success('账户状态已更新');
      invalidateAll();
    },
    onError: (err) => modal.error({ title: '操作失败', content: explainError(err) }),
  });

  const removeAccountMutation = useMutation({
    mutationFn: (id: string) => api.del(`/api/oauth/accounts/${id}`),
    onSuccess: () => {
      message.success('已从工作台移除');
      invalidateAll();
    },
    onError: (err) => modal.error({ title: '删除失败', content: explainError(err) }),
  });

  /* ---------------- 代投白名单（只读账户） ---------------- */

  const setReadOnlyMutation = useMutation({
    mutationFn: (input: { ids: string[]; readOnly: boolean }) =>
      api.patch('/api/oauth/accounts/read-only', input),
    onSuccess: (_, input) => {
      message.success(input.readOnly ? '已加入代投白名单' : '已移出代投白名单');
      invalidateAll();
    },
    onError: (err) => modal.error({ title: '白名单更新失败', content: explainError(err) }),
  });

  const [whitelistOpen, setWhitelistOpen] = useState(false);
  const [wlKeyword, setWlKeyword] = useState('');
  const [wlChecked, setWlChecked] = useState<Set<string>>(new Set());

  const readOnlyCount = (accounts ?? []).filter((a) => a.readOnly).length;

  const openWhitelist = () => {
    setWlChecked(new Set((accounts ?? []).filter((a) => a.readOnly).map((a) => a.advertiserId)));
    setWlKeyword('');
    setWhitelistOpen(true);
  };

  const wlFiltered = useMemo(() => {
    const kw = wlKeyword.trim().toLowerCase();
    const rows = accounts ?? [];
    if (!kw) return rows;
    return rows.filter(
      (a) =>
        a.advertiserId.toLowerCase().includes(kw) ||
        (a.accountName ?? '').toLowerCase().includes(kw),
    );
  }, [accounts, wlKeyword]);

  /** 保存：与当前白名单求差量，分别批量加入/移出 */
  const saveWhitelist = async () => {
    const current = new Set((accounts ?? []).filter((a) => a.readOnly).map((a) => a.advertiserId));
    const toAdd = [...wlChecked].filter((id) => !current.has(id));
    const toRemove = [...current].filter((id) => !wlChecked.has(id));
    try {
      if (toAdd.length > 0) {
        await api.patch('/api/oauth/accounts/read-only', { ids: toAdd, readOnly: true });
      }
      if (toRemove.length > 0) {
        await api.patch('/api/oauth/accounts/read-only', { ids: toRemove, readOnly: false });
      }
      message.success(
        `代投白名单已保存：加入 ${toAdd.length} 个，移出 ${toRemove.length} 个。白名单内账户仅可查看数据`,
      );
      invalidateAll();
      setWhitelistOpen(false);
    } catch (err) {
      modal.error({ title: '白名单保存失败', content: explainError(err) });
    }
  };

  const accountColumns: ColumnsType<AccountSummary> = [
    {
      title: '广告账户 ID',
      dataIndex: 'advertiserId',
      width: 180,
      render: (v: string) => (
        <span style={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12 }}>{v}</span>
      ),
    },
    {
      title: '账户名称',
      dataIndex: 'accountName',
      render: (v: string | null, row) => (
        <Space size={6}>
          <span>{v ?? <span style={{ color: '#888780' }}>未获取</span>}</span>
          {row.readOnly && (
            <Tooltip title="代投白名单账户：仅可查看数据，不能上计划/调预算/调整计划">
              <Tag color="orange" style={{ margin: 0 }}>
                仅查看
              </Tag>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (v: string) => {
        const meta = ACCOUNT_STATUS_META[v] ?? { color: 'default', text: v };
        return <Tag color={meta.color}>{meta.text}</Tag>;
      },
    },
    {
      title: '操作',
      key: 'actions',
      width: 290,
      render: (_, row) => (
        <Space size={4} wrap>
          <Tooltip title="平台侧改过账户名？点此立即从快手拉取最新名称">
            <Button
              size="small"
              type="link"
              loading={
                refreshNameMutation.isPending && refreshNameMutation.variables === row.advertiserId
              }
              onClick={() => refreshNameMutation.mutate(row.advertiserId)}
            >
              刷新名称
            </Button>
          </Tooltip>
          <Tooltip title="同步平台白名单能力快照（创编能力需要快手运营加白）">
            <Button size="small" type="link" onClick={() => whiteListMutation.mutate(row.advertiserId)}>
              同步白名单
            </Button>
          </Tooltip>
          <Tooltip title={row.readOnly ? '移出代投白名单，恢复投放操作权限' : '加入代投白名单，该账户仅可查看数据'}>
            <Button
              size="small"
              type="link"
              onClick={() =>
                setReadOnlyMutation.mutate({ ids: [row.advertiserId], readOnly: !row.readOnly })
              }
            >
              {row.readOnly ? '移出代投' : '加入代投'}
            </Button>
          </Tooltip>
          <Button
            size="small"
            type="link"
            onClick={() =>
              toggleAccountMutation.mutate({
                id: row.advertiserId,
                enabled: row.status === 'DISABLED',
              })
            }
          >
            {row.status === 'DISABLED' ? '启用' : '停用'}
          </Button>
          <Popconfirm
            title="从工作台移除该账户？"
            description="仅删除本地记录，不影响快手侧的授权关系。"
            okText="移除"
            cancelText="取消"
            onConfirm={() => removeAccountMutation.mutate(row.advertiserId)}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const list = grants ?? [];
  const allAccounts = accounts ?? [];
  const needReauth = list.filter((g) => g.status === 'NEED_REAUTH').length;
  const expiringSoon = list.filter(
    (g) => g.status !== 'DISABLED' && g.refreshTokenDaysLeft >= 0 && g.refreshTokenDaysLeft <= 7,
  ).length;
  const activeAccounts = allAccounts.filter((a) => a.status === 'ACTIVE').length;

  const renderGrantPanel = (grant: AuthGrantSummary) => {
    const meta = GRANT_STATUS_META[grant.status] ?? { color: 'default', text: grant.status, hint: '' };
    const authMeta = AUTH_TYPE_META[grant.authType];
    const entryMeta = AUTH_ENTRY_META[grant.authEntry];
    const rows = allAccounts.filter((a) => a.grantId === grant.id);

    // 单主体入口只覆盖到 1 个账户时，给出「是不是该走罗盘」的提示 ——
    // 这是用户最容易困惑的场景：明明有很多账户，却只授权进来一个。
    const entryHint =
      grant.authEntry === 'ADVERTISER' && grant.accountCount <= 1
        ? '该凭证走的是磁力智投（单主体）入口，天生只能覆盖个别账户。若你要纳管多个账户，请用「磁力罗盘」入口重新授权一次，并在授权页上选「基于用户授权」。'
        : null;

    return {
      key: String(grant.id),
      label: (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Typography.Text
            strong
            style={{ fontSize: 14 }}
            editable={{
              tooltip: '点击修改名称',
              onChange: (v) => renameGrantMutation.mutate({ id: grant.id, label: v }),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {grant.label ?? `授权凭证 #${grant.id}`}
          </Typography.Text>

          <Tooltip title={`授权入口：${entryMeta.label}\n跳转平台：${entryMeta.platform}\n覆盖范围：${entryMeta.coverage}`}>
            <Tag color="geekblue" style={{ margin: 0 }}>
              {entryMeta.platform}
            </Tag>
          </Tooltip>

          {grant.authEntry !== 'AGENT' && (
            <Tooltip title={`${authMeta.howTo}\n生效范围：${authMeta.scope}`}>
              <Tag color={grant.authType === 'USER' ? 'purple' : 'blue'} style={{ margin: 0 }}>
                {authMeta.short}
              </Tag>
            </Tooltip>
          )}

          <Tooltip title={meta.hint}>
            <Tag color={meta.color} style={{ margin: 0 }}>
              {meta.text}
            </Tag>
          </Tooltip>

          <span style={{ fontSize: 12, color: '#888780' }}>
            {grant.activeAccountCount}/{grant.accountCount} 个账户启用 · refresh_token 剩{' '}
            {grant.refreshTokenDaysLeft} 天
          </span>
        </div>
      ),
      extra: (
        <Space size={4} onClick={(e) => e.stopPropagation()}>
          <Tooltip title="重新拉取该凭证下的账户列表（罗盘里新增的账户会自动纳管）">
            <Button
              size="small"
              icon={<SyncOutlined />}
              loading={syncOneMutation.isPending && syncOneMutation.variables === grant.id}
              onClick={() => syncOneMutation.mutate(grant.id)}
            >
              对齐账户
            </Button>
          </Tooltip>
          <Tooltip title="刷新凭证 token（其下全部账户共用，刷新一次即可）">
            <Button
              size="small"
              icon={<ReloadOutlined />}
              disabled={grant.status === 'DISABLED'}
              loading={refreshGrantMutation.isPending && refreshGrantMutation.variables === grant.id}
              onClick={() => refreshGrantMutation.mutate(grant.id)}
            >
              刷新 token
            </Button>
          </Tooltip>
          <Button
            size="small"
            onClick={() =>
              toggleGrantMutation.mutate({ id: grant.id, enabled: grant.status === 'DISABLED' })
            }
          >
            {grant.status === 'DISABLED' ? '启用' : '停用'}
          </Button>
          <Popconfirm
            title="移除整份授权？"
            description={`将同时移除该凭证下的 ${grant.accountCount} 个账户记录。仅影响本地，不影响快手侧授权关系。`}
            okText="移除"
            cancelText="取消"
            onConfirm={() => removeGrantMutation.mutate(grant.id)}
          >
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
      children: (
        <div>
          <div
            style={{
              display: 'flex',
              gap: 24,
              flexWrap: 'wrap',
              fontSize: 12,
              color: '#5F5E5A',
              marginBottom: 12,
              padding: '10px 12px',
              background: '#FAFAF9',
              borderRadius: 8,
            }}
          >
            <span>
              <b style={{ fontWeight: 500 }}>授权入口：</b>
              <Select
                size="small"
                variant="borderless"
                value={grant.authEntry}
                style={{ minWidth: 180 }}
                onChange={(v) =>
                  setAuthEntryMutation.mutate({ id: grant.id, authEntry: v as string })
                }
                options={ALL_AUTH_ENTRIES.map((k) => ({
                  value: k,
                  label: `${AUTH_ENTRY_META[k as AuthEntry].platform} · ${AUTH_ENTRY_META[k as AuthEntry].label}`,
                }))}
              />
            </span>
            {grant.authEntry !== 'AGENT' && (
              <span>
                <b style={{ fontWeight: 500 }}>授权方式：</b>
                <Select
                  size="small"
                  variant="borderless"
                  value={grant.authType}
                  style={{ minWidth: 150 }}
                  onChange={(v) =>
                    setAuthTypeMutation.mutate({ id: grant.id, authType: v as string })
                  }
                  options={[
                    { value: 'USER', label: AUTH_TYPE_META.USER.label },
                    { value: 'ACCOUNT', label: AUTH_TYPE_META.ACCOUNT.label },
                  ]}
                />
              </span>
            )}
            <span>
              <b style={{ fontWeight: 500 }}>生效范围：</b>
              {entryMeta.coverage}
            </span>
            <span>
              <b style={{ fontWeight: 500 }}>权限：</b>
              {grant.scopes.join('、') || '—'}
            </span>
            <span>
              <b style={{ fontWeight: 500 }}>access_token 到期：</b>
              {dayjs(grant.accessTokenExpiresAt).format('MM-DD HH:mm')}
            </span>
            <span>
              <b style={{ fontWeight: 500 }}>账户列表对齐时间：</b>
              {grant.lastSyncedAt ? dayjs(grant.lastSyncedAt).format('MM-DD HH:mm') : '—'}
            </span>
          </div>

          {entryHint && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message="这份凭证的授权入口可能不是你要的"
              description={entryHint}
            />
          )}

          {grant.lastError && (
            <div style={{ fontSize: 12, color: '#A32D2D', marginBottom: 10 }}>
              最近一次错误：{grant.lastError}
            </div>
          )}

          <Table<AccountSummary>
            rowKey="advertiserId"
            size="small"
            columns={accountColumns}
            dataSource={rows}
            pagination={rows.length > 20 ? { pageSize: 20, showSizeChanger: true } : false}
            locale={{ emptyText: '该凭证下暂无已识别的账户，可点击「对齐账户」重试' }}
          />
        </div>
      ),
    };
  };

  return (
    <div>
      <div className="page-header">
        <h2>账户管理</h2>
        <p>
          按授权凭证分组。一次授权 = 一份凭证 = 一个 token，可能覆盖多个广告账户；
          刷新 token 时该凭证下所有账户同时生效
        </p>
      </div>

      <div className="metric-grid">
        <div className="metric-card">
          <div className="label">授权凭证</div>
          <div className="value">
            {list.length}
            <span className="unit">份</span>
          </div>
        </div>
        <div className="metric-card">
          <div className="label">已纳管账户</div>
          <div className="value">
            {allAccounts.length}
            <span className="unit">个</span>
          </div>
        </div>
        <div className="metric-card">
          <div className="label">启用中账户</div>
          <div className="value">
            {activeAccounts}
            <span className="unit">个</span>
          </div>
        </div>
        <div className="metric-card">
          <div className="label">需重新授权</div>
          <div className="value" style={{ color: needReauth > 0 ? '#A32D2D' : undefined }}>
            {needReauth}
            <span className="unit">份</span>
          </div>
        </div>
        <div className="metric-card">
          <div className="label">7 天内到期</div>
          <div className="value" style={{ color: expiringSoon > 0 ? '#854F0B' : undefined }}>
            {expiringSoon}
            <span className="unit">份</span>
          </div>
        </div>
        <div className="metric-card">
          <div className="label">代投白名单</div>
          <div className="value" style={{ color: readOnlyCount > 0 ? '#B25E09' : undefined }}>
            {readOnlyCount}
            <span className="unit">个</span>
          </div>
        </div>
      </div>

      <Card
        size="small"
        style={{ marginBottom: 16 }}
        title={
          <Space size={8}>
            <TeamOutlined style={{ color: '#B25E09' }} />
            <span>代投白名单</span>
            <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
              白名单内账户只能查看数据（盯盘/报表），不能上计划、调预算、调整计划
            </Typography.Text>
          </Space>
        }
        extra={
          <Space>
            {readOnlyCount > 0 && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                当前 {readOnlyCount} 个账户
              </Typography.Text>
            )}
            <Button size="small" type="primary" ghost onClick={openWhitelist}>
              管理白名单
            </Button>
          </Space>
        }
      >
        {readOnlyCount === 0 ? (
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            还没有账户加入白名单。点击「管理白名单」勾选代投账户，或直接在下方账户列表点「加入代投」。
          </Typography.Text>
        ) : (
          <Space wrap size={4}>
            {allAccounts
              .filter((a) => a.readOnly)
              .map((a) => (
                <Tag
                  key={a.advertiserId}
                  color="orange"
                  closable
                  onClose={(e) => {
                    e.preventDefault();
                    setReadOnlyMutation.mutate({ ids: [a.advertiserId], readOnly: false });
                  }}
                >
                  {a.accountName ?? a.advertiserId}
                </Tag>
              ))}
          </Space>
        )}
      </Card>

      <Card
        size="small"
        title="授权凭证与账户"
        extra={
          <Space>
            <Tooltip title="对所有凭证重新拉取账户列表">
              <Button
                size="small"
                icon={<SyncOutlined />}
                loading={resyncMutation.isPending}
                onClick={() => resyncMutation.mutate(undefined)}
              >
                全部对齐
              </Button>
            </Tooltip>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              onClick={() => {
                void queryClient.invalidateQueries({ queryKey: ['oauth-grants'] });
                void queryClient.invalidateQueries({ queryKey: ['oauth-accounts'] });
              }}
            >
              刷新列表
            </Button>
          </Space>
        }
      >
        {list.length === 0 && !grantsLoading ? (
          <Empty description="还没有授权凭证。请到「接入设置」生成授权链接，用磁力罗盘或广告账户完成授权" />
        ) : (
          <Spin spinning={grantsLoading || accountsLoading}>
            <Collapse
              defaultActiveKey={list.length === 1 ? [String(list[0].id)] : undefined}
              items={list.map(renderGrantPanel)}
            />
          </Spin>
        )}
      </Card>

      <Modal
        title="管理代投白名单"
        open={whitelistOpen}
        onCancel={() => setWhitelistOpen(false)}
        width={720}
        onOk={() => void saveWhitelist()}
        okText="保存"
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="勾选的账户加入白名单：仅可查看数据，不能上计划、调预算、调整计划。盯盘看板不受影响。"
        />
        <Input
          allowClear
          placeholder="搜索账户名称或账户 ID"
          style={{ marginBottom: 10 }}
          value={wlKeyword}
          onChange={(e) => setWlKeyword(e.target.value)}
        />
        <div style={{ marginBottom: 8, fontSize: 12, color: '#888780' }}>
          已勾选 {wlChecked.size} / {allAccounts.length} 个账户
          <Typography.Link
            style={{ fontSize: 12, marginLeft: 12 }}
            onClick={(e) => {
              e.preventDefault();
              setWlChecked(new Set(wlFiltered.map((a) => a.advertiserId)));
            }}
          >
            全选筛选结果
          </Typography.Link>
          <Typography.Link
            style={{ fontSize: 12, marginLeft: 8 }}
            onClick={(e) => {
              e.preventDefault();
              setWlChecked(new Set());
            }}
          >
            清空
          </Typography.Link>
        </div>
        <Table<AccountSummary>
          rowKey="advertiserId"
          size="small"
          columns={[
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
              title: '所属凭证',
              dataIndex: 'grantLabel',
              width: 220,
              render: (v: string | null, row) => (
                <span style={{ fontSize: 12 }}>{v ?? `#${row.grantId}`}</span>
              ),
            },
          ]}
          dataSource={wlFiltered}
          rowSelection={{
            selectedRowKeys: wlFiltered
              .map((a) => a.advertiserId)
              .filter((id) => wlChecked.has(id)),
            onSelect: (row, on) =>
              setWlChecked((prev) => {
                const next = new Set(prev);
                if (on) next.add(row.advertiserId);
                else next.delete(row.advertiserId);
                return next;
              }),
            onSelectAll: (on) =>
              setWlChecked((prev) => {
                const next = new Set(prev);
                for (const a of wlFiltered) {
                  if (on) next.add(a.advertiserId);
                  else next.delete(a.advertiserId);
                }
                return next;
              }),
          }}
          pagination={wlFiltered.length > 10 ? { pageSize: 10, showSizeChanger: false } : false}
          locale={{ emptyText: '没有符合条件的账户' }}
        />
      </Modal>
    </div>
  );
}
