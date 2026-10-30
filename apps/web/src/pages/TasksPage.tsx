import { useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Empty,
  Popconfirm,
  Progress,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  ReloadOutlined,
  SafetyCertificateOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  BatchTaskDetail,
  BatchTaskItemView,
  BatchTaskSummary,
  TASK_STATUS_META,
  VERIFY_STATUS_META,
} from '@wkbd/shared';
import { api, explainError } from '../api/client';

/**
 * 批量任务页。
 *
 * 这个页面的核心不是「展示进度」，而是**让失败可处置**：
 * - 失败条目的错误码 + 错误分类要能直接指导下一步动作
 * - 「只重试失败项」必须是一等公民（100 条废了 3 条，不该重跑 100 条）
 * - 验证类错误（参数/权限）不该重复重试，重试前就该告诉用户去改什么
 */

const LEVEL_META: Record<string, { text: string; color: string }> = {
  CAMPAIGN: { text: '计划', color: 'blue' },
  UNIT: { text: '广告组', color: 'geekblue' },
  CREATIVE: { text: '创意', color: 'purple' },
};

const ITEM_STATUS_META: Record<string, { text: string; color: string }> = {
  PENDING: { text: '待执行', color: 'default' },
  RUNNING: { text: '执行中', color: 'processing' },
  SUCCEEDED: { text: '成功', color: 'success' },
  FAILED: { text: '失败', color: 'error' },
  SKIPPED: { text: '已跳过', color: 'warning' },
};

/** 计划级汇总状态（一次提交 = 一条计划，明细展开才看到组/创意） */
const PLAN_STATUS_META: Record<string, { text: string; color: string }> = {
  SUCCEEDED: { text: '成功', color: 'success' },
  FAILED: { text: '失败', color: 'error' },
  RUNNING: { text: '执行中', color: 'processing' },
  PARTIAL: { text: '部分成功', color: 'warning' },
};

/** 详情里一条计划（含其组/创意子行）的展示形态 */
type PlanNode = BatchTaskItemView & {
  rollupStatus?: string;
  firstError?: string | null;
  children?: BatchTaskItemView[];
};

/** 把条目按提交行归组：一行 = 一条计划，计划行下挂组/创意子行 */
function groupByPlan(items: BatchTaskItemView[]): PlanNode[] {
  const byRow = new Map<number, BatchTaskItemView[]>();
  for (const it of items) {
    const list = byRow.get(it.rowNo) ?? [];
    list.push(it);
    byRow.set(it.rowNo, list);
  }
  return [...byRow.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rowNo, group]) => {
      const camp = group.find((g) => g.level === 'CAMPAIGN') ?? group[0];
      const rest = group.filter((g) => g.id !== camp.id).sort((a, b) => a.seq - b.seq);
      const hasPending = group.some((g) => g.status === 'PENDING' || g.status === 'RUNNING');
      const rollupStatus =
        camp.status === 'FAILED'
          ? 'FAILED'
          : group.every((g) => g.status === 'SUCCEEDED')
            ? 'SUCCEEDED'
            : hasPending
              ? 'RUNNING'
              : 'PARTIAL';
      const firstError = group.find((g) => g.errorMessage)?.errorMessage ?? null;
      return {
        ...camp,
        rowNo,
        rollupStatus,
        firstError,
        children: rest.length > 0 ? rest : undefined,
      };
    });
}

/** 该错误重试有用吗——把「该改参数」和「该重试」区分开，避免用户白等 */
function retryAdvice(kind: string | null): string | null {
  switch (kind) {
    case 'PARAM':
      return '参数不合法，重试同样会失败。请修正对应行的填写内容后重新提交。';
    case 'PERMISSION':
      return '账户缺少该能力权限（或需加白），需联系快手运营处理后才能重试。';
    case 'TOKEN_INVALID':
      return '授权已失效，请到「账户管理」重新授权后再重试。';
    case 'DEPENDENCY':
      return '父级实体未创建成功。修正父级行后一起重试即可。';
    case 'RETRYABLE':
      return '平台临时繁忙或限流，直接重试即可。';
    default:
      return null;
  }
}

