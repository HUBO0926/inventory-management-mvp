import type { User } from './App';

export type DashboardFilters = {
  warehouseId?: string;
  keyword?: string;
  inventoryType: 'ALL' | 'RAW' | 'FG' | 'DEFECTIVE';
  inventoryStatus: 'ALL' | 'NORMAL' | 'LOW' | 'ZERO' | 'LOCKED' | 'DEFECTIVE';
  period: 'TODAY' | '7D' | '30D';
  productionStatus: string;
  categoryId?: string;
  dateFrom?: string;
  dateTo?: string;
  rawPage: number;
  finishedPage: number;
};

export type UnitQuantity = { unit: string; quantity: string };

export type IntegratedCockpit = {
  generatedAt: string;
  scopeLabel: string;
  capabilities: {
    dashboard: boolean;
    inventory: boolean;
    warehouse: boolean;
    production: boolean;
    approval: boolean;
    defective: boolean;
  };
  filterOptions: {
    warehouses: Array<{ id: string; warehouseCode: string; name: string; warehouseType: string }>;
    inventoryTypes: string[];
    periods: string[];
    productionStatuses: string[];
  };
  kpis: {
    inventoryByUnit: Array<{ unit: string; actualQty: string; availableQty: string }>;
    availableByUnit: UnitQuantity[];
    inventorySkuCount: number | null;
    totalLocations: number | null;
    occupiedLocations: number | null;
    locationUsageRate: number | null;
    lowStockCount: number | null;
    zeroStockCount: number | null;
    pendingDefectiveCount: number | null;
    inProgressTaskCount: number | null;
    shortageTaskCount: number | null;
    pendingApprovalCount: number | null;
    rawItemCount: number | null;
    lowRawItemCount: number | null;
    finishedItemCount: number | null;
    lowFinishedItemCount: number | null;
    productionTaskCount: number | null;
    materialDefectRate: number | null;
    productionDefectRate: number | null;
  };
  inventoryCenters: {
    raw: InventoryCenter;
    finished: InventoryCenter;
  };
  warehouseSummaries: Array<{
    warehouseId: string;
    warehouseCode: string;
    warehouseName: string;
    warehouseType: string;
    stockByUnit: UnitQuantity[];
    skuCount: number;
    occupiedLocationCount: number;
    pendingDefectiveCount: number;
  }>;
  risksAndTodos: { riskItems: any[]; pendingApprovals: any[] };
  productionExecution: { tasks: any[]; overallProgress: number | null; statusCounts: Record<string, number> };
  materialReadiness: { readinessRate: number | null; shortageTaskCount: number | null; materials: any[]; shortages: any[] };
  todayOperations: Record<string, number>;
  todayOperationDetails: any[];
  inventoryTrend: any[];
  inventoryTrendDetails: any[];
  recentDocuments: any[];
  materialQuality: QualitySummary | null;
  productionQuality: QualitySummary | null;
  riskCenter: { summary: Record<string, number>; items: any[] };
  dataGaps: string[];
};

export type InventoryCenter = {
  summary: { totalItems: number; stockedItems: number; zeroItems: number; lowItems: number; lockedItems: number; defectiveItems: number };
  rows: any[];
  pagination: { page: number; pageSize: number; total: number };
};

export type QualitySummary = {
  byUnit: Array<{ unit: string; inspectedQty: string; normalQty: string; defectiveQty: string; defectRate: number }>;
  overallRate: number | null;
  displayMode: 'SINGLE_UNIT' | 'BY_UNIT';
  level: 'NEUTRAL' | 'NORMAL' | 'WARNING' | 'CRITICAL';
  thresholds: { configured: boolean; warning: number | null; critical: number | null };
  top: any[];
  reasons: Array<{ reason: string; quantity: string }>;
};

