import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#1677ff',
          colorSuccess: '#16a34a',
          colorWarning: '#f59e0b',
          colorError: '#dc2626',
          colorBgLayout: '#f3f6fa',
          colorText: '#17233d',
          borderRadius: 10,
          fontFamily: 'Inter, "Microsoft YaHei", "PingFang SC", Arial, sans-serif',
        },
        components: {
          Card: { headerBg: 'transparent' },
          Table: { headerBg: '#f7f9fc', headerColor: '#475467', rowHoverBg: '#f7fbff' },
          Menu: { darkItemBg: '#0b1f3a', darkSubMenuItemBg: '#0b1f3a', darkItemSelectedBg: '#1677ff' },
        },
      }}
    >
      <BrowserRouter><App /></BrowserRouter>
    </ConfigProvider>
  </React.StrictMode>,
);