export default function TasksPage() {
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const highlight = Number(params.get('highlight') ?? 0);
  const [selectedId, setSelectedId] = useState<number | null>(highlight || null);

  const { data: tasks, isLoading } = useQuery({
    queryKey: ['plan-tasks'],
    queryFn: () => api.get<BatchTaskSummary[]>('/api/plan/tasks'),
    // 任务在执行中，进度必须能自己动起来
    refetchInterval: 4000,
  });

  const { data: detail } = useQuery({
    queryKey: ['plan-task', selectedId],
    queryFn: () => api.get<BatchTaskDetail>(`/api/plan/tasks/${selectedId}`),
    enabled: Boolean(selectedId),
    refetchInterval: 4000,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['plan-tasks'] });
    if (selectedId) queryClient.invalidateQueries({ queryKey: ['plan-task', selectedId] });
  };

  const retryMutation = useMutation({
    mutationFn: (id: number) => api.post(`/api/plan/tasks/${id}/retry-failed`),
    onSuccess: () => {
      message.success('已重新入队，只跑失败与跳过的条目');
      invalidate();
    },
    onError: (err) => modal.error({ title: '重试失败', content: explainError(err) }),
  });

  const verifyMutation = useMutation({
    mutationFn: (id: number) =>
      api.post<{ checked: number; ok: number; mismatch: number; missing: number }>(
        `/api/plan/tasks/${id}/verify`,
      ),
    onSuccess: (r) => {
      message.success(
        `核验完成：${r.checked} 项 → 通过 ${r.ok} / 不一致 ${r.mismatch} / 平台查不到 ${r.missing}`,
      );
      invalidate();
    },
    onError: (err) => modal.error({ title: '核验失败', content: explainError(err) }),
  });

  const controlMutation = useMutation({
    mutationFn: ({ id, action }: { id: number; action: 'pause' | 'resume' }) =>
      api.post(`/api/plan/tasks/${id}/${action}`),
    onSuccess: () => invalidate(),
    onError: (err) => modal.error({ title: '操作失败', content: explainError(err) }),
  });

  /**
   * 复制任务：跳转到「上计划」并回填创建时的投放配置（不直接提交）。
   * 用户在上计划页修改配置后自己点「预览生成 → 提交」，防止误发预算。
   */
  const copyToPlan = (row: BatchTaskSummary) => {
    navigate('/plan', { state: { copyFromTask: row.id } });
  };

  /** 删除任务：仅从列表隐藏，平台实体不受影响 */
  const deleteTaskMutation = useMutation({
    mutationFn: (id: number) => api.del(`/api/plan/tasks/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plan-tasks'] });
      message.success('已从历史列表删除（仅删除显示，平台广告不受影响）');
    },
    onError: (err) => modal.error({ title: '删除失败', content: explainError(err) }),
  });

  const planRows = useMemo(() => (detail ? groupByPlan(detail.items) : []), [detail]);

  /** 树表列：计划行显示汇总状态，展开后的子行显示各层级明细 */
  const planColumns = [
    {
      title: '计划 / 明细',
      dataIndex: 'displayName',
      ellipsis: true,
      render: (name: string | null, row: PlanNode) => (
        <Space size={6}>
          {row.level !== 'CAMPAIGN' && (
            <Tag color={LEVEL_META[row.level]?.color ?? 'default'}>
              {LEVEL_META[row.level]?.text ?? row.level}
            </Tag>
          )}
          <span>{name}</span>
        </Space>
      ),
    },
    { title: '账户', dataIndex: 'advertiserId', width: 110 },
    {
      title: '状态',
      width: 100,
      render: (_: unknown, row: PlanNode) => {
        const meta = row.rollupStatus
          ? (PLAN_STATUS_META[row.rollupStatus] ?? { text: row.rollupStatus, color: 'default' })
          : (ITEM_STATUS_META[row.status] ?? { text: row.status, color: 'default' });
        return <Tag color={meta.color}>{meta.text}</Tag>;
      },
    },
    {
      title: '核验',
      dataIndex: 'verifyStatus',
      width: 96,
      render: (status: string) => {
        const meta = VERIFY_STATUS_META[status] ?? { text: status, color: 'default' };
        return (
          <Tooltip title={meta.hint}>
            <Tag color={meta.color}>{meta.text}</Tag>
          </Tooltip>
        );
      },
    },
    {
      title: '平台 ID',
      dataIndex: 'platformId',
      width: 130,
      render: (id: string | null) => id ?? '—',
    },
    {
      title: '失败原因',
      render: (_: unknown, row: PlanNode) => {
        const msg = row.firstError ?? row.errorMessage;
        return msg ? (
          <div style={{ fontSize: 12 }}>
            <div style={{ color: '#A32D2D' }}>{msg}</div>
            {retryAdvice(row.errorKind) && (
              <div style={{ color: '#888780', marginTop: 2 }}>{retryAdvice(row.errorKind)}</div>
            )}
          </div>
        ) : (
          <span style={{ color: '#B4B2A9' }}>—</span>
        );
      },
    },
  ];

  return (
    <div>
      <Card
        size="small"
        style={{ borderRadius: 10, marginBottom: 12 }}
        title="批量任务"
        extra={
          <Button size="small" icon={<ReloadOutlined />} onClick={() => invalidate()}>
            刷新
          </Button>
        }
      >
        <Table
          size="small"
          rowKey="id"
          loading={isLoading}
          dataSource={tasks ?? []}
          pagination={{ pageSize: 10, hideOnSinglePage: true }}
          rowClassName={(row) => (row.id === selectedId ? 'plan-row-selected' : '')}
          onRow={(row) => ({ onClick: () => setSelectedId(row.id), style: { cursor: 'pointer' } })}
          columns={[
            { title: '任务', dataIndex: 'name', ellipsis: true },
            {
              title: '状态',
              dataIndex: 'status',
              width: 110,
              render: (status: string) => {
                const meta = TASK_STATUS_META[status] ?? { text: status, color: 'default', hint: '' };
                return (
                  <Tooltip title={meta.hint}>
                    <Tag color={meta.color}>{meta.text}</Tag>
                  </Tooltip>
                );
              },
            },
            {
              title: '创建后',
              dataIndex: 'initialStatus',
              width: 96,
              render: (value: string) =>
                value === 'RUNNING' ? (
                  <Tooltip title="创建后即进入投放（审核通过后生效）">
                    <Tag color="red">投放中</Tag>
                  </Tooltip>
                ) : (
                  <Tooltip title="创建后置为暂停，复核后再手动启用">
                    <Tag>暂停</Tag>
                  </Tooltip>
                ),
            },
            {
              title: '进度',
              width: 200,
              render: (_, row) => {
                // 一次提交 = 一个任务：进度按「计划」计数，组/创意明细收进详情
                const done = row.planSucceeded + row.planFailed;
                const percent = row.planTotal ? Math.round((done / row.planTotal) * 100) : 0;
                return (
                  <div>
                    <Progress
                      percent={percent}
                      size="small"
                      status={row.planFailed > 0 ? 'exception' : undefined}
                    />
                    <div style={{ fontSize: 12, color: '#888780' }}>
                      成功 {row.planSucceeded} · 失败 {row.planFailed} / 共 {row.planTotal} 个计划
                    </div>
                  </div>
                );
              },
            },
            { title: '账户', dataIndex: 'accountCount', width: 70 },
            {
              title: '创建时间',
              dataIndex: 'createdAt',
              width: 150,
              render: (v: string) => new Date(v).toLocaleString('zh-CN', { hour12: false }),
            },
            {
              title: '操作',
              width: 150,
              render: (_, row) => (
                <Space size={4} onClick={(e) => e.stopPropagation()}>
                  <Typography.Link
                    style={{ fontSize: 12 }}
                    onClick={() => setSelectedId(row.id)}
                  >
                    详情
                  </Typography.Link>
                  <Tooltip title="把该任务创建时的投放配置带回「上计划」，修改后重新生成提交">
                    <Typography.Link
                      style={{ fontSize: 12 }}
                      onClick={() => copyToPlan(row)}
                    >
                      复制
                    </Typography.Link>
                  </Tooltip>
                  <Popconfirm
                    title="从历史列表删除该任务？"
                    description="仅删除本工具内的显示记录，平台上的广告不受影响。"
                    okText="删除"
                    onConfirm={() => deleteTaskMutation.mutate(row.id)}
                  >
                    <Typography.Link type="danger" style={{ fontSize: 12 }}>
                      删除
                    </Typography.Link>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      {!selectedId && (
        <Card size="small" style={{ borderRadius: 10 }}>
          <Empty description="选择上方任务查看执行明细" />
        </Card>
      )}

      {selectedId && detail && (
        <Card
          size="small"
          style={{ borderRadius: 10 }}
          title={`任务 #${detail.id} 执行明细`}
          extra={
            <Space>
              {detail.status === 'RUNNING' && (
                <Button
                  size="small"
                  icon={<PauseCircleOutlined />}
                  onClick={() => controlMutation.mutate({ id: detail.id, action: 'pause' })}
                >
                  暂停
                </Button>
              )}
              {(detail.status === 'PAUSED' || detail.status === 'PENDING') && (
                <Button
                  size="small"
                  icon={<PlayCircleOutlined />}
                  onClick={() => controlMutation.mutate({ id: detail.id, action: 'resume' })}
                >
                  继续
                </Button>
              )}
              <Tooltip title="回读平台数据，确认实体真实存在且关键字段一致">
                <Button
                  size="small"
                  icon={<SafetyCertificateOutlined />}
                  loading={verifyMutation.isPending}
                  onClick={() => verifyMutation.mutate(detail.id)}
                  disabled={detail.succeeded === 0}
                >
                  回读核验
                </Button>
              </Tooltip>
              <Tooltip title="只重新执行失败与跳过的条目，已成功的不重发">
                <Button
                  size="small"
                  type="primary"
                  loading={retryMutation.isPending}
                  disabled={detail.failed + detail.skipped === 0}
                  onClick={() => retryMutation.mutate(detail.id)}
                >
                  重试失败项（{detail.failed + detail.skipped}）
                </Button>
              </Tooltip>
            </Space>
          }
        >
          <Descriptions size="small" column={4} style={{ marginBottom: 12 }}>
            <Descriptions.Item label="状态">
              {TASK_STATUS_META[detail.status]?.text ?? detail.status}
            </Descriptions.Item>
            <Descriptions.Item label="开始">
              {detail.startedAt ? new Date(detail.startedAt).toLocaleTimeString('zh-CN') : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="结束">
              {detail.finishedAt ? new Date(detail.finishedAt).toLocaleTimeString('zh-CN') : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="涉及账户">{detail.accountCount}</Descriptions.Item>
            <Descriptions.Item label="创建后">
              {detail.initialStatus === 'RUNNING' ? '直接投放' : '暂停（需手动启用）'}
            </Descriptions.Item>
          </Descriptions>

          {detail.lastError && (
            <Alert
              type={detail.lastError.startsWith('[警告]') ? 'warning' : 'error'}
              style={{ marginBottom: 12 }}
              message={detail.lastError}
            />
          )}

          {detail.failed > 0 && (
            <Typography.Paragraph style={{ fontSize: 13, color: '#888780' }}>
              一行 = 一次提交的一条计划。失败的计划点开行首箭头可看是计划/组/创意哪一层的问题；
              修好后点「重试失败项」会连同被跳过的子级一起重新执行。
            </Typography.Paragraph>
          )}

          <Table
            size="small"
            rowKey="id"
            dataSource={planRows}
            columns={planColumns as never}
            pagination={{ pageSize: 10, showSizeChanger: true }}
          />
        </Card>
      )}
    </div>
  );
}
