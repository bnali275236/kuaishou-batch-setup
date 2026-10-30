import {
  AlertOutlined,
  AppstoreAddOutlined,
  DashboardOutlined,
  SettingOutlined,
  TeamOutlined,
  UnorderedListOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Badge, ConfigProvider, Layout, Menu, Tooltip } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api } from './api/client';
import ShareGate from './components/ShareGate';
import AccountsPage from './pages/AccountsPage';
import DashboardPage from './pages/DashboardPage';
import MaterialBoardPage from './pages/MaterialBoardPage';
import PlanCreatePage from './pages/PlanCreatePage';
import SetupPage from './pages/SetupPage';
import TasksPage from './pages/TasksPage';
import { UiPrefsProvider, useUiPrefs } from './ui';

const { Sider, Content, Header } = Layout;

interface HealthResult {
  ok: boolean;
  accounts: {
    /** 授权凭证数 —— 一次授权一份 */
    grantTotal: number;
    grantActive: number;
    /** 需要重新授权的凭证数 */
    grantNeedReauth: number;
    grantDisabled: number;
    accountTotal: number;
    accountActive: number;
    accountDisabled: number;
  };
  rateLimit: {
    pausedUntil: string | null;
    timeoutRatio: number;
    global: { tokens: number; capacity: number };
  };
}

function Shell() {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useUiPrefs();

  const { data: health } = useQuery<HealthResult>({
    queryKey: ['system-health'],
    queryFn: () => api.get<HealthResult>('/api/system/health'),
    refetchInterval: 60_000,
  });

  const selected = location.pathname.startsWith('/setup')
    ? '/setup'
    : ['/dashboard', '/materials', '/plan', '/tasks', '/accounts'].find((k) =>
        location.pathname.startsWith(k),
      ) ?? '/dashboard';
  const needReauth = health?.accounts.grantNeedReauth ?? 0;
  const paused = Boolean(health?.rateLimit.pausedUntil);

  const mainItems = [
    { key: '/dashboard', icon: <DashboardOutlined />, label: t('dashboard') },
    { key: '/materials', icon: <VideoCameraOutlined />, label: t('materials') },
    { key: '/plan', icon: <AppstoreAddOutlined />, label: t('plan') },
    { key: '/tasks', icon: <UnorderedListOutlined />, label: t('tasks') },
    { key: '/accounts', icon: <TeamOutlined />, label: t('accounts') },
  ];

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#534AB7',
          borderRadius: 8,
          fontSize: 13,
        },
      }}
    >
      {/* 固定外壳：整体不滚动，侧边栏常驻，只有右侧 Content 滚动 */}
      <Layout style={{ height: '100vh', overflow: 'hidden' }}>
        <Sider
          width={208}
          theme="light"
          style={{
            borderRight: '1px solid rgba(128,128,128,.18)',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div className="app-logo">
            <span className="dot" />
            {t('appName')}
          </div>
          <Menu
            mode="inline"
            selectedKeys={[selected]}
            items={mainItems}
            style={{ borderInlineEnd: 'none', flex: 1 }}
            onClick={({ key }) => navigate(key)}
          />
          {/* 底部固定区：设置 */}
          <div className="sider-footer">
            <div
              className={`sider-footer-item${selected === '/setup' ? ' active' : ''}`}
              onClick={() => navigate('/setup')}
            >
              <SettingOutlined />
              <span>{t('settings')}</span>
            </div>
          </div>
        </Sider>

        <Layout style={{ height: '100vh', overflow: 'hidden' }}>
          <Header
            style={{
              background: 'rgba(128,128,128,.06)',
              height: 56,
              lineHeight: '56px',
              padding: '0 20px',
              borderBottom: '1px solid rgba(128,128,128,.15)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 16,
              flex: 'none',
            }}
          >
            {paused && (
              <Tooltip title={`超时率 ${((health?.rateLimit.timeoutRatio ?? 0) * 100).toFixed(1)}%，已触发自适应降速`}>
                <Badge status="warning" text="限流降速中" />
              </Tooltip>
            )}
            {needReauth > 0 && (
              <Tooltip title="这些授权凭证的 refresh_token 已失效，必须重新授权才能继续拉数">
                <Badge
                  status="error"
                  text={
                    <span onClick={() => navigate('/accounts')} style={{ cursor: 'pointer' }}>
                      {needReauth} 份授权需重做
                    </span>
                  }
                />
              </Tooltip>
            )}
            {health && (
              <Tooltip title="已纳管账户数 / 授权凭证数">
                <span style={{ fontSize: 13, opacity: 0.65 }}>
                  <AlertOutlined style={{ marginRight: 4 }} />
                  {health.accounts.accountTotal} 个账户 · {health.accounts.grantTotal} 份授权
                </span>
              </Tooltip>
            )}
          </Header>

          {/* 唯一的滚动区域：右侧内容窗口 */}
          <Content style={{ padding: 20, overflowY: 'auto', flex: 1, minHeight: 0 }}>
            <Routes>
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/materials" element={<MaterialBoardPage />} />
              <Route path="/plan" element={<PlanCreatePage />} />
              <Route path="/tasks" element={<TasksPage />} />
              <Route path="/accounts" element={<AccountsPage />} />
              <Route path="/setup" element={<SetupPage />} />
            </Routes>
          </Content>
        </Layout>
      </Layout>
    </ConfigProvider>
  );
}

export default function App() {
  return (
    <UiPrefsProvider>
      {/* 局域网共享时的口令门：本机访问直接放行，其他设备需先输入访问口令 */}
      <ShareGate>
        <Shell />
      </ShareGate>
    </UiPrefsProvider>
  );
}
