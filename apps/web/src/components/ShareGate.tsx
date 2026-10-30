import { KeyOutlined, LockOutlined, ReloadOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Input, Spin, Tag, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import {
  api,
  getShareKey,
  isApiError,
  isShareAuthError,
  onShareAuthRequired,
  setShareKey,
} from '../api/client';

interface Probe {
  isLocal: boolean;
  enabled: boolean;
  hasPassword: boolean;
  requiresKey: boolean;
}

type Phase = 'checking' | 'local' | 'disabled' | 'locked' | 'open';

/**
 * 局域网共享的「口令门」。
 *
 * 行为：
 *   · 本机访问（127.0.0.1）→ 直接放行，桌面版本体完全感知不到它的存在
 *   · 其他设备 + 主机没开共享 → 显示「找管理员开启共享」而不是让人对着报错猜
 *   · 其他设备 + 已开共享 → 要求输入访问口令，通过后写进 localStorage
 *
 * 之所以要它：后端持有全部 token，端口一开就等于把「改出价 / 建计划」
 * 暴露给同网段。页面能打开、但没有任何数据，直到口令正确为止。
 */
export default function ShareGate({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>('checking');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const check = useCallback(async () => {
    setPhase('checking');
    setError(null);

    let probe: Probe;
    try {
      probe = await api.post<Probe>('/api/system/share/probe');
    } catch {
      // 探针都失败（后端尚未就绪等）→ 不拦人，交给页面自己报错，避免误判成「被锁」
      setPhase('open');
      return;
    }

    if (probe.isLocal) {
      setPhase('local');
      return;
    }
    if (!probe.enabled) {
      setPhase('disabled');
      return;
    }
    if (!getShareKey()) {
      setPhase('locked');
      return;
    }
    // 本地已有口令：用一个受保护接口确认它还有效（主机的口令可能被改过）
    try {
      await api.get('/api/system/health');
      setPhase('open');
    } catch (err) {
      setPhase(isShareAuthError(err) ? 'locked' : 'open');
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  // 会话中口令失效（主机改了口令）→ 自动弹回口令门，而不是让每个页面各自报错
  useEffect(() => onShareAuthRequired(() => setPhase('locked')), []);

  const submit = async () => {
    const value = password.trim();
    if (!value) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post('/api/system/share/verify', { password: value });
      setShareKey(value);
      setPassword('');
      await check();
    } catch (err) {
      setError(isApiError(err) ? err.message : '校验失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  if (phase === 'local' || phase === 'open') return <>{children}</>;

  return (
    <div
      style={{
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      {phase === 'checking' && (
        <div style={{ textAlign: 'center' }}>
          <Spin size="large" />
          <div style={{ marginTop: 12, fontSize: 13, opacity: 0.65 }}>正在连接主机…</div>
        </div>
      )}

      {phase === 'disabled' && (
        <Card style={{ maxWidth: 480 }} title="这台电脑未开启共享">
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="主机的「局域网共享」开关没有打开"
            description={
              <>
                你访问的是一台运行「快手投放工作台」的电脑。它当前只允许本机访问，
                所以拒绝了来自你这台设备的请求。
                <br />
                <br />
                请让主机那边打开程序，进入 <b>设置 → 局域网共享</b>，打开开关并设置访问口令，
                然后你刷新本页即可。
              </>
            }
          />
          <Button icon={<ReloadOutlined />} onClick={() => void check()}>
            重新检测
          </Button>
        </Card>
      )}

      {phase === 'locked' && (
        <Card style={{ width: 400 }} title={<span><LockOutlined style={{ marginRight: 8 }} />需要访问口令</span>}>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
            这是主机为「局域网共享」设置的访问口令，不是快手账号密码。
            口令正确后才能读取数据，也不会保存在主机以外的任何地方。
          </Typography.Paragraph>

          <Input.Password
            prefix={<KeyOutlined style={{ opacity: 0.4 }} />}
            placeholder="请输入访问口令"
            value={password}
            autoFocus
            onChange={(e) => setPassword(e.target.value)}
            onPressEnter={() => void submit()}
            status={error ? 'error' : undefined}
          />
          {error && (
            <div style={{ color: '#A32D2D', fontSize: 12, marginTop: 8 }}>{error}</div>
          )}

          <Button
            type="primary"
            block
            style={{ marginTop: 16 }}
            loading={submitting}
            disabled={!password.trim()}
            onClick={() => void submit()}
          >
            进入工作台
          </Button>

          <div style={{ marginTop: 12, textAlign: 'center' }}>
            <Tag style={{ fontSize: 11 }}>口令由主机管理员设置</Tag>
          </div>
        </Card>
      )}
    </div>
  );
}
