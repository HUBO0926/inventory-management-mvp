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
  SafetyCertificateOutlined,
  EnvironmentOutlined,
  TagsOutlined,
  AuditOutlined,
  BulbOutlined,
  BellOutlined,
  FileDoneOutlined,
} from '@ant-design/icons';
import { Avatar, Badge, Button, Card, Drawer, Dropdown, Form, Input, Layout, Menu, Space, Spin, Tag, Tooltip, Typography, message } from 'antd';
import type { MenuProps } from 'antd';
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ApiError, api } from './api';
import { canAccessRole, statusText } from './domain';
import { DashboardPage } from './dashboard';
import { BomsPage } from './bom-page';
import { ProductionPage } from './production-list-page';
import { useIsMobile } from './responsive';
import { AuditPage, BatchesPage, RolesPage, SimpleMasterPage, StockDocumentsV110Page, UsersV110Page, WarehousesPage } from './v110-pages';
import { WarehouseVirtualMapPage } from './virtual-warehouse-page';
import { WarehouseManagementPage } from './warehouse-management-page';
import { WarehouseArchivePage } from './warehouse-archive-page';
import { MaterialDetailPage, MaterialFormPage, MaterialListPage } from './material-pages';
import { MaterialCategoriesPage } from './material-categories';
import { ApprovalsPage } from './approvals-page';
import { ProductionPickingPage } from './production-picking-page';
import { InventoryManagementPage } from './inventory-management-page';
import { NotificationsPage } from './notifications-page';

const { Header, Sider, Content } = Layout;
const { Title, Text } = Typography;

export type User = { id: string; username: string; name: string; employeeName?: string; department?: string; position?: string; role: string; roleId?: string; permissions?: string[]; isWarehouseManager?: boolean };
export { statusText } from './domain';

const roleText: Record<string, string> = { ADMIN: '系统管理员', WAREHOUSE: '仓库管理员', PRODUCTION: '生产人员' };

export const routes = [
  { key: '/', label: '库存驾驶舱', icon: <DashboardOutlined />, roles: ['ADMIN', 'WAREHOUSE', 'PRODUCTION'], permission: 'stock.view', group: 'cockpit' },

  // 库存中心
  { key: '/virtual-warehouse', label: '虚拟仓库', icon: <DatabaseOutlined />, roles: ['ADMIN', 'WAREHOUSE', 'PRODUCTION'], permission: 'warehouse.virtual.view', group: 'stock' },
  { key: '/approvals', label: '审核中心', icon: <FileDoneOutlined />, roles: ['ADMIN', 'WAREHOUSE', 'PRODUCTION'], permission: 'approval.view-own', group: 'stock' },
  { key: '/notifications', label: '消息中心', icon: <BellOutlined />, roles: ['ADMIN', 'WAREHOUSE', 'PRODUCTION'], group: 'stock' },
  { key: '/inventory/management', label: '库存管理', icon: <InboxOutlined />, roles: ['ADMIN', 'WAREHOUSE', 'PRODUCTION'], permission: 'inventory.view', permissionsAny: ['stock.view', 'inventory.view', 'inventory.report.view'], group: 'stock' },
  { key: '/inventory/warehouse-management', label: '仓库管理', icon: <EnvironmentOutlined />, roles: ['ADMIN', 'WAREHOUSE'], permission: 'warehouse.capacity.view', permissionsAny: ['inventory.view'], hiddenForRoles: ['PRODUCTION'], group: 'stock' },

  // 生产中心
  { key: '/production/tasks', label: '生产任务', icon: <ToolOutlined />, roles: ['ADMIN', 'WAREHOUSE', 'PRODUCTION'], permission: 'production.view', group: 'production' },

  // 资料中心
  { key: '/materials/raw', label: '原材料档案', icon: <AppstoreOutlined />, roles: ['ADMIN', 'WAREHOUSE', 'PRODUCTION'], permission: 'item.view', group: 'master' },
  { key: '/materials/finished', label: '成品档案', icon: <ImportOutlined />, roles: ['ADMIN', 'WAREHOUSE', 'PRODUCTION'], permission: 'item.view', group: 'master' },
  { key: '/material-categories', label: '物料分类', icon: <TagsOutlined />, roles: ['ADMIN', 'WAREHOUSE', 'PRODUCTION'], permission: 'category.view', group: 'master' },
  { key: '/boms', label: 'BOM档案', icon: <ApartmentOutlined />, roles: [], permission: 'bom.view', group: 'master' },
  { key: '/warehouse-archive', label: '仓储档案', icon: <EnvironmentOutlined />, roles: ['ADMIN'], permission: 'master.view', group: 'master' },

  // 系统管理
  { key: '/users', label: '账号管理', icon: <TeamOutlined />, roles: ['ADMIN'], permission: 'user.manage', group: 'system' },
  { key: '/roles', label: '角色权限', icon: <SafetyCertificateOutlined />, roles: ['ADMIN'], permission: 'role.manage', group: 'system' },
  { key: '/audit', label: '操作日志', icon: <AuditOutlined />, roles: ['ADMIN'], permission: 'audit.view', group: 'system' },
];
export const visibleRouteKeysForRole = (role: string) => routes.filter(route => canAccessRole(route.roles, role)).map(route => route.key);

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

