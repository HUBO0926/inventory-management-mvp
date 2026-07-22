import { useEffect, useState } from 'react';
import {
  AppstoreOutlined,
  ApartmentOutlined,
  CloseOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  HistoryOutlined,
  ImportOutlined,
  InboxOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  ReloadOutlined,
  SendOutlined,
  TeamOutlined,
  ToolOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Avatar, Button, Card, Drawer, Dropdown, Form, Input, Layout, Menu, Space, Spin, Tag, Tooltip, Typography, message } from 'antd';
import type { MenuProps } from 'antd';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api } from './api';
import { canAccessRole, statusText } from './domain';
import { DashboardPage } from './dashboard';
import { BomsPage, DocumentsPage, InventoryPage, ItemsPage, ProductionDetailPage, ProductionPage, TransactionsPage, UsersPage } from './pages';
import { useIsMobile } from './responsive';

const { Header, Sider, Content } = Layout;
const { Title, Text } = Typography;

export type User = { id: string; username: string; name: string; role: 'ADMIN' | 'WAREHOUSE' | 'PRODUCTION' };
export { statusText } from './domain';

const roleText: Record<User['role'], string> = { ADMIN: '系统管理员', WAREHOUSE: '仓库管理员', PRODUCTION: '生产人员' };

export const routes = [
  { key: '/', label: '库存驾驶舱', icon: <DashboardOutlined />, roles: ['ADMIN', 'WAREHOUSE', 'PRODUCTION'], group: 'cockpit' },
  { key: '/items', label: '物料管理', icon: <AppstoreOutlined />, roles: ['ADMIN'], group: 'master' },
  { key: '/boms', label: 'BOM 管理', icon: <ApartmentOutlined />, roles: ['ADMIN'], group: 'master' },
  { key: '/inbound', label: '原材料入库', icon: <InboxOutlined />, roles: ['ADMIN', 'WAREHOUSE'], group: 'stock' },
  { key: '/finished-inbound', label: '成品入库', icon: <ImportOutlined />, roles: ['ADMIN', 'WAREHOUSE'], group: 'stock' },
  { key: '/outbound', label: '成品出库', icon: <SendOutlined />, roles: ['ADMIN', 'WAREHOUSE'], group: 'stock' },
  { key: '/inventory', label: '当前库存', icon: <DatabaseOutlined />, roles: ['ADMIN', 'WAREHOUSE', 'PRODUCTION'], group: 'stock' },
  { key: '/transactions', label: '库存流水', icon: <HistoryOutlined />, roles: ['ADMIN', 'WAREHOUSE', 'PRODUCTION'], group: 'stock' },
  { key: '/production', label: '生产任务', icon: <ToolOutlined />, roles: ['ADMIN', 'WAREHOUSE', 'PRODUCTION'], group: 'production' },
  { key: '/users', label: '账号管理', icon: <TeamOutlined />, roles: ['ADMIN'], group: 'system' },
];
export const visibleRouteKeysForRole = (role: User['role']) => routes.filter(route => canAccessRole(route.roles, role)).map(route => route.key);

function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [loading, setLoading] = useState(false);
  const submit = async (values: any) => {
    setLoading(true);
    try {
      const data = await api('/auth/login', { method: 'POST', body: JSON.stringify(values) });
      localStorage.setItem('inventory_token', data.accessToken);
      onLogin(data.user);
      message.success('登录成功');
    } catch (error: any) {
      message.error(error.message);
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="login-wrap">
      <div className="login-brand">
        <div className="login-brand-icon"><DatabaseOutlined /></div>
        <Title>库存管理系统</Title>
        <Text>物料、生产与成品库存的完整业务闭环</Text>
        <div className="login-features">
          <span><strong>统一库存</strong><small>余额与流水实时可追溯</small></span>
          <span><strong>生产协同</strong><small>领退料与分次报产闭环</small></span>
          <span><strong>安全过账</strong><small>幂等、防超扣与冲销机制</small></span>
        </div>
      </div>
      <Card className="login-card">
        <div className="login-title">
          <Title level={2}>欢迎回来</Title>
          <Text type="secondary">请登录您的业务账号</Text>
        </div>
        <Form layout="vertical" size="large" initialValues={{ username: 'admin' }} onFinish={submit}>
          <Form.Item label="账号" name="username" rules={[{ required: true, message: '请输入账号' }]}><Input prefix={<UserOutlined />} autoFocus placeholder="请输入账号" /></Form.Item>
          <Form.Item label="密码" name="password" rules={[{ required: true, message: '请输入密码' }]}><Input.Password placeholder="请输入密码" /></Form.Item>
          <Button type="primary" htmlType="submit" block loading={loading}>登录系统</Button>
        </Form>
        <Text type="secondary" className="login-hint">演示账号：admin / warehouse / production</Text>
      </Card>
    </div>
  );
}