const inventoryTypes = ['ALL', 'RAW', 'FG', 'DEFECTIVE'] as const;
const periods = ['TODAY', '7D', '30D'] as const;
const inventoryStatuses = ['ALL', 'NORMAL', 'LOW', 'ZERO', 'LOCKED', 'DEFECTIVE'] as const;
const productionStatuses = ['ALL', 'DRAFT', 'RELEASED', 'AWAITING_ISSUE', 'IN_PROGRESS', 'AWAITING_COMPLETION', 'COMPLETED', 'CLOSED', 'CANCELLED'];
const isoDate = /^\d{4}-\d{2}-\d{2}$/;

function validDateRange(from: string | null, to: string | null) {
  if (!from || !to || !isoDate.test(from) || !isoDate.test(to)) return undefined;
  const fromTime = Date.parse(`${from}T00:00:00Z`);
  const toTime = Date.parse(`${to}T00:00:00Z`);
  return Number.isFinite(fromTime) && Number.isFinite(toTime) && fromTime <= toTime ? { from, to } : undefined;
}

export function dashboardFilters(params: URLSearchParams): DashboardFilters {
  const inventoryType = params.get('inventoryType');
  const period = params.get('period');
  const productionStatus = params.get('productionStatus');
  const inventoryStatus = params.get('inventoryStatus');
  const range = validDateRange(params.get('dateFrom'), params.get('dateTo'));
  return {
    warehouseId: params.get('warehouseId') || undefined,
    keyword: params.get('q') || undefined,
    inventoryType: inventoryTypes.includes(inventoryType as any) ? inventoryType as DashboardFilters['inventoryType'] : 'ALL',
    inventoryStatus: inventoryStatuses.includes(inventoryStatus as any) ? inventoryStatus as DashboardFilters['inventoryStatus'] : 'ALL',
    period: periods.includes(period as any) ? period as DashboardFilters['period'] : '7D',
    productionStatus: productionStatuses.includes(productionStatus || '') ? String(productionStatus) : 'ALL',
    categoryId: params.get('categoryId') || undefined,
    dateFrom: range?.from,
    dateTo: range?.to,
    rawPage: Math.max(1, Number(params.get('rawPage') || 1) || 1),
    finishedPage: Math.max(1, Number(params.get('finishedPage') || 1) || 1),
  };
}

export function dashboardQuery(filters: DashboardFilters) {
  const query = new URLSearchParams();
  if (filters.warehouseId) query.set('warehouseId', filters.warehouseId);
  if (filters.keyword?.trim()) query.set('q', filters.keyword.trim());
  if (filters.inventoryType !== 'ALL') query.set('inventoryType', filters.inventoryType);
  if (filters.inventoryStatus !== 'ALL') query.set('inventoryStatus', filters.inventoryStatus);
  if (filters.period !== '7D') query.set('period', filters.period);
  if (filters.productionStatus !== 'ALL') query.set('productionStatus', filters.productionStatus);
  if (filters.categoryId) query.set('categoryId', filters.categoryId);
  if (filters.dateFrom && filters.dateTo) {
    query.set('dateFrom', filters.dateFrom);
    query.set('dateTo', filters.dateTo);
  }
  if (filters.rawPage > 1) query.set('rawPage', String(filters.rawPage));
  if (filters.finishedPage > 1) query.set('finishedPage', String(filters.finishedPage));
  return query;
}

export function dashboardApiQuery(filters: DashboardFilters) {
  const query = new URLSearchParams();
  if (filters.warehouseId) query.set('warehouseId', filters.warehouseId);
  query.set('inventoryType', filters.inventoryType);
  query.set('inventoryStatus', filters.inventoryStatus);
  query.set('period', filters.period);
  query.set('productionStatus', filters.productionStatus);
  if (filters.keyword?.trim()) query.set('keyword', filters.keyword.trim());
  if (filters.categoryId) query.set('categoryId', filters.categoryId);
  if (filters.dateFrom && filters.dateTo) {
    query.set('dateFrom', filters.dateFrom);
    query.set('dateTo', filters.dateTo);
  }
  query.set('rawPage', String(filters.rawPage));
  query.set('finishedPage', String(filters.finishedPage));
  query.set('pageSize', '5');
  return query;
}

