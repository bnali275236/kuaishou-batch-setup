import {
  CheckCircleOutlined,
  CopyOutlined,
  DesktopOutlined,
  MobileOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Input, Space, Switch, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { api, explainError } from '../../api/client';

interface ShareState {
  enabled: boolean;
  hasPassword: boolean;
  effectiveEnabled: boolean;
  restartRequired: boolean;
  localUrl: string;
  lanUrls: string[];
  port: number;
}

/**
 * 局域网共享设置。
 *
 * 为什么值得做：token 本身与设备无关，但官方 refresh_token 是轮换制
 * （每次刷新生成新 token、老的立即失效），所以「把授权复制到多台设备」
 * 会互相踢下线。把后端跑在一台主机上、其他设备用浏览器访问，
 * 才是真正稳定且只授权一次的方案。
 */
export default function ShareCard() {
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(false);
  const [password, setPassword] = useState('');
  const [restarting, setRestarting] = useState(false);

  const { data, isLoading, error } = useQuery<ShareState>({
    queryKey: ['share-state'],
    queryFn: () => api.get<ShareState>('/api/system/share'),
    retry: false,
  });

  useEffect(() => {
    if (data) setEnabled(data.enabled);
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: (payload: { enabled: boolean; password?: string }) =>
      api.post<ShareState>('/api/system/share', payload),
    onSuccess: (s) => {
      setPassword('');
      void queryClient.invalidateQueries({ queryKey: ['share-state'] });
      message.success(s.restartRequired ? '已保存，重启后生效' : '已保存');
    },
    onError: (err) => modal.error({ title: '保存失败', content: explainError(err) }),
  });

  /** 保存并重启后端 —— 监听地址只能在启动时决定，所以必须重启 */
  const applyAndRestart = async () => {
    if (enabled && !data?.hasPassword && !password.trim()) {
      modal.warning({ title: '请先设置访问口令', content: '开启共享必须设置口令，否则同网段的人都能操作你的广告账户。' });
      return;
    }
    try {
      await saveMutation.mutateAsync({
        enabled,
        ...(password.trim() ? { password: password.trim() } : {}),
      });
    } catch {
      return; // 保存失败已提示
    }

    setRestarting(true);
    try {
      await api.post('/api/system/restart', {});
    } catch {
      /* 后端可能在响应前就退出了，属正常 */
    }
    // 轮询等后端回来，然后整页重载（端口可能变化）
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        await api.get('/api/system/health');
        window.location.reload();
        return;
      } catch {
        /* 还没起来，继续等 */
      }
    }
    setRestarting(false);
    modal.warning({
      title: '后端未按时恢复',
      content: '请手动关闭并重新打开桌面程序（浏览器方式请重新访问主机地址）。',
    });
  };

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text);
    message.success('已复制');
  };

  // 非本机访问时后端会拒绝（LOCAL_ONLY）—— 直接说明白，不显示一堆报错
  if (error) {
    return (
      <Card title="④ 局域网共享" size="small" style={{ marginBottom: 16 }}>
        <Alert
          type="info"
          showIcon
          message="共享设置只能在主机上修改"
          description={
            <>
              你现在是<b>通过共享访问主机</b>的（用的是主机的后端与授权），所以共享开关与访问口令
              需要在主机那台电脑上操作。
              <br />
              但你<b>照样可以自行授权</b>：回到上面的第 ② 步生成授权链接，用
              <b>你自己的快手账号</b>登录授权，你负责的广告账户就会汇入这个工作台。
            </>
          }
        />
      </Card>
    );
  }

  const urls = data?.lanUrls ?? [];

  return (
    <Card
      title="④ 局域网共享（同一网络的多台电脑共用一个后端）"
      size="small"
      loading={isLoading}
      style={{ marginBottom: 16 }}
      extra={
        data?.enabled ? (
          <Tag icon={<CheckCircleOutlined />} color="success">
            已开启
          </Tag>
        ) : (
          <Tag color="default">未开启</Tag>
        )
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 14 }}
        message="为什么不能直接把授权复制到每台电脑"
        description={
          <>
            快手的 refresh_token 是<b>轮换制</b>：每次刷新都会生成新的 access_token 和
            refresh_token，<b>老的立即失效</b>。所以多台电脑各存一份授权，谁先刷新谁就把别人踢下线。
            <br />
            正确做法是：<b>只让一台电脑跑程序</b>（token 只有它一份、只刷新一次），
            其他电脑用浏览器打开它的地址即可，无需再做任何授权。
            <br />
            共享进来的同事也可以在<b>「接入设置」第 ② 步自行授权</b>自己负责的账户，
            账户会汇入同一个工作台。若对方<b>不在同一网络</b>（异地 / 外网），
            请改用第 ① 节的「导出配置包」让对方在自己电脑上还原配置后自行授权。
          </>
        }
      />

      <Space align="center" style={{ marginBottom: 12 }}>
        <Switch
          checked={enabled}
          onChange={(v) => setEnabled(v)}
          disabled={saveMutation.isPending || restarting}
        />
        <span style={{ fontSize: 13 }}>
          {enabled ? '允许局域网内其他设备访问' : '仅本机可访问（推荐默认）'}
        </span>
      </Space>

      {enabled && (
        <Alert
          type="warning"
          showIcon
          icon={<SafetyCertificateOutlined />}
          style={{ marginBottom: 12 }}
          message="开启共享后，同网段的人只要知道地址和口令就能操作你的广告账户"
          description="口令是唯一的门槛，请设置得长一些。只能在可信网络（如公司内网）里开启。"
        />
      )}

      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6 }}>
          访问口令{data?.hasPassword ? '（已设置，留空则不修改）' : '（开启共享必填）'}
        </div>
        <Input.Password
          placeholder={data?.hasPassword ? '留空表示不修改现有口令' : '至少 4 位，建议长一些'}
          value={password}
          disabled={restarting}
          onChange={(e) => setPassword(e.target.value)}
          style={{ maxWidth: 380 }}
          autoComplete="new-password"
        />
      </div>

      <Space wrap>
        <Button
          type="primary"
          loading={saveMutation.isPending || restarting}
          onClick={() => void applyAndRestart()}
        >
          {restarting ? '正在重启后端…' : '保存并重启生效'}
        </Button>
        <Button
          icon={<ReloadOutlined />}
          disabled={restarting}
          onClick={() => {
            void queryClient.invalidateQueries({ queryKey: ['share-state'] });
          }}
        >
          刷新状态
        </Button>
        {data?.restartRequired && !restarting && (
          <Tag icon={<WarningOutlined />} color="warning">
            当前配置尚未生效，需重启
          </Tag>
        )}
      </Space>

      <div
        style={{
          marginTop: 16,
          padding: '12px 14px',
          background: '#FAFAF9',
          border: '1px solid rgba(0,0,0,.06)',
          borderRadius: 8,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8 }}>
          <DesktopOutlined style={{ marginRight: 6 }} />
          其他设备这样访问
        </div>

        {!data?.effectiveEnabled && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {data?.enabled
              ? '已保存但还没重启，重启后下面这些地址才会生效。'
              : '开启共享并重启后，这里会列出可用的访问地址。'}
          </Typography.Text>
        )}

        {data?.effectiveEnabled && (
          <>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
              在<b>同一局域网</b>的其他电脑 / 手机上，用浏览器打开下面任一地址，
              输入访问口令即可使用（手机端仅建议查看数据）。
            </Typography.Paragraph>
            {urls.length === 0 && (
              <Typography.Text type="warning" style={{ fontSize: 12 }}>
                没检测到局域网网卡地址，请确认这台电脑已连接网络。
              </Typography.Text>
            )}
            <Space direction="vertical" style={{ width: '100%' }} size={6}>
              {urls.map((u) => (
                <Space key={u} size={8}>
                  <MobileOutlined style={{ opacity: 0.45 }} />
                  <code style={{ fontSize: 12 }}>{u}</code>
                  <Button size="small" type="link" icon={<CopyOutlined />} onClick={() => copy(u)}>
                    复制
                  </Button>
                </Space>
              ))}
            </Space>
            <div style={{ marginTop: 10 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                本机地址：
              </Typography.Text>
              <code style={{ fontSize: 12, marginLeft: 6 }}>{data.localUrl}</code>
            </div>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 10, marginBottom: 0 }}>
              连不上时按顺序检查：① 主机是不是开着程序；② Windows 防火墙是否放行了本程序；
              ③ 两台设备是否在同一个网段。
            </Typography.Paragraph>
          </>
        )}
      </div>
    </Card>
  );
}
