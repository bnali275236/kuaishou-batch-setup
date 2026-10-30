import { CopyOutlined, DownloadOutlined, ExportOutlined, ImportOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Input, Modal, Space, Typography } from 'antd';
import { useState } from 'react';
import { api, explainError } from '../../api/client';

interface ExportResult {
  payload: string;
  fileName: string;
  appId: string;
  redirectUri: string;
  scopes: string[];
}

/**
 * 应用配置迁移 —— 给「不在同一网络」的同事用。
 *
 * 为什么不直接让他们自己配：开发者应用（app_id / app_secret）是团队唯一的，
 * 让每个人去开放平台建一个应用既不现实、授权结果也无法互通。
 * 打包发过去，导入后对方立刻具备同样的授权能力，再各自授权自己的广告账户。
 *
 * 安全：包里只含应用凭据（用迁移口令 scrypt + AES-256-GCM 加密），
 * **不含任何访问令牌** —— token 是设备绑定的，复制只会互相踢下线。
 */
export default function PortableConfigPanel({ configured }: { configured: boolean }) {
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<'none' | 'export' | 'import'>('none');
  const [passphrase, setPassphrase] = useState('');
  const [incoming, setIncoming] = useState('');
  const [result, setResult] = useState<ExportResult | null>(null);

  const close = () => {
    setOpen('none');
    setPassphrase('');
    setIncoming('');
    setResult(null);
  };

  const exportMutation = useMutation({
    mutationFn: (pwd: string) =>
      api.post<ExportResult>('/api/settings/app/export', { passphrase: pwd }),
    onSuccess: (data) => {
      setResult(data);
      message.success('迁移包已生成');
    },
    onError: (err) => modal.error({ title: '导出失败', content: explainError(err) }),
  });

  const importMutation = useMutation({
    mutationFn: (v: { payload: string; passphrase: string }) =>
      api.post('/api/settings/app/import', v),
    onSuccess: () => {
      message.success('配置已导入 —— 现在可以直接生成授权链接了');
      close();
      void queryClient.invalidateQueries({ queryKey: ['app-config'] });
    },
    onError: (err) => modal.error({ title: '导入失败', content: explainError(err) }),
  });

  const download = () => {
    if (!result) return;
    const blob = new Blob([result.payload], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = result.fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  return (
    <>
      <div
        style={{
          marginTop: 16,
          paddingTop: 14,
          borderTop: '1px dashed rgba(0,0,0,.09)',
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6 }}>
          给「不在同一网络的同事」—— 一键迁移应用配置
        </div>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, lineHeight: 1.8 }}>
          同一个局域网里的人，直接开第 ④ 节共享即可；如果对方在外网 / 异地连不上你，
          把配置打包发过去，他在自己电脑<b>导入后就能自行授权自己的广告账户</b>，
          不用再申请开发者应用。包里只有应用凭据、<b>没有任何登录令牌</b>，并用你设的口令加密。
        </Typography.Paragraph>
        <Space wrap>
          <Button
            icon={<ExportOutlined />}
            disabled={!configured}
            onClick={() => setOpen('export')}
          >
            导出配置包
          </Button>
          <Button icon={<ImportOutlined />} onClick={() => setOpen('import')}>
            导入配置包
          </Button>
        </Space>
      </div>

      {/* ——— 导出 ——— */}
      <Modal
        open={open === 'export'}
        title="导出应用配置迁移包"
        onCancel={close}
        footer={
          result
            ? [
                <Button key="copy" icon={<CopyOutlined />} onClick={() => {
                  void navigator.clipboard?.writeText(result.payload);
                  message.success('已复制迁移包内容');
                }}>
                  复制内容
                </Button>,
                <Button key="dl" type="primary" icon={<DownloadOutlined />} onClick={download}>
                  下载文件
                </Button>,
              ]
            : [
                <Button key="cancel" onClick={close}>
                  取消
                </Button>,
                <Button
                  key="ok"
                  type="primary"
                  loading={exportMutation.isPending}
                  disabled={passphrase.trim().length < 6}
                  onClick={() => exportMutation.mutate(passphrase.trim())}
                >
                  生成迁移包
                </Button>,
              ]
        }
      >
        {!result ? (
          <>
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 14 }}
              message="设一个迁移口令，并通过另一条渠道告诉对方"
              description="口令用于加密迁移包里的 app_secret。建议通过电话/口头告知，不要和迁移包放在同一条消息里发送。"
            />
            <Input.Password
              placeholder="迁移口令（至少 6 位）"
              value={passphrase}
              autoFocus
              onChange={(e) => setPassphrase(e.target.value)}
              onPressEnter={() => {
                if (passphrase.trim().length >= 6) exportMutation.mutate(passphrase.trim());
              }}
              autoComplete="new-password"
            />
          </>
        ) : (
          <>
            <Alert
              type="success"
              showIcon
              style={{ marginBottom: 14 }}
              message={`迁移包已生成（app_id ${result.appId}）`}
              description="发给需要在自己电脑上使用工作台的同事，并另行告知迁移口令。对方在「接入设置」第 ① 节用「导入配置包」还原即可。"
            />
            <Input.TextArea
              rows={5}
              readOnly
              value={result.payload}
              style={{ fontFamily: 'ui-monospace,Consolas,monospace', fontSize: 11 }}
            />
          </>
        )}
      </Modal>

      {/* ——— 导入 ——— */}
      <Modal
        open={open === 'import'}
        title="导入应用配置迁移包"
        onCancel={close}
        okText="导入并覆盖本机配置"
        confirmLoading={importMutation.isPending}
        okButtonProps={{
          disabled: !incoming.trim() || passphrase.trim().length === 0,
        }}
        onOk={() =>
          importMutation.mutate({ payload: incoming.trim(), passphrase: passphrase.trim() })
        }
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message="导入会覆盖这台电脑上的开发者应用配置"
          description="如果这台电脑上已经有自己的授权，导入后请用「重新对齐全部账户列表」确认账户仍可访问；原配置对应的授权不会自动删除。"
        />
        <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6 }}>迁移包内容</div>
        <Input.TextArea
          rows={5}
          placeholder="粘贴以 WKBD-CONFIG-V1. 开头的整段内容"
          value={incoming}
          style={{ fontFamily: 'ui-monospace,Consolas,monospace', fontSize: 11, marginBottom: 14 }}
          onChange={(e) => setIncoming(e.target.value)}
        />
        <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6 }}>迁移口令</div>
        <Input.Password
          placeholder="向主机索取迁移口令"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          autoComplete="new-password"
        />
      </Modal>
    </>
  );
}