function LegacyItemRedirect() {
  const { id } = useParams();
  return <Navigate to={id ? `/materials/${id}` : '/materials/raw'} replace />;
}

function PreserveQueryRedirect({ to }: { to: string }) {
  const location = useLocation();
  return <Navigate to={`${to}${location.search}`} replace />;
}

function LegacyInventoryRedirect({ tab }: { tab: 'documents' | 'flows' | 'reports' }) {
  const location = useLocation();
  const { id } = useParams();
  const query = new URLSearchParams(location.search);
  query.set('tab', tab);
  if (id && tab === 'documents') query.set('documentId', id);
  if (tab === 'reports' && !query.has('reportType')) query.set('reportType', 'current');
  return <Navigate to={`/inventory/management?${query}`} replace />;
}

function LegacyProductionRedirect({ pending = false }: { pending?: boolean }) {
  const location = useLocation();
  const query = new URLSearchParams(location.search);
  if (pending && !query.has('status')) query.set('status', 'pending');
  return <Navigate to={`/production/tasks${query.size ? `?${query}` : ''}`} replace />;
}

function Shell({ user, onLogout }: { user: User; onLogout: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const mobile = useIsMobile();
  const [collapsed, setCollapsed] = useState(() => {
    const saved = localStorage.getItem('inventory_sidebar_collapsed');
    return saved === null ? window.innerWidth < 1440 : saved === 'true';
  });
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [approvalCount, setApprovalCount] = useState(0);
  const [systemVersion, setSystemVersion] = useState('');
  const currentPath = location.pathname.startsWith('/production/tasks') ? '/production/tasks'
    : location.pathname.startsWith('/inventory/management') ? '/inventory/management'
      : location.pathname.startsWith('/inventory/warehouse-management') ? '/inventory/warehouse-management'
      : location.pathname;
  const currentRoute = routes.find(route => route.key === currentPath);
  const visibleKeys = visibleRouteKeysForRole(user.role);
  const canOpen = (route: typeof routes[number]) => !('hiddenForRoles' in route && route.hiddenForRoles?.includes(user.role)) && (user.role === 'ADMIN'
    || visibleKeys.includes(route.key)
    || Boolean(route.permission && user.permissions?.includes(route.permission))
    || Boolean('permissionsAny' in route && route.permissionsAny?.some(permission => user.permissions?.includes(permission))));
  const visible = routes.filter(canOpen);
  useEffect(() => { let alive=true; const refresh=async()=>{try{const s=await api('/approvals/statistics');if(alive)setApprovalCount(Number(s?.pendingMine||0));}catch{if(alive)setApprovalCount(0);}};void refresh();const timer=window.setInterval(refresh,60000);window.addEventListener('inventory:refresh',refresh);return()=>{alive=false;clearInterval(timer);window.removeEventListener('inventory:refresh',refresh);};},[user.id]);
  useEffect(() => {
    let alive = true;
    api('/system/version')
      .then(data => { if (alive) setSystemVersion(String(data?.version || '')); })
      .catch(() => { if (alive) setSystemVersion(''); });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    const adapt = () => {
      if (window.innerWidth < 768) return;
      if (localStorage.getItem('inventory_sidebar_collapsed') === null) setCollapsed(window.innerWidth < 1440);
    };
    window.addEventListener('resize', adapt);
    return () => window.removeEventListener('resize', adapt);
  }, []);
  useEffect(() => {
    if (currentRoute && !canOpen(currentRoute)) navigate('/', { replace: true });
  }, [currentRoute, navigate, user.role, user.permissions]);

  const groups = [
    { key: 'cockpit', label: '驾驶舱' },
    { key: 'master', label: '基础数据' },
    { key: 'stock', label: '库存作业' },
    { key: 'production', label: '生产管理' },
    { key: 'system', label: '系统管理' },
  ];
  const menuItems: MenuProps['items'] = groups.flatMap(group => {
    const children = visible.filter(route => route.group === group.key).map(({ key, label, icon }) => ({
      key,
      label: key === '/approvals' && user.role !== 'PRODUCTION'
        ? <Badge size="small" count={approvalCount} offset={[8, 0]}>{label}</Badge>
        : label,
      icon,
      className: key === '/approvals' ? 'approval-menu-item' : undefined,
    }));
    return children.length ? [{ type: 'group' as const, label: group.label, children }] : [];
  });
  const userMenu: MenuProps['items'] = [
    { key: 'profile', label: `${user.name} · ${roleText[user.role] || user.role}`, disabled: true, icon: <UserOutlined /> },
    { type: 'divider' },
    { key: 'logout', label: '退出登录', icon: <LogoutOutlined />, danger: true },
  ];
  const openRoute = (key: string) => { navigate(key); setMobileMenuOpen(false); };
  const toggleSidebar = () => {
    if (mobile) {
      setMobileMenuOpen(true);
      return;
    }
    setCollapsed(value => {
      localStorage.setItem('inventory_sidebar_collapsed', String(!value));
      return !value;
    });
  };
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
        trigger={null}
      >
        {navigation(collapsed)}
      </Sider>}
      <Drawer className="mobile-nav-drawer" placement="left" width="min(86vw, 320px)" closable={false} open={mobile && mobileMenuOpen} onClose={() => setMobileMenuOpen(false)}>
        <nav className="mobile-nav-panel" aria-label="主导航">{navigation(false)}</nav>
      </Drawer>
      <Layout className={`app-main ${mobile ? 'app-main-mobile' : collapsed ? 'app-main-collapsed' : ''}`}>
        <Header className="app-header">
          <Space size={14}>
            <Button className="header-icon-button" type="text" aria-label={mobile ? '打开导航' : collapsed ? '展开导航' : '折叠导航'} icon={mobile || collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={toggleSidebar} />
            <div className="header-breadcrumb"><Text type="secondary">运营中心</Text><span>/</span><Text strong>{currentRoute?.label || '业务详情'}</Text></div>
          </Space>
          <Space size={10}>
            <Tooltip title={systemVersion ? `系统版本 ${systemVersion}` : '版本信息暂不可用'}>
              <Tag className="version-tag">{systemVersion ? `V${systemVersion.replace(/^v/i, '')}` : '版本未知'}</Tag>
            </Tooltip>
            <Tooltip title="刷新当前数据"><Button aria-label="刷新当前数据" className="header-icon-button" type="text" icon={<ReloadOutlined />} onClick={() => window.dispatchEvent(new Event('inventory:refresh'))} /></Tooltip>
            <Tooltip title="切换浅色/深色主题"><Button aria-label="切换浅色/深色主题" className="header-icon-button" type="text" icon={<BulbOutlined />} onClick={() => window.dispatchEvent(new CustomEvent('inventory:theme-toggle'))} /></Tooltip>
            <Tooltip title="待审核单据"><Badge count={user.role==='PRODUCTION'?0:approvalCount} size="small"><Button aria-label="待审核单据" className="header-icon-button" type="text" icon={<BellOutlined />} onClick={()=>navigate('/approvals')} /></Badge></Tooltip>
            <Tag className="role-tag">{roleText[user.role] || user.role}</Tag>
            <Dropdown trigger={['click']} menu={{ items: userMenu, onClick: ({ key }) => key === 'logout' && onLogout() }} placement="bottomRight">
              <button className="user-trigger"><Avatar size={34} icon={<UserOutlined />} /><span>{user.name}</span></button>
            </Dropdown>
          </Space>
        </Header>
        <Content className="app-content">
          <Routes>
            <Route path="/" element={<DashboardPage user={user} />} />
              <Route path="/virtual-warehouse" element={<WarehouseVirtualMapPage user={user} />} />
              <Route path="/warehouse-virtual" element={<PreserveQueryRedirect to="/virtual-warehouse" />} />
              <Route path="/approvals" element={<ApprovalsPage user={user} />} />
              <Route path="/approvals/:id" element={<ApprovalsPage user={user} />} />
              <Route path="/notifications" element={<NotificationsPage />} />
              <Route path="/inventory/management" element={<InventoryManagementPage user={user} />} />
              <Route path="/inventory/warehouse-management" element={<WarehouseManagementPage user={user} />} />
              <Route path="/stock-documents" element={<LegacyInventoryRedirect tab="documents" />} />
              <Route path="/stock-documents/:id" element={<LegacyInventoryRedirect tab="documents" />} />
              <Route path="/stock-transactions" element={<LegacyInventoryRedirect tab="flows" />} />
              <Route path="/transactions" element={<LegacyInventoryRedirect tab="flows" />} />
              <Route path="/stock-reports" element={<LegacyInventoryRedirect tab="reports" />} />
              <Route path="/inventory" element={<LegacyInventoryRedirect tab="reports" />} />
              <Route path="/shortage-todo" element={<LegacyProductionRedirect pending />} />
              <Route path="/material-archive" element={<Navigate to="/materials/raw" replace />} />
              <Route path="/warehouse-archive" element={<WarehouseArchivePage />} />
              <Route path="/system-settings" element={<Navigate to="/" replace />} />
            <Route path="/materials/raw" element={<MaterialListPage type="MATERIAL" user={user} />} />
            <Route path="/materials/finished" element={<MaterialListPage type="FINISHED_GOOD" user={user} />} />
            <Route path="/materials/new" element={<MaterialFormPage user={user} />} />
            <Route path="/materials/:id/edit" element={<MaterialFormPage user={user} />} />
            <Route path="/materials/:id" element={<MaterialDetailPage user={user} />} />
            <Route path="/items" element={<Navigate to="/materials/raw" replace />} />
            <Route path="/items/:id" element={<LegacyItemRedirect />} />
            <Route path="/material-categories" element={<MaterialCategoriesPage user={user} />} />
            <Route path="/categories" element={<Navigate to="/material-categories" replace />} />
            <Route path="/units" element={<SimpleMasterPage kind="units" />} />
            <Route path="/warehouses" element={<WarehousesPage />} />
            <Route path="/location-capacity" element={<PreserveQueryRedirect to="/inventory/warehouse-management" />} />
            <Route path="/locations" element={<PreserveQueryRedirect to="/inventory/warehouse-management" />} />
            <Route path="/batches" element={<BatchesPage />} />
            <Route path="/boms" element={<BomsPage user={user} />} />
            <Route path="/inbound" element={<StockDocumentsV110Page type="MATERIAL_INBOUND" />} />
            <Route path="/finished-inbound" element={<StockDocumentsV110Page type="FINISHED_INBOUND" />} />
            <Route path="/outbound" element={<StockDocumentsV110Page type="FINISHED_OUTBOUND" />} />
            <Route path="/adjustments" element={<StockDocumentsV110Page type="INVENTORY_ADJUSTMENT" />} />
            <Route path="/moves" element={<StockDocumentsV110Page type="STOCK_MOVE" />} />
            <Route path="/production" element={<LegacyProductionRedirect />} />
            <Route path="/production/tasks" element={<ProductionPage user={user} />} />
            <Route path="/production/tasks/:id" element={<ProductionPickingPage user={user} />} />
            <Route path="/production/:id" element={<ProductionPickingPage user={user} />} />
            <Route path="/users" element={<UsersV110Page />} />
            <Route path="/roles" element={<RolesPage />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="/about" element={<Navigate to="/" replace />} />
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
    api('/auth/me').then(setUser).catch((error: unknown) => {
      // 导航或网络中断会取消正在进行的鉴权请求；只有服务端明确拒绝令牌时才清除会话。
      if (error instanceof ApiError && [401, 403].includes(error.status)) localStorage.removeItem('inventory_token');
    }).finally(() => setLoading(false));
  }, []);
  if (loading) return <div className="login-wrap"><Spin size="large" /></div>;
  if (!user) return <Login onLogin={setUser} />;
  return <Shell user={user} onLogout={() => { localStorage.removeItem('inventory_token'); setUser(null); }} />;
}
