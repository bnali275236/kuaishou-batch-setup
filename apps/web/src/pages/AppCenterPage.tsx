import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Progress,
  Radio,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
  message,
} from 'antd';
import {
  CloudUploadOutlined,
  CopyOutlined,
  InboxOutlined,
  ReloadOutlined,
  RocketOutlined,
  ShopOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccountSummary } from '@wkbd/shared';
import { api, explainError, uploadBinary } from '../api/client';
import { BRAND } from './plan/pickers';

/**
 * 应用中心 —— 上传安装包并创建应用（B 需求）。
 *
 * 平台侧流程是硬顺序，跳步会报错，页面也按这个顺序引导：
 *   上传 APK（拿 blob_store_key） → 创建应用（审核中） → 平台审核 → 发布 → 上架
 *
 * 与「上计划」页里的「推广应用」不同：那边读的是 release/list，只含**已发布**的包；
 * 这里读的是 app/list，能看到审核中/未通过/待发布，才知道卡在哪一步。
 */

interface AppRow {
  appId: string;
  packageId: string;
  appName: string;
  packageName: string;
  version: string;
  platform: string;
  appStatus?: number;
  putStatus?: number;
  sourceType?: number;
  iconUrl?: string;
  reviewDetail?: string;
  updateTime?: string;
}

const STATUS_META: Record<number, { text: string; color: string }> = {
  1: { text: '审核中', color: 'processing' },
  2: { text: '审核未通过', color: 'error' },
  3: { text: '待发布', color: 'warning' },
  4: { text: '已发布', color: 'success' },
  5: { text: '已下架', color: 'default' },
};

interface CreateFormValues {
  appName?: string;
  category: number;
  developer: string;
  contactName: string;
  contactTel: string;
  contactEmail?: string;
  privacyUrl: string;
  recordNumber?: string;
  functionIntroduction?: string;
  networkType: number;
  sensitivePermissionDesc?: string;
  applyAge?: number;
}

