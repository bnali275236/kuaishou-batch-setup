import {
  CheckCircleOutlined,
  CopyOutlined,
  LinkOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  Radio,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useEffect, useState } from 'react';
import { api, explainError } from '../api/client';
import ShareCard from './setup/ShareCard';
import PortableConfigPanel from './setup/PortableConfig';
import {
  ALL_AUTH_ENTRIES,
  AUTH_ENTRY,
  AUTH_ENTRY_META,
  AUTH_TYPE_META,
  DEFAULT_SCOPES,
  REQUIRED_SCOPES,
  SCOPE_META,
} from '@wkbd/shared';
import type {
  AppConfigView,
  AuthEntry,
  AuthType,
  AuthorizeUrlResult,
  ExchangeResult,
  ResyncResult,
} from '@wkbd/shared';

/** 从完整 URL 里取出 host，用于直观展示「这条链接会跳到哪个平台」 */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * 解析用户粘贴的内容 —— 支持「整条回调地址」和「纯 auth_code」两种。
 *
 * 为什么要支持整条地址：本项目的回调落在中转域名上（见设置里的 redirect_uri），
 * 用户从地址栏直接复制整条 URL 是最自然的动作；而且整条 URL 里带着 state，
 * 兑换时能还原「授权入口 + 授权方式」，识别账户更准（纯 code 会丢掉这些信息）。
 */
