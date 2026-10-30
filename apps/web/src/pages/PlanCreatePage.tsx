import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Divider,
  Drawer,
  Input,
  Popconfirm,
  Row,
  Segmented,
  Select,
  Space,
  Statistic,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  SaveOutlined,
  CheckCircleOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  AccountSummary,
  CAMPAIGN_TYPE,
  CAMPAIGN_TYPE_META,
  DEFAULT_INITIAL_STATUS,
  InitialStatus,
  PlanDraftView,
  PlanRow,
  PlanRowIssue,
  PlanValidateResult,
} from '@wkbd/shared';
import { api, explainError } from '../api/client';
import { PlanCardMode, type CardForm } from './plan/PlanCardMode';
import { AccountPickerModal } from './plan/AccountPickerModal';
import { rowsToCardForm } from './plan/rowsToForm';

/**
 * 上计划：卡片式批量创编（2026-09-25 起表格模式已移除——
 * 摘要卡 + 编辑抽屉 + 三层预览树表已完整覆盖逐行微调的场景）。
 *
 * 保留的设计选择：
 * 1. **营销目标决定可用链路参数**。应用安装要 app_id、销售线索要落地页。
 * 2. **提交前必须过校验**。300 次平台调用的代价太高，参数错必须本地拦住。
 */

/** 用户选定的投放形态（决定可用链路参数） */
const SUPPORTED_TYPES = [2, 7, 5];

