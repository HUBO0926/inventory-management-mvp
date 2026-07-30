import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Alert,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Drawer,
  Empty,
  Input,
  Pagination,
  Progress,
  Result,
  Segmented,
  Select,
  Skeleton,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  AlertOutlined,
  ArrowRightOutlined,
  AuditOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  DatabaseOutlined,
  FileDoneOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  InboxOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  ThunderboltOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import type { User } from './App';
import { api } from './api';
import { EChart } from './chart';
import { SectionCard } from './components';
import {
  dashboardApiQuery,
  dashboardDetailRoute,
  dashboardFilters,
  dashboardQuery,
  dashboardTrendRangeLabel,
  type DashboardFilters,
  type IntegratedCockpit,
} from './dashboard-model';
import { formatBeijingTime, formatQuantity, statusText } from './domain';
import { useIsMobile } from './responsive';

const { Text, Title } = Typography;
const inventoryTypeOptions = [
  { label: '全部库存', value: 'ALL' },
  { label: '原材料库', value: 'RAW' },
  { label: '成品库', value: 'FG' },
  { label: '不良品库', value: 'DEFECTIVE' },
];
const periodOptions = [
  { label: '今日', value: 'TODAY' },
  { label: '最近 7 天', value: '7D' },
  { label: '最近 30 天', value: '30D' },
];
const productionStatusOptions = [
  { label: '全部任务', value: 'ALL' },
  { label: '草稿', value: 'DRAFT' },
  { label: '已发布', value: 'RELEASED' },
  { label: '待领料', value: 'AWAITING_ISSUE' },
  { label: '生产中', value: 'IN_PROGRESS' },
  { label: '待完工', value: 'AWAITING_COMPLETION' },
  { label: '已完成', value: 'COMPLETED' },
  { label: '已关闭', value: 'CLOSED' },
  { label: '已取消', value: 'CANCELLED' },
];
const inventoryStatusOptions = [
  { label: '全部状态', value: 'ALL' },
  { label: '正常', value: 'NORMAL' },
  { label: '低库存', value: 'LOW' },
  { label: '零库存', value: 'ZERO' },
  { label: '已锁定', value: 'LOCKED' },
  { label: '存在不良品', value: 'DEFECTIVE' },
];
const warehouseTypeText: Record<string, string> = { RAW: '原材料库', FG: '成品库', DEFECTIVE: '不良品库' };
const operationTypes = [
  'MATERIAL_INBOUND',
  'PRODUCTION_ISSUE',
  'PRODUCTION_RETURN',
  'FINISHED_INBOUND',
  'FINISHED_OUTBOUND',
  'STOCK_MOVE',
  'INVENTORY_ADJUSTMENT',
];
const riskTypeText: Record<string, string> = {
  ZERO_STOCK: '零库存',
  LOW_STOCK: '低库存',
  MATERIAL_SHORTAGE: '生产缺料',
  DELAYED_TASK: '任务延期',
  PENDING_ISSUE: '待领料',
  COMPLETION_PENDING: '完工待审',
  APPROVAL_OVERDUE: '审批超时',
  PENDING_APPROVAL: '待审批',
  DEFECTIVE_PENDING: '不良品待处理',
  MATERIAL_QUALITY: '原材料质量',
  PRODUCTION_QUALITY: '生产质量',
};
const productionStatuses = ['RELEASED', 'AWAITING_ISSUE', 'IN_PROGRESS', 'AWAITING_COMPLETION', 'COMPLETED'];
const trendSeries = [
  ['MATERIAL_INBOUND', '原材料入库', '#2563eb'],
  ['PRODUCTION_ISSUE', '生产领料', '#f59e0b'],
  ['PRODUCTION_RETURN', '生产退料', '#14b8a6'],
  ['PRODUCTION_COMPLETION', '成品入库', '#7c3aed'],
  ['FINISHED_OUTBOUND', '成品出库', '#ef4444'],
] as const;

function MainMetric({
  label,
  value,
  unit,
  description,
  tone = 'primary',
  icon,
  children,
  onClick,
  disabled,
}: {
  label: string;
  value: string | number;
  unit?: string;
  description: string;
  tone?: string;
  icon: ReactNode;
  children?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button className={`cockpit-main-metric cockpit-main-metric-${tone}`} onClick={onClick} disabled={disabled || !onClick}>
      <span className="cockpit-main-metric-head"><span>{label}</span><i>{icon}</i></span>
      <span className="cockpit-main-metric-value"><strong>{disabled ? '—' : value}</strong>{unit ? <b>{unit}</b> : null}</span>
      <span className="cockpit-main-metric-units">{disabled ? null : children}</span>
      <small>{disabled ? '当前账号不可查看' : description}</small>
      {!disabled && onClick ? <span className="metric-drill">查看详情 <ArrowRightOutlined /></span> : null}
    </button>
  );
}

function AuxiliaryMetric({
  label,
  value,
  helper,
  tone = 'primary',
  icon,
  onClick,
  disabled,
}: {
  label: string;
  value: string | number;
  helper: string;
  tone?: string;
  icon: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button className={`cockpit-aux-metric cockpit-aux-metric-${tone}`} onClick={onClick} disabled={disabled || !onClick}>
      <i>{icon}</i>
      <span><small>{label}</small><strong>{disabled ? '—' : value}</strong><em>{disabled ? '无查看权限' : helper}</em></span>
      {!disabled && onClick ? <ArrowRightOutlined className="aux-arrow" /> : null}
    </button>
  );
}