function parseTicket(raw: string): { code: string; state?: string } {
  const s = raw.trim();
  if (!s) return { code: '' };

  const matched = s.match(/[?&](?:auth_code|code)=([^&\s#]+)/);
  if (matched) {
    const stateHit = s.match(/[?&]state=([^&\s#]+)/);
    return {
      code: decodeURIComponent(matched[1]),
      state: stateHit ? decodeURIComponent(stateHit[1]) : undefined,
    };
  }

  const kv = s.match(/^(?:auth_code|code)=(.+)$/);
  if (kv) return { code: kv[1].trim() };

  return { code: s };
}

export default function SetupPage() {
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm();
  const [authCode, setAuthCode] = useState('');
  const [authEntry, setAuthEntry] = useState<AuthEntry>(AUTH_ENTRY.LUOPAN);
  const [authType, setAuthType] = useState<AuthType>('USER');
  const [scopes, setScopes] = useState<string[]>(DEFAULT_SCOPES);

  const { data: config, isLoading } = useQuery<AppConfigView>({
    queryKey: ['app-config'],
    queryFn: () => api.get<AppConfigView>('/api/settings/app'),
  });

  /**
   * 判断「我是不是主机」。
   * 共享用户（从别的设备连过来的人）不能改全局配置，但**完全可以自行授权**：
   * 用他自己的快手账号登录授权，账户会汇入同一个工作台。
   */
  const { data: probe } = useQuery<{ isLocal: boolean }>({
    queryKey: ['share-probe'],
    queryFn: () => api.post<{ isLocal: boolean }>('/api/system/share/probe'),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  // 取不到时按本机处理，避免把主机自己的能力也锁掉
  const isLocal = probe?.isLocal !== false;

  // 配置异步到达后再回填表单（Form 的 initialValues 只生效一次）
  useEffect(() => {
    if (!config) return;
    form.setFieldsValue({
      appId: config.appId ?? '',
      redirectUri: config.redirectUri ?? 'http://localhost:7801/api/oauth/callback',
      secret: '',
    });
    if (config.scopes?.length) setScopes(config.scopes);
  }, [config, form]);

  const saveMutation = useMutation({
    mutationFn: (values: { appId: string; secret?: string; redirectUri: string }) =>
      api.post<AppConfigView>('/api/settings/app', { ...values, scopes }),
    onSuccess: () => {
      message.success('应用配置已保存');
      form.setFieldValue('secret', '');
      void queryClient.invalidateQueries({ queryKey: ['app-config'] });
    },
    onError: (err) => modal.error({ title: '保存失败', content: explainError(err) }),
  });

  const authorizeMutation = useMutation({
    mutationFn: () =>
      api.get<AuthorizeUrlResult>(
        `/api/oauth/authorize-url?authEntry=${authEntry}&authType=${authType}`,
      ),
    onSuccess: (data) => {
      const entryMeta = AUTH_ENTRY_META[data.authEntry];
      const typeMeta = AUTH_TYPE_META[data.authType];

      window.open(data.url, '_blank', 'noopener,noreferrer');

      modal.info({
        width: 620,
        title: '已在新标签页打开快手授权页',
        content: (
          <div style={{ fontSize: 13, lineHeight: 1.9 }}>
            <div
              style={{
                background: '#F7F6FE',
                border: '1px solid rgba(127,119,221,.25)',
                borderRadius: 8,
                padding: '12px 14px',
                marginBottom: 12,
              }}
            >
              <div style={{ marginBottom: 8 }}>
                <Tag color="purple">将跳转到：{entryMeta.platform}</Tag>
                <Tag color={data.authType === 'USER' ? 'purple' : 'blue'}>{typeMeta.label}</Tag>
              </div>
              <div style={{ color: '#5F5E5A' }}>生效范围：{entryMeta.coverage}</div>
            </div>

            <p style={{ marginBottom: 8 }}>
              <b>请按下面这一步操作，否则授权范围会不对：</b>
            </p>
            <div
              style={{
                background: '#FAFAF9',
                border: '1px solid rgba(0,0,0,.06)',
                borderRadius: 8,
                padding: '12px 14px',
                marginBottom: 12,
              }}
            >
              {entryMeta.howTo}
            </div>

            {data.authEntry !== 'AGENT' && (
              <div
                style={{
                  background: '#FAFAF9',
                  border: '1px solid rgba(0,0,0,.06)',
                  borderRadius: 8,
                  padding: '12px 14px',
                  marginBottom: 12,
                }}
              >
                <div style={{ marginBottom: 4 }}>
                  <b>授权页上的「授权方式」请选：{typeMeta.label}</b>
                </div>
                <div style={{ color: '#5F5E5A' }}>{typeMeta.howTo}</div>
              </div>
            )}

            <div style={{ color: '#888780', fontSize: 12, marginBottom: 4 }}>
              本次链接域名（可用于核对跳到哪个平台）：
            </div>
            <div
              style={{
                fontFamily: 'ui-monospace,Consolas,monospace',
                fontSize: 11,
                wordBreak: 'break-all',
                background: '#FAFAF9',
                padding: '8px 10px',
                borderRadius: 6,
                color: '#5F5E5A',
              }}
            >
              {data.url}
            </div>

            <p style={{ color: '#5F5E5A', margin: '12px 0 0' }}>
              授权成功后浏览器会跳到回调地址，看到「授权成功」即可关闭该页面，回到这里查看账户列表。
            </p>
          </div>
        ),
      });
    },
    onError: (err) => modal.error({ title: '无法生成授权链接', content: explainError(err) }),
  });

  const exchangeMutation = useMutation({
    mutationFn: (raw: string) => {
      const { code, state } = parseTicket(raw);
      return api.post<ExchangeResult>('/api/oauth/exchange', { authCode: code, state });
    },
    onSuccess: (data) => {
      if (data.pending) {
        modal.warning({
          title: '授权成功，但未识别到账户',
          content:
            '授权凭证已保存，token 没有丢。请在「账户管理」页对该凭证点击「对齐账户」来补全账户列表。' +
            '若反复识别不到，多半是授权入口与账号类型不匹配（例如用广告主入口去授权罗盘账号）。',
        });
      } else {
        message.success(`授权完成：新增 1 份凭证，覆盖 ${data.accountCount} 个广告账户`);
      }
      setAuthCode('');
      void queryClient.invalidateQueries({ queryKey: ['oauth-grants'] });
      void queryClient.invalidateQueries({ queryKey: ['oauth-accounts'] });
      void queryClient.invalidateQueries({ queryKey: ['system-health'] });
    },
    onError: (err) => modal.error({ title: '兑换失败', content: explainError(err) }),
  });

  const resyncMutation = useMutation({
    mutationFn: () => api.post<ResyncResult>('/api/oauth/resync', {}),
    onSuccess: (data) => {
      message.success(
        `已对齐 ${data.grants} 份授权：发现 ${data.found} 个账户，新增 ${data.added} 个`,
      );
      void queryClient.invalidateQueries({ queryKey: ['oauth-grants'] });
      void queryClient.invalidateQueries({ queryKey: ['oauth-accounts'] });
    },
    onError: (err) => modal.error({ title: '对齐失败', content: explainError(err) }),
  });

  const configured = config?.configured ?? false;
  const entryMeta = AUTH_ENTRY_META[authEntry];
  const typeMeta = AUTH_TYPE_META[authType];
  const agentEntry = authEntry === AUTH_ENTRY.AGENT;
  const previewUrl = `${entryMeta.url}?app_id=${config?.appId ?? '<app_id>'}&scope=${encodeURIComponent(
    JSON.stringify(scopes),
  )}&redirect_uri=...${entryMeta.oauthType ? `&oauth_type=${entryMeta.oauthType}` : ''}`;

  return (
    <div style={{ maxWidth: 940 }}>
      <div className="page-header">
        <h2>接入设置</h2>
        <p>配置磁力引擎开放平台开发者应用，并完成广告账户授权</p>
      </div>

      <div className="hint-block" style={{ marginBottom: 16 }}>
        <strong>三步走：</strong>① 填写开发者应用信息 → ② 选择<strong>授权入口</strong>并生成授权链接 →
        ③ 回到「账户管理」确认凭证与账户已入库。
        <br />
        <strong style={{ color: '#A32D2D' }}>最容易踩的坑：</strong>
        快手有<strong>三个</strong>不同的授权入口，<strong>域名不一样</strong>，跳到哪个平台完全不同。
        想用罗盘一次授权全部账户，就必须走<strong>磁力罗盘</strong>入口
        （<code>developers.e.kuaishou.com</code>），而不是磁力智投
        （<code>ad.e.kuaishou.com</code>）——后者只能按单账户授权。
      </div>

      <Card
        title="① 开发者应用"
        size="small"
        loading={isLoading}
        style={{ marginBottom: 16 }}
        extra={
          configured ? (
            <Tag icon={<CheckCircleOutlined />} color="success">
              已配置
            </Tag>
          ) : (
            <Tag color="warning">未配置</Tag>
          )
        }
      >
        {!isLocal && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 14 }}
            message="开发者应用由主机统一配置 —— 你不需要填这里"
            description={
              <>
                你正在通过共享访问主机，应用凭据（<code>app_id</code> / <code>app_secret</code>）
                由主机保管。直接跳到下面 <b>第 ② 步</b> 生成授权链接，用<b>你自己的快手账号</b>
                登录授权即可 —— 授权完成后，你的广告账户会加入这个共享工作台。
              </>
            }
          />
        )}
        <Form
          form={form}
          layout="vertical"
          disabled={!isLocal}
          onFinish={(values) => saveMutation.mutate(values)}
        >
          <Form.Item
            label="app_id"
            name="appId"
            rules={[{ required: true, message: '请填写 app_id' }]}
          >
            <Input placeholder="开放平台「应用管理」中生成" />
          </Form.Item>

          <Form.Item
            label="app_secret"
            name="secret"
            extra={
              config?.secretMasked
                ? `已保存：${config.secretMasked} —— 留空表示不修改`
                : 'secret 仅保存在本机后端，用 AES-256-GCM 加密后落库，不会返回给浏览器'
            }
            rules={configured ? [] : [{ required: true, message: '首次配置必须填写 app_secret' }]}
          >
            <Input.Password
              placeholder={config?.secretMasked ? '留空则不修改' : '开放平台生成的 secret'}
              autoComplete="new-password"
            />
          </Form.Item>

          <Form.Item
            label="回调地址 redirect_uri"
            name="redirectUri"
            extra="必须与开放平台「应用管理」里登记的完全一致。平台限制每月最多修改 5 次。"
            rules={[{ required: true, message: '请填写回调地址' }]}
          >
            <Input placeholder="http://localhost:7801/api/oauth/callback" />
          </Form.Item>

          <Form.Item
            label="申请权限 scope"
            extra="核心三段权限恒定申请 —— 授权是一次性的，漏掉就得让所有账户重新授权一遍。"
          >
            <Checkbox.Group
              value={scopes}
              onChange={(v) => setScopes(v as string[])}
              style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
            >
              {Object.entries(SCOPE_META).map(([code, meta]) => {
                const core = (REQUIRED_SCOPES as readonly string[]).includes(code);
                return (
                  <Checkbox key={code} value={code} disabled={core}>
                    <span style={{ fontWeight: 500 }}>{meta.label}</span>
                    <code style={{ marginLeft: 8, fontSize: 11, color: '#888780' }}>{code}</code>
                    {core && (
                      <Tag color="default" style={{ marginLeft: 8 }}>
                        必选
                      </Tag>
                    )}
                    <div style={{ fontSize: 12, color: '#5F5E5A', lineHeight: 1.7 }}>
                      {meta.desc}
                    </div>
                  </Checkbox>
                );
              })}
            </Checkbox.Group>
          </Form.Item>

          <Button type="primary" htmlType="submit" loading={saveMutation.isPending}>
            保存配置
          </Button>
        </Form>

        {isLocal && <PortableConfigPanel configured={configured} />}
      </Card>

      <Card title="② 选择授权入口并生成授权链接" size="small" style={{ marginBottom: 16 }}>
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="授权入口决定域名 —— 选错会跳错平台，且直接决定能不能批量授权"
          description={
            <>
              罗盘 / 代理商这类账号，必须走对应入口才能在授权页上看到「基于用户授权」，
              从而一次接入全部账户。用磁力智投入口登录罗盘账号，是拿不到批量效果的。
            </>
          }
        />

        {!isLocal && (
          <Alert
            type="success"
            showIcon
            style={{ marginBottom: 16 }}
            message="共享使用者同样可以自行授权 —— 不需要开发者账号"
            description={
              <>
                你在<b>自己的电脑/浏览器</b>上打开生成的授权链接，登录<b>你自己的快手账号</b>完成授权，
                授权结果会直接汇入这个共享工作台，你负责的那些广告账户随即出现在「账户管理」里。
                <br />
                如果授权完成后页面停在中转域名上没自动完成（回调地址不通），把地址栏里的
                <code> auth_code</code> 复制到下面 <b>第 ③ 步</b>「手工兑换」即可。
              </>
            }
          />
        )}

        <Radio.Group
          value={authEntry}
          onChange={(e) => setAuthEntry(e.target.value as AuthEntry)}
          style={{ width: '100%' }}
        >
          <Space direction="vertical" style={{ width: '100%' }} size={10}>
            {ALL_AUTH_ENTRIES.map((k) => {
              const m = AUTH_ENTRY_META[k];
              const active = authEntry === k;
              return (
                <Radio
                  key={k}
                  value={k}
                  style={{
                    width: '100%',
                    border: `1px solid ${active ? '#7F77DD' : 'rgba(0,0,0,.09)'}`,
                    background: active ? '#F7F6FE' : '#fff',
                    borderRadius: 8,
                    padding: '12px 14px',
                    margin: 0,
                    alignItems: 'flex-start',
                  }}
                >
                  <div style={{ marginLeft: 4 }}>
                    <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>
                      {m.label}
                      <Tag color="blue" style={{ marginLeft: 8 }}>
                        跳到 {m.platform}
                      </Tag>
                      {m.recommended && (
                        <Tag color="purple" style={{ marginLeft: 0 }}>
                          推荐
                        </Tag>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: '#5F5E5A', lineHeight: 1.8 }}>
                      <div>
                        覆盖范围：{m.coverage}
                      </div>
                      <div style={{ color: '#888780' }}>
                        域名：<code>{hostOf(m.url)}</code>
                        {m.oauthType && (
                          <>
                            {' · '}
                            <code>oauth_type={m.oauthType}</code>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </Radio>
              );
            })}
          </Space>
        </Radio.Group>

        {agentEntry ? (
          <Alert
            type="info"
            showIcon
            style={{ marginTop: 14 }}
            message="代理商入口无需选择授权方式"
            description="一份 token 天然覆盖该代理商管辖范围内的全部广告主账户，授权页上不会出现「基于用户授权 / 基于广告账户授权」的选择。"
          />
        ) : (
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8 }}>
              授权方式（你在快手授权页上要选的那一项）
            </div>
            <Radio.Group
              value={authType}
              onChange={(e) => setAuthType(e.target.value as AuthType)}
              style={{ width: '100%' }}
            >
              <Space direction="vertical" style={{ width: '100%' }} size={8}>
                {(['USER', 'ACCOUNT'] as AuthType[]).map((t) => {
                  const m = AUTH_TYPE_META[t];
                  const active = authType === t;
                  return (
                    <Radio
                      key={t}
                      value={t}
                      style={{
                        width: '100%',
                        border: `1px solid ${active ? '#7F77DD' : 'rgba(0,0,0,.09)'}`,
                        background: active ? '#F7F6FE' : '#fff',
                        borderRadius: 8,
                        padding: '10px 14px',
                        margin: 0,
                        alignItems: 'flex-start',
                      }}
                    >
                      <div style={{ marginLeft: 4 }}>
                        <div style={{ fontSize: 13, fontWeight: 500 }}>
                          {m.label}
                          {t === 'USER' && (
                            <Tag color="purple" style={{ marginLeft: 8 }}>
                              批量推荐
                            </Tag>
                          )}
                        </div>
                        <div style={{ fontSize: 12, color: '#5F5E5A', lineHeight: 1.8 }}>
                          生效范围：{m.scope}
                        </div>
                      </div>
                    </Radio>
                  );
                })}
              </Space>
            </Radio.Group>
          </div>
        )}

        <div
          style={{
            marginTop: 14,
            padding: '10px 12px',
            background: '#FAFAF9',
            border: '1px solid rgba(0,0,0,.06)',
            borderRadius: 8,
            fontSize: 12,
            color: '#5F5E5A',
          }}
        >
          <div style={{ marginBottom: 4, color: '#888780' }}>
            即将生成的链接长这样（域名可核对）：
          </div>
          <div
            style={{
              fontFamily: 'ui-monospace,Consolas,monospace',
              fontSize: 11,
              wordBreak: 'break-all',
            }}
          >
            {previewUrl}
          </div>
        </div>

        <div style={{ marginTop: 16 }}>
          <Button
            type="primary"
            icon={<LinkOutlined />}
            disabled={!configured}
            loading={authorizeMutation.isPending}
            onClick={() => authorizeMutation.mutate()}
          >
            生成授权链接并打开
          </Button>
          <Button
            style={{ marginLeft: 8 }}
            icon={<CopyOutlined />}
            disabled={!configured}
            onClick={() => {
              api
                .get<AuthorizeUrlResult>(
                  `/api/oauth/authorize-url?authEntry=${authEntry}&authType=${authType}`,
                )
                .then((r) => {
                  void navigator.clipboard?.writeText(r.url);
                  message.success('授权链接已复制，可自行粘贴到浏览器打开');
                })
                .catch((err) => {
                  modal.error({ title: '生成失败', content: explainError(err) });
                });
            }}
          >
            仅复制链接
          </Button>
          <Typography.Text type="secondary" style={{ marginLeft: 12, fontSize: 12 }}>
            入口：{entryMeta.label}
            {agentEntry ? '' : ` · 方式：${typeMeta.label}`}
          </Typography.Text>
        </div>
      </Card>

      <Card title="③ 账户识别与兜底通道" size="small" style={{ marginBottom: 16 }}>
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 14 }}
          message="如果回调页能正常打开，账户会自动入库，不需要用到下面的输入框。"
          description={
            isLocal
              ? '只有当回调地址无法从浏览器访问（比如本机防火墙、或部署在内网）时，才需要从浏览器地址栏复制 auth_code 手工兑换。注意 auth_code 只有 10 分钟有效期且只能用一次。'
              : '你从别的设备授权时，回调页通常会停在配置的中转地址上。把浏览器地址栏里那条完整地址（或其中的 auth_code）粘进下面的输入框即可 —— 直接粘整条地址更准确，因为里面带着 state。auth_code 只有 10 分钟有效期且只能用一次。'
          }
        />

        <Space.Compact style={{ width: '100%', marginBottom: 12 }}>
          <Input
            placeholder="粘贴整条回调地址，或其中的 auth_code"
            value={authCode}
            onChange={(e) => setAuthCode(e.target.value)}
          />
          <Button
            type="primary"
            disabled={!authCode.trim()}
            loading={exchangeMutation.isPending}
            onClick={() => exchangeMutation.mutate(authCode.trim())}
          >
            手工兑换
          </Button>
        </Space.Compact>

        <Tooltip title="对每份凭证重新拉取 approval/list，自动纳入新增账户、停用已解绑账户">
          <Button
            icon={<ReloadOutlined />}
            disabled={!configured}
            loading={resyncMutation.isPending}
            onClick={() => resyncMutation.mutate()}
          >
            重新对齐全部账户列表
          </Button>
        </Tooltip>
        <Typography.Text type="secondary" style={{ marginLeft: 12, fontSize: 12 }}>
          适用场景：授权当下没识别出账户、或罗盘 / 代理商下后来新增了账户
        </Typography.Text>
      </Card>

      <ShareCard />

      <div className="hint-block warn">
        <strong>关于「其他电脑也要用」—— 分两种情况：</strong>
        <br />
        <b>① 同一局域网 / 同一个办公网：</b>打开第 ④ 节「局域网共享」，其他电脑用浏览器访问主机地址、
        输入访问口令即可（授权只做一次，共用同一份数据）。共享使用者也可以在
        <b>第 ② 步自行授权</b>自己负责的账户 —— 账户会汇入同一个工作台。
        <br />
        <b>② 不在同一网络（异地 / 外网）：</b>让对方在自己电脑上装同一份程序，用第 ① 节的
        <b>「导入配置包」</b>还原开发者应用配置，然后<b>自行授权自己的广告账户</b> ——
        不需要再申请开发者应用，也不需要走授权共享。
        <br />
        <b>为什么不能直接把授权复制过去：</b>快手的 refresh_token 是轮换制 —— 每次刷新都会生成新
        token、老的立即失效，多台设备各存一份会互相踢下线。所以要么共享<b>同一个后端</b>，
        要么各自<b>重新授权一次</b>。
        <br />
        回调地址要被快手的服务器访问到，需要公网可达的域名 + HTTPS（或内网穿透）；没有的话，
        用第 ③ 节的「手工兑换」也能跑通全流程（粘贴整条回调地址最保险，里面带着 state）。
      </div>
    </div>
  );
}