function Shell({ user, onLogout }: { user: User; onLogout: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const mobile = useIsMobile();
  const [collapsed, setCollapsed] = useState(window.innerWidth < 1200);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const currentPath = location.pathname.startsWith('/production/') ? '/production' : location.pathname;
  const currentRoute = routes.find(route => route.key === currentPath);
  const visibleKeys = visibleRouteKeysForRole(user.role);
  const visible = routes.filter(route => visibleKeys.includes(route.key));
  useEffect(() => {
    if (currentRoute && !canAccessRole(currentRoute.roles, user.role)) navigate('/', { replace: true });
  }, [currentRoute, navigate, user.role]);

  const groups = [
    { key: 'cockpit', label: '驾驶舱' },
    { key: 'master', label: '基础数据' },
    { key: 'stock', label: '库存作业' },
    { key: 'production', label: '生产管理' },
    { key: 'system', label: '系统管理' },
  ];
  const menuItems: MenuProps['items'] = groups.flatMap(group => {
    const children = visible.filter(route => route.group === group.key).map(({ key, label, icon }) => ({ key, label, icon }));
    return children.length ? [{ type: 'group' as const, label: group.label, children }] : [];
  });
  const userMenu: MenuProps['items'] = [
    { key: 'profile', label: `${user.name} · ${roleText[user.role]}`, disabled: true, icon: <UserOutlined /> },
    { type: 'divider' },
    { key: 'logout', label: '退出登录', icon: <LogoutOutlined />, danger: true },
  ];
  const openRoute = (key: string) => { navigate(key); setMobileMenuOpen(false); };
  const navigation = (compact = false) => <>
    <div className="app-logo">
      <DatabaseOutlined />
      {!compact && <span>库存管理</span>}
      {mobile && <Button className="mobile-nav-close" type="text" aria-label="关闭导航" icon={<CloseOutlined />} onClick={() => setMobileMenuOpen(false)} />}
    </div>
    <Menu theme="dark" mode="inline" selectedKeys={[currentPath]} items={menuItems} onClick={({ key }) => openRoute(key)} />
  </>;

  return (
    <Layout className="app-shell">
      {!mobile && <Sider
        width={220}
        collapsedWidth={72}
        collapsed={collapsed}
        className="app-sider"
        breakpoint="xl"
        trigger={null}
        onBreakpoint={broken => setCollapsed(broken)}
      >
        {navigation(collapsed)}
      </Sider>}
      <Drawer className="mobile-nav-drawer" placement="left" width="min(86vw, 320px)" closable={false} open={mobile && mobileMenuOpen} onClose={() => setMobileMenuOpen(false)}>
        <nav className="mobile-nav-panel" aria-label="主导航">{navigation(false)}</nav>
      </Drawer>
      <Layout className={`app-main ${mobile ? 'app-main-mobile' : collapsed ? 'app-main-collapsed' : ''}`}>
        <Header className="app-header">
          <Space size={14}>
            <Button className="header-icon-button" type="text" aria-label={mobile ? '打开导航' : collapsed ? '展开导航' : '折叠导航'} icon={mobile || collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={() => mobile ? setMobileMenuOpen(true) : setCollapsed(value => !value)} />
            <div className="header-title">
              <Text type="secondary">库存管理系统</Text>
              <Text strong>{currentRoute?.label || '业务详情'}</Text>
            </div>
          </Space>
          <Space size={10}>
            <Tooltip title="刷新当前数据"><Button className="header-icon-button" type="text" icon={<ReloadOutlined />} onClick={() => window.dispatchEvent(new Event('inventory:refresh'))} /></Tooltip>
            <Tag className="role-tag">{roleText[user.role]}</Tag>
            <Dropdown trigger={['click']} menu={{ items: userMenu, onClick: ({ key }) => key === 'logout' && onLogout() }} placement="bottomRight">
              <button className="user-trigger"><Avatar size={34} icon={<UserOutlined />} /><span>{user.name}</span></button>
            </Dropdown>
          </Space>
        </Header>
        <Content className="app-content">
          <Routes>
            <Route path="/" element={<DashboardPage user={user} />} />
            <Route path="/items" element={<ItemsPage user={user} />} />
            <Route path="/boms" element={<BomsPage />} />
            <Route path="/inbound" element={<DocumentsPage type="MATERIAL_INBOUND" />} />
            <Route path="/finished-inbound" element={<DocumentsPage type="FINISHED_INBOUND" />} />
            <Route path="/outbound" element={<DocumentsPage type="FINISHED_OUTBOUND" />} />
            <Route path="/production" element={<ProductionPage user={user} />} />
            <Route path="/production/:id" element={<ProductionDetailPage user={user} />} />
            <Route path="/inventory" element={<InventoryPage />} />
            <Route path="/transactions" element={<TransactionsPage />} />
            <Route path="/users" element={<UsersPage />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </Content>
      </Layout>
    </Layout>
  );
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(Boolean(localStorage.getItem('inventory_token')));
  useEffect(() => {
    if (!loading) return;
    api('/auth/me').then(setUser).catch(() => localStorage.removeItem('inventory_token')).finally(() => setLoading(false));
  }, []);
  if (loading) return <div className="login-wrap"><Spin size="large" /></div>;
  if (!user) return <Login onLogin={setUser} />;
  return <Shell user={user} onLogout={() => { localStorage.removeItem('inventory_token'); setUser(null); }} />;
}