function DashboardSkeleton() {
  return (
    <div className="integrated-cockpit cockpit-skeleton" aria-label="驾驶舱加载中">
      <div className="cockpit-metric-layout">
        <div className="cockpit-main-metric-grid">{Array.from({ length: 4 }, (_, index) => <Card key={index}><Skeleton active paragraph={{ rows: 2 }} /></Card>)}</div>
        <div className="cockpit-aux-metric-grid">{Array.from({ length: 4 }, (_, index) => <Card key={index}><Skeleton active paragraph={false} /></Card>)}</div>
      </div>
      <div className="cockpit-overview-grid">{Array.from({ length: 2 }, (_, index) => <Card key={index}><Skeleton active paragraph={{ rows: 5 }} /></Card>)}</div>
      <div className="cockpit-execution-grid">{Array.from({ length: 2 }, (_, index) => <Card key={index}><Skeleton active paragraph={{ rows: 5 }} /></Card>)}</div>
      <div className="cockpit-bottom-grid">{Array.from({ length: 2 }, (_, index) => <Card key={index}><Skeleton active paragraph={{ rows: 6 }} /></Card>)}</div>
    </div>
  );
}

function InventoryCenterPanel({
  title,
  center,
  pageKey,
  setFilters,
  navigate,
}: {
  title: string;
  center: IntegratedCockpit['inventoryCenters']['raw'];
  pageKey: 'rawPage' | 'finishedPage';
  setFilters: (patch: Partial<DashboardFilters>) => void;
  navigate: (to: string) => void;
}) {
  const statusColor: Record<string, string> = { ZERO: 'error', LOW: 'warning', LOCKED: 'processing', DEFECTIVE: 'magenta', NORMAL: 'success' };
  const statusLabel: Record<string, string> = { ZERO: '零库存', LOW: '低库存', LOCKED: '已锁定', DEFECTIVE: '有不良品', NORMAL: '正常' };
  const columns = [
    { title: '物料', key: 'item', render: (_: unknown, row: any) => <button className="inventory-item-link" onClick={() => navigate(`/inventory/management?tab=current&warehouseId=${row.warehouseId}&itemId=${row.itemId}`)}><strong>{row.itemName}</strong><small>{row.itemCode} · {row.model || row.spec || '暂无型号规格'}</small></button> },
    { title: '仓库', dataIndex: 'warehouseCode', key: 'warehouseCode', width: 88 },
    { title: '当前', dataIndex: 'currentQty', key: 'currentQty', width: 72, render: (value: string, row: any) => `${formatQuantity(value)} ${row.unit}` },
    { title: '冻结/预占', key: 'locked', width: 104, render: (_: unknown, row: any) => `${formatQuantity(row.frozenQty)} / ${formatQuantity(row.reservedQty)}` },
    { title: '可用', dataIndex: 'availableQty', key: 'availableQty', width: 72, render: (value: string, row: any) => <strong>{formatQuantity(value)} {row.unit}</strong> },
    { title: '安全/缺口', key: 'shortage', width: 104, render: (_: unknown, row: any) => <span className={Number(row.shortageQty) ? 'quantity-risk' : ''}>{formatQuantity(row.minimumStock)} / {formatQuantity(row.shortageQty)}</span> },
    { title: '状态', dataIndex: 'inventoryStatus', key: 'inventoryStatus', width: 82, render: (value: string) => <Tag color={statusColor[value]}>{statusLabel[value] || value}</Tag> },
  ];
  const { summary } = center;
  return (
    <SectionCard title={title} subtitle="按仓库＋物料核算，数量不跨单位合计" className={`dashboard-module ${pageKey === 'rawPage' ? 'dashboard-module-raw' : 'dashboard-module-finished'}`} extra={<Button type="link" onClick={() => navigate('/inventory/management?tab=current')}>查看全部</Button>}>
      <div className="inventory-center-summary">
        <span><strong>{summary.totalItems}</strong><small>物料种类</small></span>
        <span><strong>{summary.stockedItems}</strong><small>有库存</small></span>
        <span className="is-warning"><strong>{summary.lowItems}</strong><small>低库存</small></span>
        <span className="is-danger"><strong>{summary.zeroItems}</strong><small>零库存</small></span>
        <span><strong>{summary.lockedItems}</strong><small>锁定/预占</small></span>
        <span><strong>{summary.defectiveItems}</strong><small>存在不良</small></span>
      </div>
      <Table rowKey={row => `${row.warehouseId}-${row.itemId}`} className="inventory-center-table" size="small" pagination={false} columns={columns} dataSource={center.rows} scroll={{ x: 760 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前筛选下暂无物料" /> }} />
      {center.pagination.total > center.pagination.pageSize ? <Pagination size="small" current={center.pagination.page} pageSize={center.pagination.pageSize} total={center.pagination.total} showSizeChanger={false} onChange={page => setFilters({ [pageKey]: page })} /> : null}
    </SectionCard>
  );
}

function QualityPanel({ title, quality, onOpen }: { title: string; quality: IntegratedCockpit['materialQuality']; onOpen: (row: any) => void }) {
  if (!quality) return <SectionCard title={title}><Empty description="当前账号无查看权限" /></SectionCard>;
  const rateText = quality.displayMode === 'BY_UNIT' ? '分单位' : `${quality.overallRate ?? 0}%`;
  const tone = quality.level.toLowerCase();
  return (
    <SectionCard title={title} subtitle={quality.thresholds.configured ? `阈值：关注 ${quality.thresholds.warning}% / 严重 ${quality.thresholds.critical}%` : '未配置质量阈值，仅中性展示真实比率'} className={`dashboard-module dashboard-module-quality quality-panel quality-${tone}`}>
      <div className="quality-overview">
        <div className="quality-gauge"><Progress type="dashboard" percent={quality.overallRate ?? 0} strokeColor={quality.level === 'NEUTRAL' ? '#64748b' : undefined} format={() => rateText} /><span>不良率</span></div>
        <div className="quality-unit-grid">{quality.byUnit.map(row => <span key={row.unit}><strong>{row.defectRate}%</strong><small>{row.unit} · 检验/生产 {row.inspectedQty} · 不良 {row.defectiveQty}</small></span>)}</div>
      </div>
      <div className="quality-top-list">
        {quality.top.slice(0, 3).map(row => <button key={row.id} onClick={() => onOpen(row)}><span><strong>{row.code || '未关联编号'}</strong><small>{row.name}</small></span><b>{row.defectRate}%</b><em>{row.defectiveQty} / {row.inspectedQty} {row.unit}</em><ArrowRightOutlined /></button>)}
        {!quality.top.length ? <div className="business-empty compact"><CheckCircleOutlined /><strong>当前周期暂无已生效质量数据</strong><span>待审核及已冲销单据不计入统计</span></div> : null}
      </div>
      <div className="quality-reasons">{quality.reasons.map(row => <Tag key={row.reason}>{row.reason} · {row.quantity}</Tag>)}{!quality.reasons.length ? <Text type="secondary">暂无不良原因记录</Text> : null}</div>
    </SectionCard>
  );
}

export function DashboardPage({ user: _user }: { user: User }) {
  const mobile = useIsMobile();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => dashboardFilters(searchParams), [searchParams]);
  const [data, setData] = useState<IntegratedCockpit>();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<any>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [fullscreen, setFullscreen] = useState(Boolean(document.fullscreenElement));
  const [trendMetric, setTrendMetric] = useState<'QUANTITY' | 'SKU' | 'DOCUMENT'>('SKU');
  const [trendUnit, setTrendUnit] = useState<string>();
  const requestSequence = useRef(0);

  useEffect(() => {
    const onFullscreen = () => {
      const active = Boolean(document.fullscreenElement);
      setFullscreen(active);
      document.body.classList.toggle('dashboard-fullscreen', active);
    };
    document.addEventListener('fullscreenchange', onFullscreen);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreen);
      document.body.classList.remove('dashboard-fullscreen');
    };
  }, []);

  useEffect(() => {
    const normalized = dashboardQuery(filters);
    const detailType = searchParams.get('detailType');
    const detailId = searchParams.get('detailId');
    if (detailType && detailId) {
      normalized.set('detailType', detailType);
      normalized.set('detailId', detailId);
    }
    if (normalized.toString() !== searchParams.toString()) setSearchParams(normalized, { replace: true });
  }, [filters, searchParams, setSearchParams]);

  const setFilters = useCallback((patch: Partial<DashboardFilters>) => {
    const next = { ...filters, ...patch };
    const preserved = new URLSearchParams(dashboardQuery(next));
    const detailType = searchParams.get('detailType');
    const detailId = searchParams.get('detailId');
    if (detailType && detailId) {
      preserved.set('detailType', detailType);
      preserved.set('detailId', detailId);
    }
    setSearchParams(preserved);
  }, [filters, searchParams, setSearchParams]);

  const load = useCallback(async (silent = false) => {
    const sequence = ++requestSequence.current;
    if (silent || data) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      const next = await api(`/dashboard/integrated-cockpit?${dashboardApiQuery(filters)}`) as IntegratedCockpit;
      if (sequence !== requestSequence.current) return;
      if (filters.warehouseId && !next.filterOptions.warehouses.some(row => row.id === filters.warehouseId)) {
        setFilters({ warehouseId: undefined });
        return;
      }
      setData(next);
    } catch (loadError: any) {
      if (sequence !== requestSequence.current || loadError?.name === 'AbortError') return;
      setError(loadError.message || '驾驶舱加载失败');
    } finally {
      if (sequence === requestSequence.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [data, filters, setFilters]);

  useEffect(() => { void load(); }, [
    filters.warehouseId, filters.keyword, filters.inventoryType, filters.inventoryStatus, filters.period,
    filters.productionStatus, filters.categoryId, filters.dateFrom, filters.dateTo, filters.rawPage, filters.finishedPage,
  ]);
  useEffect(() => {
    const refresh = () => void load(true);
    window.addEventListener('inventory:refresh', refresh);
    const timer = window.setInterval(() => { if (!document.hidden) refresh(); }, 60_000);
    return () => {
      window.removeEventListener('inventory:refresh', refresh);
      window.clearInterval(timer);
    };
  }, [load]);

  const detailType = searchParams.get('detailType') || '';
  const detailId = searchParams.get('detailId') || '';
  const openDetail = (type: string, id: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('detailType', type);
    next.set('detailId', id);
    setSearchParams(next);
  };
  const closeDetail = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('detailType');
    next.delete('detailId');
    setSearchParams(next);
  };

  useEffect(() => {
    if (!detailType || !detailId) {
      setDetail(undefined);
      setDetailError('');
      return;
    }
    const risk = data?.riskCenter.items.find(row => String(row.id) === detailId);
    if (detailType === 'risk' && risk) {
      setDetail(risk);
      return;
    }
    const path = detailType === 'warehouse'
      ? `/warehouses/${detailId}`
      : detailType === 'task'
        ? `/production-orders/${detailId}`
        : detailType === 'document'
          ? `/stock-documents/${detailId}`
          : '';
    if (!path) return;
    let alive = true;
    setDetailLoading(true);
    setDetailError('');
    api(path)
      .then(value => alive && setDetail(value))
      .catch((detailLoadError: any) => alive && setDetailError(detailLoadError.message || '详情加载失败'))
      .finally(() => alive && setDetailLoading(false));
    return () => { alive = false; };
  }, [data, detailId, detailType]);

  const toggleFullscreen = async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  };

  const trendUnits = useMemo(() => [...new Set((data?.inventoryTrendDetails || []).map(row => row.unit).filter(Boolean))], [data]);
  useEffect(() => {
    if (trendMetric === 'QUANTITY' && (!trendUnit || !trendUnits.includes(trendUnit))) setTrendUnit(trendUnits[0]);
  }, [trendMetric, trendUnit, trendUnits]);
  const trendRows = useMemo(() => {
    const grouped = new Map<string, Record<string, any>>();
    for (const row of data?.inventoryTrendDetails || []) {
      if (trendMetric === 'QUANTITY' && row.unit !== trendUnit) continue;
      const current = grouped.get(row.date) || { date: row.date };
      const key = row.documentType;
      current[key] = (current[key] || 0) + Number(trendMetric === 'QUANTITY' ? row.quantity : trendMetric === 'DOCUMENT' ? row.documentCount : row.skuCount);
      grouped.set(row.date, current);
    }
    return [...grouped.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }, [data, trendMetric, trendUnit]);
  const trendOption = useMemo(() => ({
    tooltip: {
      trigger: 'axis' as const,
      backgroundColor: '#10213a',
      borderWidth: 0,
      textStyle: { color: '#fff' },
      formatter: (params: any[]) => {
        const date = trendRows[params[0]?.dataIndex]?.date || '';
        const lines = params.filter(row => Number(row.value) !== 0).map(row => {
          const series = trendSeries.find(([, name]) => name === row.seriesName);
          const details = (data?.inventoryTrendDetails || []).filter(detail =>
            detail.date === date && detail.documentType === series?.[0]
            && (trendMetric !== 'QUANTITY' || detail.unit === trendUnit));
          const documents = details.reduce((sum, detail) => sum + Number(detail.documentCount || 0), 0);
          const tasks = details.reduce((sum, detail) => sum + Number(detail.taskCount || 0), 0);
          const suffix = trendMetric === 'QUANTITY' ? ` ${trendUnit || ''}` : trendMetric === 'DOCUMENT' ? ' 单' : ' SKU';
          return `${row.marker}${row.seriesName}：${row.value}${suffix}<span style="color:#cbd5e1"> · ${documents} 单据 · ${tasks} 任务</span>`;
        });
        return [`<strong>${date}</strong>`, ...lines].join('<br/>');
      },
    },
    legend: { top: 0, right: 0, icon: 'circle', itemWidth: 8, textStyle: { color: '#475569', fontSize: 12 } },
    grid: { left: 12, right: 18, top: 42, bottom: 12, containLabel: true },
    xAxis: {
      type: 'category' as const,
      data: trendRows.map(row => String(row.date).slice(5)),
      axisTick: { show: false },
      axisLine: { lineStyle: { color: '#dbe4ef' } },
      axisLabel: { color: '#64748b', fontSize: 12 },
    },
    yAxis: { type: 'value' as const, minInterval: 1, axisLabel: { color: '#64748b', fontSize: 12 }, splitLine: { lineStyle: { color: '#e2e8f0' } } },
    series: trendSeries.map(([key, name, color]) => ({
      name, type: 'line' as const, smooth: true, showSymbol: true, symbol: 'circle', symbolSize: 7,
      data: trendRows.map(row => row[key] || 0),
      lineStyle: { width: 3, color },
      itemStyle: { color, borderColor: '#fff', borderWidth: 2 },
      emphasis: { focus: 'series' as const, scale: 1.2 },
    })),
  }), [data, trendMetric, trendRows, trendUnit]);

  if (loading && !data) {
    return <main className="dashboard-page"><DashboardHeader filters={filters} data={data} setFilters={setFilters} refreshing={false} fullscreen={fullscreen} onFullscreen={toggleFullscreen} onRefresh={() => load()} /><DashboardSkeleton /></main>;
  }
  if (error && !data) {
    return <main className="dashboard-page"><DashboardHeader filters={filters} data={data} setFilters={setFilters} refreshing={false} fullscreen={fullscreen} onFullscreen={toggleFullscreen} onRefresh={() => load()} /><Card><Result status="error" title="驾驶舱暂时无法加载" subTitle={error} extra={<Button type="primary" icon={<ReloadOutlined />} onClick={() => load()}>重新加载</Button>} /></Card></main>;
  }
  if (data && !data.capabilities.dashboard) {
    return <main className="dashboard-page"><Result status="403" icon={<SafetyCertificateOutlined />} title="暂无驾驶舱访问权限" subTitle="请联系管理员为当前账号配置库存、仓储、生产或审核查看权限。" /></main>;
  }
  if (!data) return null;

  const { kpis } = data;
  const riskTotal = Object.values(data.riskCenter.summary || {}).reduce((sum, value) => sum + Number(value || 0), 0);
  const keyword = (filters.keyword || '').trim().toLowerCase();
  const matches = (...values: unknown[]) => !keyword || values.some(value => String(value || '').toLowerCase().includes(keyword));
  const visibleTasks = data.productionExecution.tasks.filter(row => productionStatuses.includes(row.status) && matches(row.orderNo, row.itemCode, row.itemName));
  const visibleMaterials = data.materialReadiness.materials.filter(row => matches(row.orderNo, row.itemCode, row.itemName));
  const visibleShortages = data.materialReadiness.shortages.filter(row => matches(row.orderNo, row.itemCode, row.itemName));
  const visibleDocuments = data.recentDocuments.filter(row => matches(row.documentNo, row.documentType, row.warehouseCode, row.warehouseName));
  const taskIds = new Set(visibleMaterials.map(row => row.productionOrderId));
  const shortageTaskIds = new Set(visibleShortages.map(row => row.productionOrderId));
  const readyTaskCount = [...taskIds].filter(id => !shortageTaskIds.has(id)).length;
  const statusCounts = Object.entries(data.productionExecution.statusCounts || {}).map(([status, count]) => ({ status, count }));
  const riskRows = data.riskCenter.items.filter(row => matches(row.title, row.description, row.type));
  const todayTotal = operationTypes.reduce((sum, type) => sum + Number(data.todayOperations[type] || 0), 0);

  const documentColumns = [
    {
      title: '单据编号',
      dataIndex: 'documentNo',
      key: 'documentNo',
      width: 176,
      render: (value: string, row: any) => <button className="document-number-button" onClick={() => openDetail('document', row.id)}>{value}</button>,
    },
    { title: '业务类型', dataIndex: 'documentType', key: 'documentType', width: 110, render: (value: string) => statusText[value] || value },
    { title: '仓库', dataIndex: 'warehouseCode', key: 'warehouseCode', width: 76 },
    { title: '明细', dataIndex: 'lineCount', key: 'lineCount', width: 64, render: (value: number) => `${value || 0} 行` },
    { title: '生产任务', dataIndex: 'productionOrderId', key: 'productionOrderId', width: 90, render: (value: string) => value ? <Button type="link" size="small" onClick={() => navigate(`/production/tasks/${value}`)}>查看任务</Button> : '—' },
    { title: '提交人', dataIndex: 'submitterName', key: 'submitterName', width: 96, render: (value: string) => value || '未记录' },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 76,
      render: (value: string) => <Tag color={value === 'POSTED' ? 'success' : value === 'SUBMITTED' ? 'processing' : value === 'REJECTED' ? 'error' : 'default'}>{statusText[value] || value}</Tag>,
    },
    { title: '更新时间', key: 'time', width: 148, render: (_: unknown, row: any) => formatBeijingTime(row.postedAt || row.submittedAt || row.createdAt) },
    { title: '操作', key: 'action', fixed: 'right' as const, width: 74, render: (_: unknown, row: any) => <Button type="link" size="small" onClick={() => openDetail('document', row.id)}>查看</Button> },
  ];

  return (
    <main className="dashboard-page">
      <DashboardHeader filters={filters} data={data} setFilters={setFilters} refreshing={refreshing} fullscreen={fullscreen} onFullscreen={toggleFullscreen} onRefresh={() => load()} />
      {error ? <Alert type="warning" showIcon closable message="本次刷新失败，当前仍显示上次成功数据" description={error} /> : null}
      <div className={`integrated-cockpit ${refreshing ? 'is-refreshing' : ''}`}>
        <section className="cockpit-metric-layout" aria-label="核心经营指标">
          <div className="cockpit-main-metric-grid">
            <MainMetric label="原材料种类" value={kpis.rawItemCount ?? 0} unit="种" description={`有库存 ${data.inventoryCenters.raw.summary.stockedItems} · 零库存 ${data.inventoryCenters.raw.summary.zeroItems}`} icon={<DatabaseOutlined />} disabled={!data.capabilities.inventory} onClick={() => navigate('/inventory/management?tab=current&inventoryType=RAW')} />
            <MainMetric label="成品种类" value={kpis.finishedItemCount ?? 0} unit="种" description={`有库存 ${data.inventoryCenters.finished.summary.stockedItems} · 零库存 ${data.inventoryCenters.finished.summary.zeroItems}`} tone="success" icon={<InboxOutlined />} disabled={!data.capabilities.inventory} onClick={() => navigate('/inventory/management?tab=current&inventoryType=FG')} />
            <MainMetric label="生产任务总数" value={kpis.productionTaskCount ?? 0} unit="项" description={`正常完工总体进度 ${data.productionExecution.overallProgress ?? 0}%`} tone="production" icon={<ToolOutlined />} disabled={!data.capabilities.production} onClick={() => navigate('/production/tasks')} />
            <MainMetric label="风险与待办" value={riskTotal} unit="项" description="库存、生产、质量与审批统一排序" tone={riskTotal ? 'danger' : 'success'} icon={<ThunderboltOutlined />} onClick={() => document.getElementById('risk-center')?.scrollIntoView({ behavior: 'smooth' })} />
          </div>
          <div className="cockpit-aux-metric-grid">
            <AuxiliaryMetric label="低库存原材料" value={kpis.lowRawItemCount ?? 0} helper={`${data.inventoryCenters.raw.summary.zeroItems} 个零库存`} tone="warning" icon={<AlertOutlined />} disabled={!data.capabilities.inventory} onClick={() => setFilters({ inventoryType: 'RAW', inventoryStatus: 'LOW', rawPage: 1 })} />
            <AuxiliaryMetric label="低库存成品" value={kpis.lowFinishedItemCount ?? 0} helper={`${data.inventoryCenters.finished.summary.zeroItems} 个零库存`} tone="warning" icon={<AlertOutlined />} disabled={!data.capabilities.inventory} onClick={() => setFilters({ inventoryType: 'FG', inventoryStatus: 'LOW', finishedPage: 1 })} />
            <AuxiliaryMetric label="原材料不良率" value={kpis.materialDefectRate === null ? '分单位' : `${kpis.materialDefectRate}%`} helper={data.materialQuality?.thresholds.configured ? '按已过账入库分配统计' : '未配置风险阈值'} tone="cyan" icon={<SafetyCertificateOutlined />} disabled={!data.capabilities.inventory} onClick={() => document.getElementById('quality-center')?.scrollIntoView({ behavior: 'smooth' })} />
            <AuxiliaryMetric label="生产不良率" value={kpis.productionDefectRate === null ? '分单位' : `${kpis.productionDefectRate}%`} helper={data.productionQuality?.thresholds.configured ? '按已过账完工分配统计' : '未配置风险阈值'} tone="production" icon={<AuditOutlined />} disabled={!data.capabilities.production} onClick={() => document.getElementById('quality-center')?.scrollIntoView({ behavior: 'smooth' })} />
          </div>
        </section>

        <section className="cockpit-overview-grid">
          <InventoryCenterPanel title="原材料库存中心" center={data.inventoryCenters.raw} pageKey="rawPage" setFilters={setFilters} navigate={navigate} />
          <InventoryCenterPanel title="成品库存中心" center={data.inventoryCenters.finished} pageKey="finishedPage" setFilters={setFilters} navigate={navigate} />
        </section>

        <div id="risk-center">
          <SectionCard title="风险预警与审批待办中心" subtitle="严重风险 > 一般风险 > 待办；同级按等待时长与缺口比例排序" className={`dashboard-module dashboard-module-risk cockpit-risk-center ${riskRows.length ? 'has-risk' : ''}`} extra={<Button type="link" onClick={() => navigate('/approvals')}>查看全部</Button>}>
            <div className="risk-center-summary">
              <span className="is-danger"><strong>{data.riskCenter.summary.critical || 0}</strong><small>严重风险</small></span>
              <span className="is-warning"><strong>{data.riskCenter.summary.warning || 0}</strong><small>一般风险</small></span>
              <span><strong>{data.riskCenter.summary.todo || 0}</strong><small>待处理</small></span>
              <span><strong>{data.riskCenter.summary.overdue || 0}</strong><small>超时事项</small></span>
            </div>
            {riskRows.length ? <div className="risk-priority-list">{riskRows.slice(0, 5).map(row => (
              <button className={`risk-priority-row risk-${row.severity === 'CRITICAL' ? 'danger' : 'warning'}`} key={`${row.type}-${row.id}`} onClick={() => openDetail('risk', String(row.id))}>
                <Tag color={row.severity === 'CRITICAL' ? 'error' : row.severity === 'WARNING' ? 'warning' : 'processing'}>{riskTypeText[row.type] || row.type}</Tag>
                <span><strong>{row.title}</strong><small>{row.description}</small></span>
                <b>{row.waitingHours ? `${row.waitingHours} 小时` : row.ratio ? `缺口 ${(row.ratio * 100).toFixed(0)}%` : '待处理'}</b>
                <em>查看 <ArrowRightOutlined /></em>
              </button>
            ))}</div> : <div className="business-empty"><CheckCircleOutlined /><strong>当前没有紧急风险</strong><span>库存、生产、质量和审批待办均处于正常范围</span></div>}
          </SectionCard>
        </div>

        <section className="cockpit-execution-grid">
          <SectionCard title="生产执行情况" subtitle="任务状态、进度与阻塞原因" className="dashboard-module dashboard-module-production" extra={<Button type="link" onClick={() => navigate('/production/tasks')}>进入生产任务</Button>}>
            <div className="production-status-strip">
              {statusCounts.map(row => <button key={row.status} className={row.count ? 'is-active' : ''} onClick={() => navigate(`/production/tasks?status=${row.status.toLowerCase().replaceAll('_', '-')}`)}><strong>{row.count}</strong><span>{statusText[row.status] || row.status}</span></button>)}
            </div>
            <div className="production-task-list">
              {visibleTasks.slice(0, 4).map(row => <button className={`production-task-line ${row.shortageFlag ? 'is-blocked' : ''}`} key={row.id} onClick={() => openDetail('task', row.id)}>
                <span className="task-main"><strong>{row.orderNo}</strong><small>{row.itemName} · 计划 {formatQuantity(row.plannedQty)} {row.unit}</small></span>
                <span className="task-progress"><Progress percent={row.progress} showInfo={false} size="small" /><small>{formatQuantity(row.completedQty)} / {formatQuantity(row.plannedQty)} {row.unit}</small></span>
                <Tag color={row.shortageFlag ? 'error' : row.status === 'IN_PROGRESS' ? 'processing' : 'default'}>{row.shortageFlag ? '缺料阻塞' : statusText[row.status] || row.status}</Tag>
                <ArrowRightOutlined />
              </button>)}
              {!visibleTasks.length ? <div className="business-empty compact"><ToolOutlined /><strong>当前筛选下没有生产任务</strong><span>调整任务状态或关键词后查看</span></div> : null}
            </div>
          </SectionCard>

          <SectionCard title="物料齐套情况" subtitle="齐套率用于辅助判断，缺料明细用于执行" className="dashboard-module dashboard-module-readiness" extra={<Button type="link" onClick={() => navigate('/production/tasks?status=shortage')}>查看缺料任务</Button>}>
            <div className="readiness-summary">
              <div className={`readiness-ring ${Number(data.materialReadiness.readinessRate) < 100 ? 'is-risk' : ''}`}>
                <Progress type="circle" size={68} percent={Number(data.materialReadiness.readinessRate ?? 0)} strokeWidth={9} strokeColor={Number(data.materialReadiness.readinessRate) < 100 ? '#f59e0b' : '#16a34a'} format={percent => <strong>{percent}%</strong>} />
                <span>物料齐套率</span>
              </div>
              <div className="readiness-stat-grid">
                <span><strong>{readyTaskCount}</strong><small>可直接开工任务</small></span>
                <span><strong>{shortageTaskIds.size}</strong><small>缺料任务</small></span>
                <span><strong>{visibleMaterials.length - visibleShortages.length}</strong><small>已齐套物料</small></span>
                <span><strong>{visibleShortages.length}</strong><small>缺料物料</small></span>
              </div>
            </div>
            <div className="shortage-material-list">
              {visibleShortages.slice(0, 4).map(row => <button key={`${row.productionOrderId}-${row.itemId}`} onClick={() => openDetail('task', row.productionOrderId)}>
                <span><strong>{row.itemName}</strong><small>{row.itemCode} · {row.orderNo}</small></span>
                <span><small>需求 / 可用 / 缺口</small><b>{formatQuantity(row.requiredQty)} / {formatQuantity(row.availableQty)} / <em>{formatQuantity(row.shortageQty)}</em> {row.unit}</b></span>
                <ArrowRightOutlined />
              </button>)}
              {!visibleShortages.length ? <div className="readiness-ok"><CheckCircleOutlined /><span><strong>当前物料已齐套</strong><small>{visibleMaterials.length} 条物料需求均无缺口</small></span></div> : null}
            </div>
          </SectionCard>
        </section>

        <section className="cockpit-execution-grid" id="quality-center">
          <QualityPanel title="原材料质量分析" quality={data.materialQuality} onOpen={row => navigate(`/inventory/management?tab=documents&itemId=${row.itemId}`)} />
          <QualityPanel title="生产质量分析" quality={data.productionQuality} onOpen={row => row.productionOrderId && navigate(`/production/tasks/${row.productionOrderId}`)} />
        </section>

        <SectionCard title="今日库存作业" subtitle="已过账、待审核与驳回按业务类型真实统计" className="dashboard-module dashboard-module-operations today-operations-section" extra={<Button type="link" onClick={() => navigate('/inventory/management?tab=documents')}>查看全部单据</Button>}>
          {todayTotal === 0 ? <div className="today-empty-summary">
            <span><ClockCircleOutlined /><strong>今日暂无已生效库存作业</strong><small>待审核 {data.todayOperationDetails.reduce((sum, row) => sum + row.pendingCount, 0)} 单 · 已驳回 {data.todayOperationDetails.reduce((sum, row) => sum + row.rejectedCount, 0)} 单</small></span>
            <Space wrap><Button onClick={() => navigate('/inbound')}>原材料入库</Button><Button onClick={() => navigate('/production')}>生产领料</Button><Button onClick={() => navigate('/finished-inbound')}>成品入库</Button><Button onClick={() => navigate('/inventory/management?tab=documents')}>移库调整</Button></Space>
          </div> : <div className="today-operation-strip">
            {data.todayOperationDetails.map(row => <button key={row.documentType} onClick={() => navigate(`/inventory/management?tab=documents&documentType=${row.documentType}`)}>
              <span>{statusText[row.documentType] || row.documentType}</span>
              <strong>{row.postedDocumentCount}<small> 单</small></strong>
              <em>待审 {row.pendingCount} · 驳回 {row.rejectedCount}</em>
              <span className="operation-quantities">{row.quantities.map((quantity: any) => `${quantity.quantity} ${quantity.unit}`).join(' · ') || '数量 0'}</span>
              <ArrowRightOutlined />
            </button>)}
          </div>}
        </SectionCard>

        <section className="cockpit-bottom-grid">
          <SectionCard title={`库存变化趋势 · ${dashboardTrendRangeLabel(filters)}`} subtitle="业务类型按平滑曲线分开展示；数量模式必须选择具体单位" className="dashboard-module dashboard-module-trend" extra={<Space className="trend-toolbar" wrap>
            <DatePicker.RangePicker
              size="small"
              allowClear
              value={filters.dateFrom && filters.dateTo ? [dayjs(filters.dateFrom), dayjs(filters.dateTo)] : null}
              placeholder={['开始日期', '结束日期']}
              onChange={dates => setFilters(dates?.[0] && dates?.[1]
                ? { dateFrom: dates[0].format('YYYY-MM-DD'), dateTo: dates[1].format('YYYY-MM-DD') }
                : { dateFrom: undefined, dateTo: undefined, period: '7D' })}
            />
            <Segmented size="small" value={trendMetric} options={[{ label: '数量', value: 'QUANTITY' }, { label: 'SKU', value: 'SKU' }, { label: '单据', value: 'DOCUMENT' }]} onChange={value => setTrendMetric(value as any)} />
            {trendMetric === 'QUANTITY' ? <Select size="small" value={trendUnit} style={{ width: 90 }} options={trendUnits.map(unit => ({ label: unit, value: unit }))} onChange={setTrendUnit} placeholder="选择单位" /> : null}
          </Space>}>
            {trendRows.length ? <EChart option={trendOption} height={mobile ? 250 : 270} /> : <div className="business-empty trend-empty"><ClockCircleOutlined /><strong>当前时间范围内没有库存变化</strong><span>图表仍保留时间范围与统计口径，产生库存流水后自动展示</span><Button onClick={() => navigate('/inventory/management?tab=flows')}>查看库存流水</Button></div>}
          </SectionCard>
          <SectionCard title="最近库存单据" subtitle="紧凑查看执行状态，点击单号打开真实详情" className="dashboard-module dashboard-module-documents" extra={<Button type="link" onClick={() => navigate('/inventory/management?tab=documents')}>查看全部</Button>}>
            <Table rowKey="id" className="recent-document-table" size="small" pagination={false} columns={documentColumns} dataSource={visibleDocuments.slice(0, 6)} scroll={{ x: 910 }} locale={{ emptyText: <div className="business-empty compact"><FileDoneOutlined /><strong>当前时间范围内没有库存单据</strong><span>可调整日期范围或关键词</span></div> }} />
          </SectionCard>
        </section>
      </div>

      <Drawer title="驾驶舱摘要详情" width={mobile ? '100%' : 560} open={Boolean(detailType && detailId)} onClose={closeDetail}
        footer={<Space style={{ display: 'flex', justifyContent: 'flex-end' }}><Button onClick={closeDetail}>关闭</Button><Button type="primary" disabled={!detail} onClick={() => navigate(dashboardDetailRoute(detailType, detailId, detail))}>查看完整详情</Button></Space>}>
        {detailLoading ? <div className="cockpit-drawer-state"><Spin /></div> : detailError ? <Result status="error" title="详情加载失败" subTitle={detailError} /> : detail ? <DashboardDetail type={detailType} detail={detail} /> : <Empty description="暂无详情" />}
      </Drawer>
    </main>
  );
}