export function dashboardTrendRangeLabel(filters: DashboardFilters) {
  if (filters.dateFrom && filters.dateTo) return `${filters.dateFrom} 至 ${filters.dateTo}`;
  if (filters.period === 'TODAY') return '今日';
  if (filters.period === '30D') return '最近 30 天';
  return '最近 7 天';
}

export function formatUnitQuantities(rows: UnitQuantity[] | Array<{ unit: string; actualQty: string }>, field: 'quantity' | 'actualQty' = 'quantity') {
  if (!rows.length) return '0';
  const order = ['台', '个', '套', '件', '箱', 'kg', '千克', '米'];
  return [...rows]
    .sort((left, right) => {
      const leftIndex = order.indexOf(left.unit);
      const rightIndex = order.indexOf(right.unit);
      return (leftIndex < 0 ? order.length : leftIndex) - (rightIndex < 0 ? order.length : rightIndex) || left.unit.localeCompare(right.unit, 'zh-CN');
    })
    .map(row => `${row.unit || '单位'} ${String((row as any)[field] ?? 0)}`)
    .join(' ｜ ');
}

export function dashboardDetailRoute(type: string, id: string, row?: any) {
  if (type === 'warehouse') return `/warehouse-virtual?warehouseId=${encodeURIComponent(id)}`;
  if (type === 'task') return `/production/tasks/${encodeURIComponent(id)}`;
  if (type === 'document') return `/inventory/management?tab=documents&documentId=${encodeURIComponent(id)}`;
  if (type === 'risk') return row?.route || `/inventory/management?tab=reports&reportType=low-stock${row?.warehouseId ? `&warehouseId=${encodeURIComponent(row.warehouseId)}` : ''}`;
  return '/';
}

export type QuickAction = { to: string; label: string; description: string; icon: 'inbound' | 'finishedInbound' | 'outbound' | 'production' | 'inventory' | 'transactions' };

export function quickActionsForRole(role: User['role']): QuickAction[] {
  if (role === 'WAREHOUSE') return [
    { to: '/inbound', label: '原材料入库', description: '创建并提交入库单', icon: 'inbound' },
    { to: '/finished-inbound', label: '成品入库', description: '登记非生产来源成品', icon: 'finishedInbound' },
    { to: '/outbound', label: '成品出库', description: '创建并提交出库单', icon: 'outbound' },
    { to: '/inventory', label: '查看库存', description: '查询当前可用库存', icon: 'inventory' },
  ];
  if (role === 'PRODUCTION') return [
    { to: '/production', label: '生产任务', description: '创建、发布与报产', icon: 'production' },
    { to: '/inventory', label: '材料库存', description: '检查原材料可用量', icon: 'inventory' },
    { to: '/transactions', label: '库存流水', description: '追溯领退料记录', icon: 'transactions' },
  ];
  return [
    { to: '/inbound', label: '原材料入库', description: '登记到货并增加库存', icon: 'inbound' },
    { to: '/finished-inbound', label: '成品入库', description: '登记非生产来源成品', icon: 'finishedInbound' },
    { to: '/production', label: '生产任务', description: '跟进领料与完工', icon: 'production' },
    { to: '/outbound', label: '成品出库', description: '安排成品发出', icon: 'outbound' },
  ];
}

export function movementDocumentTotal(rows: any[] = []) {
  return rows.reduce((sum, row) => sum
    + Number(row.inboundDocumentCount || 0)
    + Number(row.finishedInboundDocumentCount || 0)
    + Number(row.outboundDocumentCount || 0)
    + Number(row.productionDocumentCount || 0)
    + Number(row.reversalDocumentCount || 0), 0);
}