export default function AppCenterPage() {
  const qc = useQueryClient();
  const [advertiserId, setAdvertiserId] = useState('');
  const [statusFilter, setStatusFilter] = useState<number | undefined>(undefined);
  const [createOpen, setCreateOpen] = useState(false);

  const accountsQuery = useQuery<AccountSummary[]>({
    queryKey: ['oauth-accounts'],
    queryFn: () => api.get<AccountSummary[]>('/api/oauth/accounts'),
  });
  const accounts = useMemo(
    () => (accountsQuery.data ?? []).filter((a) => a.status === 'ACTIVE'),
    [accountsQuery.data],
  );

  useEffect(() => {
    if (!advertiserId && accounts.length) setAdvertiserId(accounts[0].advertiserId);
  }, [accounts, advertiserId]);

  const appsQuery = useQuery<AppRow[]>({
    queryKey: ['appcenter-apps', advertiserId, statusFilter],
    queryFn: () =>
      api.get<AppRow[]>(
        `/api/appcenter/apps?advertiserId=${advertiserId}${
          statusFilter ? `&appStatus=${statusFilter}` : ''
        }`,
      ),
    enabled: Boolean(advertiserId),
    retry: false,
  });

  const releaseMutation = useMutation({
    mutationFn: (row: AppRow) =>
      api.post('/api/appcenter/apps/release', {
        advertiserId,
        packageIds: [row.packageId],
      }),
    onSuccess: () => {
      message.success('已提交发布 —— 发布成功后该应用包才能在单元里选到');
      void qc.invalidateQueries({ queryKey: ['appcenter-apps'] });
    },
    onError: (e) => Modal.error({ title: '发布失败', content: explainError(e) }),
  });

  const onlineMutation = useMutation({
    mutationFn: (p: { row: AppRow; online: boolean }) =>
      api.post('/api/appcenter/apps/online', {
        advertiserId,
        packageIds: [p.row.packageId],
        online: p.online,
      }),
    onSuccess: (_d, p) => {
      message.success(p.online ? '已申请上架' : '已申请下架');
      void qc.invalidateQueries({ queryKey: ['appcenter-apps'] });
    },
    onError: (e) => Modal.error({ title: '操作失败', content: explainError(e) }),
  });

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success('已复制');
    } catch {
      message.warning('浏览器不允许剪贴板，请手动选中复制');
    }
  };

  const columns = [
    {
      title: '应用',
      key: 'app',
      render: (_: unknown, row: AppRow) => (
        <Space size={10} align="start">
          {row.iconUrl ? (
            <img
              src={row.iconUrl}
              alt=""
              style={{ width: 36, height: 36, borderRadius: 8, objectFit: 'cover' }}
            />
          ) : (
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 8,
                background: '#F5F4F0',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 16,
              }}
            >
              📦
            </div>
          )}
          <div>
            <div style={{ fontWeight: 600 }}>{row.appName || '(未命名应用)'}</div>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {row.packageName || '—'}
              {row.sourceType === 2 && (
                <Tag style={{ marginLeft: 6, fontSize: 10 }} color="blue">
                  共享给我
                </Tag>
              )}
            </Typography.Text>
          </div>
        </Space>
      ),
    },
    {
      title: '版本',
      dataIndex: 'version',
      key: 'version',
      width: 110,
      render: (v: string) => v || '—',
    },
    {
      title: '应用包 ID',
      dataIndex: 'packageId',
      key: 'packageId',
      width: 190,
      render: (v: string) =>
        v ? (
          <Space size={4}>
            <Typography.Text style={{ fontSize: 12 }} copyable={{ text: v }}>
              {v}
            </Typography.Text>
            <Button
              type="text"
              size="small"
              icon={<CopyOutlined />}
              onClick={() => void copy(v)}
            />
          </Space>
        ) : (
          '—'
        ),
    },
    {
      title: '状态',
      key: 'status',
      width: 130,
      render: (_: unknown, row: AppRow) => {
        const meta = row.appStatus ? STATUS_META[row.appStatus] : undefined;
        return (
          <Space direction="vertical" size={0}>
            <Tag color={meta?.color ?? 'default'} style={{ marginInlineEnd: 0 }}>
              {meta?.text ?? `未知(${row.appStatus ?? '—'})`}
            </Tag>
            {row.reviewDetail && (
              <Typography.Text type="danger" style={{ fontSize: 11 }}>
                {row.reviewDetail.slice(0, 40)}
              </Typography.Text>
            )}
          </Space>
        );
      },
    },
    {
      title: '更新时间',
      dataIndex: 'updateTime',
      key: 'updateTime',
      width: 150,
      render: (v: string) => (v ? new Date(Number(v) || v).toLocaleString('zh-CN') : '—'),
    },
    {
      title: '操作',
      key: 'actions',
      width: 210,
      render: (_: unknown, row: AppRow) => (
        <Space size={4} wrap>
          {row.appStatus === 3 && (
            <Tooltip title="发布后该应用包才能在广告单元里选到">
              <Button
                size="small"
                type="primary"
                icon={<RocketOutlined />}
                loading={releaseMutation.isPending}
                onClick={() =>
                  Modal.confirm({
                    title: '发布这个应用？',
                    content: `${row.appName || row.packageId}（包 ID ${row.packageId}）`,
                    okText: '发布',
                    cancelText: '取消',
                    onOk: () => releaseMutation.mutateAsync(row),
                  })
                }
              >
                发布
              </Button>
            </Tooltip>
          )}
          {row.appStatus === 4 && (
            <Button
              size="small"
              icon={<ShopOutlined />}
              loading={onlineMutation.isPending}
              onClick={() => onlineMutation.mutate({ row, online: true })}
            >
              上架
            </Button>
          )}
          {(row.appStatus === 4 || row.appStatus === 5) && (
            <Button
              size="small"
              loading={onlineMutation.isPending}
              onClick={() => onlineMutation.mutate({ row, online: false })}
            >
              下架
            </Button>
          )}
          {row.appStatus === 1 && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              等待平台审核
            </Typography.Text>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          应用中心
        </Typography.Title>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          上传安装包 → 创建应用 → 平台审核 → 发布
        </Typography.Text>
      </div>

      <Card size="small" style={{ marginBottom: 14 }}>
        <Space wrap size={10}>
          <span style={{ fontSize: 13, opacity: 0.75 }}>账户</span>
          <Select
            showSearch
            style={{ width: 340 }}
            value={advertiserId || undefined}
            placeholder="选择广告账户"
            optionFilterProp="label"
            onChange={(v) => setAdvertiserId(v)}
            options={accounts.map((a) => ({
              value: a.advertiserId,
              label: `${a.accountName ?? '未命名'}（${a.advertiserId}）`,
            }))}
          />
          <span style={{ fontSize: 13, opacity: 0.75 }}>状态</span>
          <Select
            allowClear
            style={{ width: 140 }}
            placeholder="全部"
            value={statusFilter}
            onChange={(v) => setStatusFilter(v)}
            options={[1, 2, 3, 4, 5].map((s) => ({ value: s, label: STATUS_META[s].text }))}
          />
          <Button
            icon={<ReloadOutlined />}
            loading={appsQuery.isFetching}
            onClick={() => void qc.invalidateQueries({ queryKey: ['appcenter-apps'] })}
          >
            刷新
          </Button>
          <div style={{ flex: 1 }} />
          <Button
            type="primary"
            icon={<CloudUploadOutlined />}
            disabled={!advertiserId}
            onClick={() => setCreateOpen(true)}
          >
            上传 APK 创建应用
          </Button>
        </Space>
      </Card>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 14 }}
        message="创建应用需要平台审核（通常 1-2 个工作日）"
        description="审核通过后状态变成「待发布」，点发布之后 package_id 才能在「上计划」的应用下拉里选到。本页只做安卓安装包；iOS 应用请到磁力智投后台创建（接口已支持，暂未开放界面）。"
      />

      <Table<AppRow>
        rowKey={(r) => r.packageId || r.appId}
        size="small"
        loading={appsQuery.isLoading || appsQuery.isFetching}
        columns={columns}
        dataSource={appsQuery.data ?? []}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        locale={{
          emptyText: advertiserId
            ? '该账户还没有应用 —— 点右上角「上传 APK 创建应用」'
            : '先选一个广告账户',
        }}
      />

      <CreateAppModal
        open={createOpen}
        advertiserId={advertiserId}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          void qc.invalidateQueries({ queryKey: ['appcenter-apps'] });
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function CreateAppModal(props: {
  open: boolean;
  advertiserId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { open, advertiserId, onClose, onCreated } = props;
  const [form] = Form.useForm<CreateFormValues>();
  const [apk, setApk] = useState<{ blobStoreKey: string; fileName: string; size: number } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [percent, setPercent] = useState(0);
  const [iconUrl, setIconUrl] = useState<string | undefined>();
  const [iconUploading, setIconUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      form.resetFields();
      setApk(null);
      setIconUrl(undefined);
      setPercent(0);
    }
  }, [open, form]);

  const uploadApk = async (file: File) => {
    setUploading(true);
    setPercent(0);
    try {
      const res = await uploadBinary<{ blobStoreKey: string; sizeBytes: number; fileName: string }>(
        `/api/appcenter/apk?advertiserId=${encodeURIComponent(advertiserId)}`,
        file,
        { fileName: file.name, onProgress: (p) => setPercent(p.percent) },
      );
      setApk({ blobStoreKey: res.blobStoreKey, fileName: file.name, size: res.sizeBytes });
      message.success('安装包已上传，填完下面信息即可创建应用');
      // APK 里的包名平台会自己解析，这里只把文件名填成默认应用名（可改）
      const guess = file.name.replace(/\.apk$/i, '');
      if (!form.getFieldValue('appName')) form.setFieldValue('appName', guess);
    } catch (e) {
      Modal.error({ title: 'APK 上传失败', content: explainError(e) });
    } finally {
      setUploading(false);
      setPercent(0);
    }
  };

  const uploadIcon = async (file: File) => {
    setIconUploading(true);
    try {
      const res = await uploadBinary<{ url: string }>(
        `/api/appcenter/pic?advertiserId=${encodeURIComponent(advertiserId)}&type=1`,
        file,
        { fileName: file.name, contentType: file.type || 'image/png' },
      );
      setIconUrl(res.url);
      message.success('图标已上传');
    } catch (e) {
      Modal.error({ title: '图标上传失败', content: explainError(e) });
    } finally {
      setIconUploading(false);
    }
  };

  const submit = async () => {
    let values: CreateFormValues;
    try {
      values = await form.validateFields();
    } catch {
      // 校验失败：antd 已在字段下方标红，这里不需要再弹窗
      return;
    }
    if (!apk) {
      message.warning('请先上传 APK 安装包');
      return;
    }
    setSubmitting(true);
    try {
      await api.post('/api/appcenter/apps/android', {
        advertiserId,
        blobStoreKey: apk.blobStoreKey,
        appName: values.appName,
        category: values.category,
        developer: values.developer,
        contactName: values.contactName,
        contactTel: values.contactTel,
        contactEmail: values.contactEmail,
        privacyUrl: values.privacyUrl,
        recordNumber: values.recordNumber,
        functionIntroduction: values.functionIntroduction,
        networkType: values.networkType,
        sensitivePermissionDesc: values.sensitivePermissionDesc,
        applyAge: values.applyAge,
        appIconUrl: iconUrl,
      });
      message.success('应用已创建，状态为「审核中」——审核通过后回来点发布');
      onCreated();
    } catch (e) {
      Modal.error({ title: '创建应用失败', content: explainError(e) });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title="上传 APK 创建应用"
      width={720}
      onCancel={onClose}
      okText="创建应用"
      cancelText="取消"
      confirmLoading={submitting}
      okButtonProps={{ disabled: !apk }}
      onOk={() => void submit()}
    >
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 14 }}
        message="安装包上传后会解析出包名与版本，创建后进入平台审核"
        description="隐私政策链接、备案号、开发者信息必须与应用商店在架信息一致，不一致会被审核驳回。"
      />

      <Upload.Dragger
        accept=".apk"
        maxCount={1}
        showUploadList={false}
        disabled={uploading}
        beforeUpload={(file) => {
          void uploadApk(file as File);
          return false;
        }}
        style={{ marginBottom: 14 }}
      >
        {apk ? (
          <div style={{ padding: '6px 0' }}>
            <Typography.Text strong>{apk.fileName}</Typography.Text>
            <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
              {(apk.size / 1024 / 1024).toFixed(1)}MB · 已上传，可重新拖入替换
            </Typography.Text>
          </div>
        ) : (
          <div style={{ padding: '10px 0' }}>
            <p className="ant-upload-drag-icon" style={{ marginBottom: 6 }}>
              <InboxOutlined style={{ color: BRAND, fontSize: 28 }} />
            </p>
            <Typography.Text>把 .apk 拖到这里，或点击选择文件</Typography.Text>
            <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
              上限 300MB；上传过程有进度，别关页面
            </Typography.Text>
          </div>
        )}
      </Upload.Dragger>
      {uploading && <Progress percent={percent} size="small" status="active" style={{ marginBottom: 12 }} />}

      <Form<CreateFormValues>
        form={form}
        layout="vertical"
        initialValues={{ category: 1, networkType: 1 }}
        style={{ marginTop: 4 }}
      >
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 16 }}>
          <Form.Item
            label="应用名称"
            name="appName"
            extra="留空则用 APK 里解析出的名称"
          >
            <Input placeholder="如：拼多多" maxLength={50} />
          </Form.Item>
          <Form.Item label="应用类型" name="category" rules={[{ required: true }]}>
            <Radio.Group optionType="button">
              <Radio.Button value={1}>软件</Radio.Button>
              <Radio.Button value={2}>游戏</Radio.Button>
            </Radio.Group>
          </Form.Item>
          <Form.Item label="开发者（公司/个人主体）" name="developer" rules={[{ required: true, message: '与商店在架信息一致' }]}>
            <Input placeholder="如：上海寻梦信息技术有限公司" maxLength={60} />
          </Form.Item>
          <Form.Item label="备案号" name="recordNumber" extra="国内应用需填，如 沪ICP备xxxxxxxx号-xx">
            <Input placeholder="沪ICP备..." maxLength={60} />
          </Form.Item>
          <Form.Item label="联系人姓名" name="contactName" rules={[{ required: true }]}>
            <Input maxLength={30} />
          </Form.Item>
          <Form.Item
            label="联系人电话"
            name="contactTel"
            rules={[{ required: true }, { pattern: /^1\d{10}$/, message: '填 11 位手机号' }]}
          >
            <Input maxLength={11} />
          </Form.Item>
          <Form.Item label="联系人邮箱" name="contactEmail" rules={[{ type: 'email', message: '邮箱格式不对' }]}>
            <Input maxLength={60} />
          </Form.Item>
          <Form.Item label="使用年龄" name="applyAge">
            <InputNumber min={0} max={99} style={{ width: '100%' }} placeholder="如 18" />
          </Form.Item>
        </div>

        <Form.Item
          label="隐私政策链接"
          name="privacyUrl"
          rules={[
            { required: true, message: '必填' },
            { pattern: /^https?:\/\//i, message: '要 http(s) 完整地址' },
          ]}
        >
          <Input placeholder="https://..." />
        </Form.Item>

        <Form.Item label="功能介绍" name="functionIntroduction">
          <Input.TextArea rows={2} maxLength={200} showCount placeholder="一句话说明应用是做什么的" />
        </Form.Item>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 16 }}>
          <Form.Item label="网络类型" name="networkType">
            <Radio.Group optionType="button">
              <Radio.Button value={1}>联网</Radio.Button>
              <Radio.Button value={2}>单机</Radio.Button>
            </Radio.Group>
          </Form.Item>
          <Form.Item label="应用图标（450×450，<1MB，可选）">
            <Space>
              <Upload
                accept="image/png,image/jpeg"
                showUploadList={false}
                disabled={iconUploading}
                beforeUpload={(file) => {
                  void uploadIcon(file as File);
                  return false;
                }}
              >
                <Button icon={<CloudUploadOutlined />} loading={iconUploading}>
                  {iconUrl ? '重新上传' : '上传图标'}
                </Button>
              </Upload>
              {iconUrl && (
                <img src={iconUrl} alt="icon" style={{ width: 36, height: 36, borderRadius: 8 }} />
              )}
            </Space>
          </Form.Item>
        </div>

        <Form.Item
          label="敏感权限用途说明"
          name="sensitivePermissionDesc"
          extra="APK 申请了通讯录/位置/相机等敏感权限时必须说明用途，否则审核会驳回"
        >
          <Input.TextArea rows={2} maxLength={200} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