function DashboardHeader({
  filters,
  data,
  setFilters,
  refreshing,
  fullscreen,
  onFullscreen,
  onRefresh,
}: {
  filters: DashboardFilters;
  data?: IntegratedCockpit;
  setFilters: (patch: Partial<DashboardFilters>) => void;
  refreshing: boolean;
  fullscreen: boolean;
  onFullscreen: () => void;
  onRefresh: () => void;
}) {
  return (
    <header className="dashboard-heading">
      <div className="dashboard-title-block">
        <Title level={3}>库存生产一体化驾驶舱</Title>
        <Text type="secondary">统一查看原材料、成品、生产任务、质量风险及库存作业情况</Text>
      </div>
      <div className="dashboard-heading-actions">
        <div className="dashboard-filters">
          <Input allowClear prefix={<SearchOutlined />} value={filters.keyword} placeholder="搜索物料、任务或单据" onChange={event => setFilters({ keyword: event.target.value || undefined })} />
          <Select allowClear value={filters.warehouseId} placeholder="全部仓库" options={data?.filterOptions.warehouses.map(row => ({ value: row.id, label: `${row.warehouseCode} ${row.name}` })) || []} onChange={value => setFilters({ warehouseId: value })} />
          <Select value={filters.inventoryType} options={inventoryTypeOptions} onChange={value => setFilters({ inventoryType: value })} />
          <Select value={filters.inventoryStatus} options={inventoryStatusOptions} onChange={value => setFilters({ inventoryStatus: value, rawPage: 1, finishedPage: 1 })} />
          <Select value={filters.period} options={periodOptions} onChange={value => setFilters({ period: value, dateFrom: undefined, dateTo: undefined })} />
          <Select value={filters.productionStatus} options={productionStatusOptions} onChange={value => setFilters({ productionStatus: value })} />
          <Button onClick={() => setFilters({ keyword: undefined, warehouseId: undefined, inventoryType: 'ALL', inventoryStatus: 'ALL', period: '7D', productionStatus: 'ALL', categoryId: undefined, dateFrom: undefined, dateTo: undefined, rawPage: 1, finishedPage: 1 })}>重置</Button>
          <Button icon={<ReloadOutlined />} loading={refreshing} onClick={onRefresh}>刷新</Button>
          <Tooltip title={fullscreen ? '退出全屏' : '全屏驾驶舱'}><Button aria-label={fullscreen ? '退出全屏' : '全屏驾驶舱'} icon={fullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />} onClick={onFullscreen} /></Tooltip>
        </div>
        <div className="dashboard-meta">
          <span><i className="status-dot" />自动刷新 60 秒</span>
          <span>数据范围：{data?.scopeLabel || '加载中'}</span>
          <span>最近更新：{data ? formatBeijingTime(data.generatedAt) : '—'}</span>
        </div>
      </div>
    </header>
  );
}

