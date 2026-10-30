import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 盯盘数据靠手动/定时刷新，窗口聚焦时重拉可以减少无谓请求
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 15_000,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
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
      <AntApp>
        {/* HashRouter：为后续 Electron 以 file:// 加载做准备，避免 BrowserRouter 白屏 */}
        <HashRouter>
          <QueryClientProvider client={queryClient}>
            <App />
          </QueryClientProvider>
        </HashRouter>
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);
