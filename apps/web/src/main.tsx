import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, theme as antdTheme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles.css';

function Root() {
  const [dark, setDark] = useState(localStorage.getItem('inventory_theme') === 'dark');
  useEffect(() => {
    const toggle = () => setDark(value => !value);
    window.addEventListener('inventory:theme-toggle', toggle);
    return () => window.removeEventListener('inventory:theme-toggle', toggle);
  }, []);
  useEffect(() => {
    localStorage.setItem('inventory_theme', dark ? 'dark' : 'light');
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  return <ConfigProvider
    locale={zhCN}
    theme={{
      algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
      token: {
        colorPrimary: '#1677ff', colorSuccess: '#16a34a', colorWarning: '#f59e0b', colorError: '#dc2626',
        colorBgLayout: dark ? '#101827' : '#f3f6fa', colorText: dark ? '#e5edf8' : '#17233d',
        borderRadius: 10, fontFamily: 'Inter, "Microsoft YaHei", "PingFang SC", Arial, sans-serif',
      },
      components: {
        Card: { headerBg: 'transparent' },
        Table: { headerBg: dark ? '#182235' : '#f7f9fc', headerColor: dark ? '#c6d3e6' : '#475467', rowHoverBg: dark ? '#1b2940' : '#f7fbff' },
        Menu: { darkItemBg: '#0b1f3a', darkSubMenuItemBg: '#0b1f3a', darkItemSelectedBg: '#1677ff' },
      },
    }}
  ><BrowserRouter><App /></BrowserRouter></ConfigProvider>;
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><Root /></React.StrictMode>);