function DashboardDetail({ type, detail }: { type: string; detail: any }) {
  const fields = type === 'warehouse'
    ? [['仓库编码', detail.warehouseCode || detail.warehouse_code], ['仓库名称', detail.displayName || detail.name], ['仓库类型', warehouseTypeText[detail.warehouseType || detail.warehouse_type] || detail.warehouseType], ['状态', statusText[detail.status] || detail.status]]
    : type === 'task'
      ? [['任务编号', detail.orderNo], ['产出物料', `${detail.finishedGoodCode || ''} ${detail.finishedGoodName || ''}`], ['状态', statusText[detail.status] || detail.status], ['计划/完工', `${formatQuantity(detail.plannedQty)} / ${formatQuantity(detail.completedQty)} ${detail.unit || ''}`]]
      : type === 'document'
        ? [['单据编号', detail.documentNo], ['单据类型', statusText[detail.documentType] || detail.documentType], ['状态', statusText[detail.status] || detail.status], ['创建时间', formatBeijingTime(detail.createdAt)]]
        : [['风险类型', riskTypeText[detail.type] || detail.type], ['风险对象', detail.title], ['当前情况', detail.description], ['风险等级', detail.severity], ['等待时长', detail.waitingHours ? `${detail.waitingHours} 小时` : '—']];
  return <Descriptions bordered column={1} size="small">{fields.map(([label, value]) => <Descriptions.Item key={label} label={label}>{value || '—'}</Descriptions.Item>)}</Descriptions>;
}