export default function PlanCreatePage() {
  const { message, modal } = App.useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();

  const [campaignType, setCampaignType] = useState<number>(2);
  const [rows, setRows] = useState<PlanRow[]>([]);
  const [taskName, setTaskName] = useState('批量上计划');
  const [draftId, setDraftId] = useState<number | undefined>();
  const [validated, setValidated] = useState<PlanValidateResult | null>(null);
  // 策略组：整份投放配置（表单快照）可随时保存/修改/另存为，方便不同投放方式复用
  const [loadSignal, setLoadSignal] = useState<{
    token: number;
    form: Partial<CardForm> & { __videos?: string[] };
  } | null>(null);
  const strategyRef = useRef<(CardForm & { __videos?: string[] }) | null>(null);
  // 创建后置状态。默认「暂停」：批量 100 条一旦默认投放，就是真实预算风险
  const [initialStatus, setInitialStatus] = useState<InitialStatus>(DEFAULT_INITIAL_STATUS);
  // 错误定位：报错弹窗 / 校验结果点击某条错误后，滚动高亮对应创意组卡片，
  // 带 field 时再打开对应编辑抽屉并高亮出错的表单项
  const [locate, setLocate] = useState<{ rowNo: number; field?: string | null } | null>(null);
  const locateRow = (rowNo: number, field?: string | null) => setLocate({ rowNo, field });

  const { data: accounts } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => api.get<AccountSummary[]>('/api/oauth/accounts'),
  });
  const { data: drafts } = useQuery({
    queryKey: ['plan-drafts'],
    queryFn: () => api.get<PlanDraftView[]>('/api/plan/drafts'),
  });

  const usableAccounts = useMemo(
    () =>
      (accounts ?? []).filter(
        (a) =>
          (a.status === 'ACTIVE' || a.status === 'NEED_REFRESH') &&
          // 代投白名单（只读）账户只能看数据，不参与上计划
          !a.readOnly,
      ),
    [accounts],
  );

  /* ---------------- 参与投放的账户选择 ---------------- */

  /** null = 全部可用账户（默认）；数组 = 手动勾选的账户 */
  const [selectedIds, setSelectedIds] = useState<string[] | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const planAccounts = useMemo(
    () =>
      selectedIds === null
        ? usableAccounts
        : usableAccounts.filter((a) => selectedIds.includes(a.advertiserId)),
    [usableAccounts, selectedIds],
  );

  /* ---------------- 复制任务：批量任务页跳转过来，回填任务创建时的投放配置 ---------------- */

  const copyFromTask = (location.state as { copyFromTask?: number } | null)?.copyFromTask ?? null;
  useEffect(() => {
    if (!copyFromTask) return;
    // 先清掉 history state，防止刷新页面重复载入
    navigate('/plan', { replace: true, state: null });
    api
      .get<{ rows: PlanRow[]; campaignType: number }>(`/api/plan/tasks/${copyFromTask}/source`)
      .then(({ rows, campaignType }) => {
        setCampaignType(campaignType);
        setDraftId(undefined);
        setValidated(null);
        setRows([]);
        setLoadSignal((prev) => ({ token: (prev?.token ?? 0) + 1, form: rowsToCardForm(rows) }));
        message.success(
          `已载入任务 #${copyFromTask} 的投放配置，计划名若与平台已有计划重复会自动加序号去重，点「预览生成」后可直接提交`,
        );
      })
      .catch((err) => {
        modal.error({ title: '复制任务配置失败', content: explainError(err) });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [copyFromTask]);

  const typeMeta = CAMPAIGN_TYPE_META[campaignType];

  /* ---------------- 校验与提交 ---------------- */

  const validateMutation = useMutation({
    mutationFn: () => api.post<PlanValidateResult>('/api/plan/validate', { rows }),
    onSuccess: (result) => {
      setValidated(result);
      if (result.errorCount === 0) {
        message.success(`校验通过${result.warnCount ? `（${result.warnCount} 处提醒）` : ''}`);
      } else {
        message.error(`发现 ${result.errorCount} 处错误，已在表格中标出`);
      }
    },
    onError: (err) => modal.error({ title: '校验失败', content: explainError(err) }),
  });

  const submitMutation = useMutation({
    mutationFn: (dryRun: boolean) =>
      api.post<{ id: number }>('/api/plan/tasks', {
        name: taskName,
        rows,
        dryRun,
        draftId,
        initialStatus,
      }),
    onSuccess: (task) => {
      queryClient.invalidateQueries({ queryKey: ['plan-tasks'] });
      message.success('任务已提交，正在后台执行');
      navigate(`/tasks?highlight=${task.id}`);
    },
    onError: (err) => {
      const issues = ((err as { issues?: PlanRowIssue[] }).issues ?? []).filter(
        (i) => i && typeof i.rowNo === 'number',
      );
      const handle = modal.error({
        title: '提交被拒绝',
        width: 640,
        content: (
          <div>
            <p>{explainError(err)}</p>
            {issues.length > 0 ? (
              <>
                <div style={{ fontSize: 12, color: '#888780', marginBottom: 6 }}>
                  点击错误项可跳转到对应创意组卡片：
                </div>
                <ul style={{ paddingLeft: 18, marginBottom: 0, maxHeight: 280, overflow: 'auto' }}>
                  {issues.map((i, idx) => (
                    <li key={idx} style={{ fontSize: 13, marginBottom: 4 }}>
                      <a
                        onClick={() => {
                          handle.destroy();
                          locateRow(i.rowNo, i.field);
                        }}
                      >
                        第 {i.rowNo} 行（{levelLabel(i.level)}）：{i.message}
                      </a>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
        ),
      });
    },
  });

  /* ---------------- 策略组（原草稿）：整份投放配置随时保存/修改/复用 ---------------- */

  const saveStrategyMutation = useMutation({
    mutationFn: (input: { id?: number; name: string }) => {
      const formJson = JSON.stringify(strategyRef.current ?? {});
      return input.id
        ? api.put<PlanDraftView>(`/api/plan/drafts/${input.id}`, {
            name: input.name,
            campaignType,
            rows,
            formJson,
          })
        : api.post<PlanDraftView>('/api/plan/drafts', {
            name: input.name,
            campaignType,
            rows,
            formJson,
          });
    },
    onSuccess: (draft, input) => {
      setDraftId(draft.id);
      queryClient.invalidateQueries({ queryKey: ['plan-drafts'] });
      message.success(input.id ? `策略组「${draft.name}」已更新` : `策略组「${draft.name}」已保存`);
    },
    onError: (err) => modal.error({ title: '保存失败', content: explainError(err) }),
  });

  /** 保存策略组：已载入某组 → 直接覆盖更新；否则弹窗命名另存 */
  const saveStrategy = () => {
    if (draftId) {
      const current = (drafts ?? []).find((d) => d.id === draftId);
      saveStrategyMutation.mutate({ id: draftId, name: current?.name ?? '策略组' });
      return;
    }
    let name = '';
    modal.confirm({
      title: '保存策略组',
      content: (
        <Input
          placeholder="策略组名称，如：应用安装-自动出价-优量选版"
          onChange={(e) => {
            name = e.target.value;
          }}
        />
      ),
      onOk: () =>
        saveStrategyMutation.mutateAsync({
          name: name.trim() || `策略组 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
        }),
    });
  };

  const saveStrategyAs = () => {
    let name = '';
    modal.confirm({
      title: '另存为新策略组',
      content: (
        <Input
          placeholder="新策略组名称"
          onChange={(e) => {
            name = e.target.value;
          }}
        />
      ),
      onOk: () =>
        saveStrategyMutation.mutateAsync({
          name: name.trim() || `策略组 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
        }),
    });
  };

  const deleteStrategy = useMutation({
    mutationFn: (id: number) => api.del(`/api/plan/drafts/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plan-drafts'] });
      setDraftId(undefined);
      message.success('策略组已删除');
    },
  });

  const loadStrategy = (draft: PlanDraftView) => {
    setDraftId(draft.id);
    setCampaignType(draft.campaignType);
    setValidated(null);
    if (draft.formJson) {
      try {
        const form = JSON.parse(draft.formJson) as Partial<CardForm> & { __videos?: string[] };
        setLoadSignal((prev) => ({ token: (prev?.token ?? 0) + 1, form }));
        setRows([]);
        message.success(`已载入策略组「${draft.name}」，点击「预览生成」即可按当前配置生成`);
        return;
      } catch {
        // 快照损坏则退回旧行为
      }
    }
    setRows(draft.rows);
    message.success(`已载入「${draft.name}」的历史行数据（该策略组无表单快照）`);
  };

  const totalErrors = validated?.errorCount ?? 0;

  return (
    <div>
      <Card
        size="small"
        style={{ marginBottom: 12, borderRadius: 10 }}
        title="投放设置"
        extra={
          <Space>
            <Select
              size="small"
              placeholder="载入策略组"
              style={{ width: 180 }}
              value={undefined}
              options={(drafts ?? []).map((d) => ({
                value: d.id,
                label: d.name,
              }))}
              onSelect={(id) => {
                const draft = (drafts ?? []).find((d) => d.id === id);
                if (draft) loadStrategy(draft);
              }}
            />
            <Button
              size="small"
              icon={<SaveOutlined />}
              onClick={saveStrategy}
              loading={saveStrategyMutation.isPending}
            >
              保存策略组
            </Button>
            {draftId && (
              <>
                <Button size="small" onClick={saveStrategyAs}>
                  另存为
                </Button>
                <Popconfirm
                  title="删除这个策略组？"
                  description="只删除保存的配置，不影响已创建的广告"
                  onConfirm={() => deleteStrategy.mutate(draftId)}
                >
                  <Button size="small" danger>
                    删除
                  </Button>
                </Popconfirm>
              </>
            )}
          </Space>
        }
      >
        <Row gutter={16} align="middle">
          <Col span={7}>
            <div style={{ fontSize: 12, color: '#888780', marginBottom: 4 }}>营销目标</div>
            <Select
              style={{ width: '100%' }}
              value={campaignType}
              onChange={(v) => {
                setCampaignType(v);
                setValidated(null);
              }}
              options={SUPPORTED_TYPES.map((code) => ({
                value: code,
                label: CAMPAIGN_TYPE[code],
              }))}
            />
          </Col>
          <Col span={7}>
            <div style={{ fontSize: 12, color: '#888780', marginBottom: 4 }}>任务名称</div>
            <Input value={taskName} onChange={(e) => setTaskName(e.target.value)} />
          </Col>
          <Col span={10}>
            <div style={{ fontSize: 12, color: '#888780', marginBottom: 4 }}>投放账户</div>
            <Space wrap size={8}>
              {usableAccounts.length === 0 ? (
                <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                  还没有可用账户，请先到「账户管理」授权
                </Typography.Text>
              ) : (
                <>
                  <Button onClick={() => setPickerOpen(true)}>
                    {selectedIds === null
                      ? `全部账户（${usableAccounts.length}）`
                      : `已选 ${planAccounts.length} / ${usableAccounts.length} 个账户`}
                  </Button>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {selectedIds === null
                      ? '默认全部账户参与投放，点击可挑选'
                      : '将在这几个账户上批量创建计划'}
                  </Typography.Text>
                </>
              )}
            </Space>
          </Col>
        </Row>
        {typeMeta?.note && (
          <Alert
            style={{ marginTop: 12 }}
            type="info"
            showIcon
            message={`${typeMeta.label}：${typeMeta.note}`}
          />
        )}
      </Card>

      <PlanCardMode
        campaignType={campaignType}
        accounts={planAccounts}
        hasRows={rows.length}
        locate={locate}
        strategyRef={strategyRef}
        loadSignal={loadSignal}
        onGenerate={(generated) => {
          setRows(generated);
          setValidated(null);
          message.success(`已生成 ${generated.length} 行，可直接「提交前校验」或提交创建`);
        }}
      />

      {validated && (
        <Card size="small" style={{ marginTop: 12, borderRadius: 10 }} title="校验结果">
          <Row gutter={16}>
            <Col span={5}>
              <Statistic title="总行数" value={validated.rows} />
            </Col>
            <Col span={5}>
              <Statistic
                title="错误"
                value={validated.errorCount}
                valueStyle={{ color: validated.errorCount ? '#A32D2D' : '#0F6E56' }}
              />
            </Col>
            <Col span={5}>
              <Statistic title="提醒" value={validated.warnCount} />
            </Col>
            <Col span={9}>
              <div style={{ fontSize: 12, color: '#888780', marginBottom: 4 }}>
                本次将创建的实体（按账户）
              </div>
              <Space wrap size={4}>
                {validated.perAccount.map((p) => (
                  <Tag key={p.advertiserId}>
                    {p.accountName ?? p.advertiserId}：计划 {p.campaigns} / 组 {p.units} / 创意{' '}
                    {p.creatives}（今日已建 {p.createdToday}）
                  </Tag>
                ))}
              </Space>
            </Col>
          </Row>
          {validated.issues.length > 0 && (
            <>
              <Divider style={{ margin: '12px 0' }} />
              <div style={{ maxHeight: 180, overflow: 'auto' }}>
                {validated.issues.slice(0, 100).map((issue, idx) => (
                  <div
                    key={idx}
                    style={{ fontSize: 13, marginBottom: 4, cursor: 'pointer' }}
                    onClick={() => locateRow(issue.rowNo, issue.field)}
                  >
                    <Tag color={issue.severity === 'ERROR' ? 'error' : 'warning'}>
                      {issue.severity === 'ERROR' ? '错误' : '提醒'}
                    </Tag>
                    <b>第 {issue.rowNo} 行</b>
                    <span style={{ color: '#888780' }}> · {levelLabel(issue.level)} · </span>
                    {issue.message}
                    <Typography.Link style={{ fontSize: 12, marginLeft: 8 }}>
                      定位
                    </Typography.Link>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>
      )}

      <div
        style={{
          position: 'sticky',
          bottom: 0,
          marginTop: 12,
          padding: '12px 16px',
          background: '#fff',
          border: '1px solid #E8E6E1',
          borderRadius: 10,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <Tooltip
          title={
            <div style={{ fontSize: 12, lineHeight: 1.7 }}>
              <div>
                <b>暂停（推荐）</b>：计划创建成功后立即置为暂停，组和创意默认开启（计划暂停不会消耗）。
                审核通过后由你在快手后台开启计划即可整条投放。
              </div>
              <div style={{ marginTop: 4 }}>
                <b>直接投放</b>：计划、组、创意都按投放中创建，即刻进入投放。
              </div>
            </div>
          }
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              paddingRight: 12,
              borderRight: '1px solid #E8E6E1',
            }}
          >
            <Typography.Text style={{ fontSize: 13, color: '#888780', whiteSpace: 'nowrap' }}>
              创建后
            </Typography.Text>
            <Segmented
              size="small"
              value={initialStatus}
              onChange={(value) => setInitialStatus(value as InitialStatus)}
              options={[
                { label: '暂停（推荐）', value: 'PAUSED' },
                { label: '直接投放', value: 'RUNNING' },
              ]}
            />
          </div>
        </Tooltip>

        <Button
          icon={<CheckCircleOutlined />}
          onClick={() => validateMutation.mutate()}
          loading={validateMutation.isPending}
          disabled={rows.length === 0}
        >
          提交前校验
        </Button>
        <Tooltip title="不调用平台接口，只走本地校验流程，用来验证表格结构">
          <Button
            onClick={() => submitMutation.mutate(true)}
            loading={submitMutation.isPending}
            disabled={rows.length === 0}
          >
            干跑（不创建）
          </Button>
        </Tooltip>
        <Popconfirm
          title={`确认提交 ${rows.length} 行？`}
          description={
            <div style={{ maxWidth: 340 }}>
              将创建 {rows.length * 3} 个实体（计划 / 广告组 / 创意 各 {rows.length} 个），创建后不可撤销。
              {initialStatus === 'PAUSED'
                ? '本次为「暂停」创建，不会立即消耗预算。'
                : '⚠️ 本次为「直接投放」创建，审核通过后将立即开始投放。'}
            </div>
          }
          onConfirm={() => submitMutation.mutate(false)}
          disabled={rows.length === 0 || totalErrors > 0}
        >
          <Button
            type="primary"
            danger={initialStatus === 'RUNNING'}
            disabled={rows.length === 0 || totalErrors > 0}
          >
            提交创建（{rows.length} 行）
          </Button>
        </Popconfirm>
        {totalErrors > 0 && (
          <Typography.Text type="danger" style={{ fontSize: 13 }}>
            有 {totalErrors} 处错误未修正，无法提交
          </Typography.Text>
        )}
      </div>
      <AccountPickerModal
        open={pickerOpen}
        accounts={usableAccounts}
        initialSelected={selectedIds}
        onClose={() => setPickerOpen(false)}
        onOk={(ids) => {
          setSelectedIds(ids);
          setPickerOpen(false);
        }}
      />

    </div>
  );
}

function levelLabel(level: string): string {
  return level === 'CAMPAIGN' ? '计划' : level === 'UNIT' ? '广告组' : level === 'CREATIVE' ? '创意' : '整行';
}
