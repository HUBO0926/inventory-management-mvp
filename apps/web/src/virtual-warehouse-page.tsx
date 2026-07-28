import { useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts';
import { Alert, Button, Card, Descriptions, Drawer, Empty, Popover, Segmented, Space, Table, Tag, Tooltip } from 'antd';
import {
  AppstoreAddOutlined, BankOutlined, BoxPlotOutlined, ExpandOutlined, ExportOutlined,
  CheckCircleFilled, ImportOutlined, InfoCircleOutlined, MenuOutlined, ReloadOutlined, RetweetOutlined,
  SafetyCertificateOutlined, ToolOutlined, WarningOutlined, FileDoneOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { api } from './api';
import { PageScaffold } from './components';
import { formatQuantity, statusText } from './domain';
import { useIsMobile } from './responsive';

type VirtualUser = { role?: string; permissions?: string[] };
type ViewMode = 'ZONE' | 'LOCATION';
type MapBox = { x: number; y: number; width: number; height: number };

const text = (value: unknown, fallback: string) => typeof value === 'string' && value.trim() ? value.trim() : fallback;
const number = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
const warehouseLabel = (row: any) => `${text(row?.warehouseCode, '未命名仓库')} ${text(row?.displayName || row?.name, '未命名仓库')}`;
const zoneLabel = (row: any) => `${text(row?.code, '未命名库区')} ${text(row?.name, '未命名库区')}`;
const locationLabel = (row: any) => `${text(row?.code, '未命名库位')} ${text(row?.name, '未命名库位')}`;
const typeLabel = (type: string) => ({ RAW: '原材料库', FG: '成品库', DEFECTIVE: '不良品库' }[type] || '未定义仓库');
const typeClass = (type: string) => ({ RAW: 'raw', FG: 'fg', DEFECTIVE: 'defective' }[type] || 'raw');
const dateText = (value: unknown) => {
  if (!value) return '-';
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('zh-CN', { hour12: false });
};

const operations = [
  { key: 'inbound', label: '原材料入库', path: '/inbound', icon: <ImportOutlined />, types: ['RAW'], permission: 'stock.create' },
  { key: 'finishedInbound', label: '成品入库', path: '/finished-inbound', icon: <ImportOutlined />, types: ['FG'], permission: 'stock.create' },
  { key: 'outbound', label: '成品出库', path: '/outbound', icon: <ExportOutlined />, types: ['FG'], permission: 'stock.create' },
  { key: 'adjustment', label: '库存调整', path: '/adjustments', icon: <ToolOutlined />, types: ['RAW', 'FG', 'DEFECTIVE'], permission: 'stock.create' },
  { key: 'issue', label: '生产领料', path: '/production/tasks?virtualAction=issue', icon: <BoxPlotOutlined />, types: ['RAW'], permission: 'production.issue' },
  { key: 'return', label: '生产退料', path: '/production/tasks?virtualAction=return', icon: <SafetyCertificateOutlined />, types: ['RAW'], permission: 'production.issue' },
  { key: 'move', label: '移库', path: '/moves', icon: <RetweetOutlined />, types: ['RAW', 'FG', 'DEFECTIVE'], permission: 'stock.create' },
];

function allowed(user: VirtualUser | undefined, permission: string) {
  return user?.role === 'ADMIN' || !!user?.permissions?.includes(permission);
}

const warehouseOrder = (row: any) => ({ RAW: 0, FG: 1, DEFECTIVE: 2 }[row?.warehouseType as string] ?? 3);
const sortWarehouses = (rows: any[]) => [...rows].sort((left, right) =>
  warehouseOrder(left) - warehouseOrder(right)
  || text(left?.warehouseCode, '').localeCompare(text(right?.warehouseCode, ''), 'zh-CN'));

function stateColor(entity: any, warehouse: any) {
  if (entity?.status !== 'ACTIVE' || warehouse?.status !== 'ACTIVE') return '#cbd5e1';
  if (warehouse?.warehouseType === 'DEFECTIVE') return '#ef4444';
  if (number(entity?.inventoryRecordCount ?? entity?.itemCount) === 0 || number(entity?.zeroStockCount) > 0 && number(entity?.itemCount) === 0) return '#94a3b8';
  if (number(entity?.lowStockCount) > 0) return '#f59e0b';
  return warehouse?.warehouseType === 'FG' ? '#1677ff' : '#16a34a';
}

function detailTitle(kind: 'warehouse' | 'zone' | 'location') {
  return kind === 'warehouse' ? '仓库详情' : kind === 'zone' ? '库区详情' : '库位详情';
}

function DetailPanel({ entity, kind, warehouse, locations, balances, onAction, onTransactions, onInventory, onSelectZone, onBackWarehouse, onBackZone, user }: any) {
  const currentLocations = kind === 'location'
    ? locations.filter((row: any) => row.id === entity?.id)
    : kind === 'zone' ? locations.filter((row: any) => row.zoneId === entity?.id) : locations;
  const name = kind === 'warehouse' ? warehouseLabel(entity) : kind === 'zone' ? zoneLabel(entity) : locationLabel(entity);
  const details = kind === 'warehouse' ? [
    { key: 'code', label: '仓库编码', children: text(warehouse?.warehouseCode, '未命名仓库') },
    { key: 'name', label: '仓库名称', children: text(warehouse?.name, '未命名仓库') },
    { key: 'displayName', label: '显示名称', children: text(warehouse?.displayName || warehouse?.name, '未命名仓库') },
    { key: 'type', label: '仓库类型', children: typeLabel(warehouse?.warehouseType) },
    { key: 'status', label: '状态', children: <Tag color={warehouse?.status === 'ACTIVE' ? 'success' : 'default'}>{warehouse?.status === 'ACTIVE' ? '启用' : '停用'}</Tag> },
    { key: 'updatedAt', label: '最近更新', children: dateText(warehouse?.updatedAt || warehouse?.lastInventoryAt) },
  ] : [
    { key: 'parent', label: '所属仓库', children: warehouseLabel(warehouse) },
    { key: 'name', label: kind === 'zone' ? '库区名称' : '库位名称', children: name },
    { key: 'position', label: '实际位置', children: text(entity?.actualLocation || entity?.positionDesc, '-') },
    { key: 'status', label: '状态', children: <Tag color={entity?.status === 'ACTIVE' ? 'success' : 'default'}>{entity?.status === 'ACTIVE' ? '启用' : '停用'}</Tag> },
  ];
  const count = (key: string) => kind === 'warehouse'
    ? number(entity?.summary?.[key] ?? entity?.[key] ?? warehouse?.summary?.[key] ?? warehouse?.[key])
    : kind === 'zone' ? number(entity?.[key])
      : key === 'locationCount' ? 1 : number(entity?.[key]);
  return <>
    <Descriptions className="virtual-detail-descriptions" column={1} size="small" items={details} />
    {(kind === 'zone' || kind === 'location') && <div className="virtual-detail-return"><Button type="link" onClick={kind === 'zone' ? onBackWarehouse : onBackZone}>{kind === 'zone' ? '返回仓库总览' : '返回库区详情'}</Button></div>}
    <div className="virtual-detail-stats">
      <span><small>{kind === 'warehouse' ? '库区数量' : '库位数量'}</small><strong>{kind === 'warehouse' ? count('zoneCount') : count('activeLocationCount') || count('locationCount')}</strong></span>
      {kind === 'warehouse' && <span><small>库位数量</small><strong>{count('locationCount')}</strong></span>}
      <span><small>物料种类</small><strong>{count('itemCount')}</strong></span>
      <span><small>库存记录</small><strong>{count('inventoryRecordCount')}</strong></span>
      <span><small>低/零库存</small><strong>{count('lowStockCount')}/{count('zeroStockCount')}</strong></span>
    </div>
    {kind === 'location' && <div className="virtual-location-stock">
      <div className="virtual-detail-subtitle">库存明细与批次</div>
      <Table size="small" pagination={false} rowKey={(row: any) => `${row.itemId || ''}-${row.batchId || ''}`} dataSource={balances.filter((row: any) => row.locationId === entity?.id)} locale={{ emptyText: '该库位暂无库存明细' }} columns={[
        { title: '物料', render: (_: any, row: any) => `${text(row.itemCode, '未命名物料')} ${text(row.itemName, '')}` },
        { title: '批次', dataIndex: 'batchNo', render: (value: any) => text(value, '-') },
        { title: '数量', dataIndex: 'onHandQty', align: 'right', render: formatQuantity },
      ]} />
    </div>}
    {kind !== 'location' && <div className="virtual-location-stock">
      <div className="virtual-detail-subtitle">库位清单</div>
      <Table size="small" pagination={false} rowKey="id" dataSource={kind === 'warehouse' ? (entity?.zones || warehouse?.zones || []) : currentLocations.slice(0, 6)} onRow={(row: any) => kind === 'warehouse' ? { onClick: () => onSelectZone(row.id) } : {}} locale={{ emptyText: kind === 'warehouse' ? '暂无库区' : '暂无库位' }} columns={kind === 'warehouse' ? [
        { title: '库区', render: (_: any, row: any) => zoneLabel(row) }, { title: '位置', dataIndex: 'actualLocation', render: (value: any) => text(value, '-') }, { title: '库位', dataIndex: 'activeLocationCount', align: 'right', render: (value: any) => number(value) }, { title: '物料', dataIndex: 'itemCount', align: 'right', render: (value: any) => number(value) }, { title: '状态', dataIndex: 'status', render: (value: any) => <Tag color={value === 'ACTIVE' ? 'success' : 'default'}>{value === 'ACTIVE' ? '正常' : '停用'}</Tag> },
      ] : [
        { title: '库位', render: (_: any, row: any) => locationLabel(row) },
        { title: '物料', dataIndex: 'itemCount', align: 'right', render: (value: any) => number(value) },
        { title: '库存记录', dataIndex: 'inventoryRecordCount', align: 'right', render: (value: any) => number(value) },
        { title: '状态', dataIndex: 'status', render: (value: any) => <Tag color={value === 'ACTIVE' ? 'success' : 'default'}>{value === 'ACTIVE' ? '正常' : '停用'}</Tag> },
      ]} />
    </div>}
    <div className="virtual-detail-actions">
      {warehouse?.warehouseType !== 'DEFECTIVE' && <Button type="primary" disabled={!allowed(user, 'stock.create')} onClick={() => onAction(warehouse?.warehouseType === 'FG' ? '/finished-inbound' : '/inbound')}>在此{kind === 'warehouse' ? '仓库' : kind === 'zone' ? '库区' : '库位'}入库</Button>}
      <Button disabled={!allowed(user, 'stock.create')} onClick={() => onAction('/adjustments')}>库存调整</Button>
      <Button disabled={!allowed(user, 'stock.create')} onClick={() => onAction('/moves')}>移库</Button>
      <Button onClick={onInventory}>查看库存</Button>
      <Button onClick={onTransactions}>查看流水</Button>
    </div>
  </>;
}

export function WarehouseVirtualMapPage({ user }: { user?: VirtualUser }) {
  const mobile = useIsMobile();
  const nav = useNavigate();
  const mapRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const retryRef = useRef<number | undefined>(undefined);
  const [overview, setOverview] = useState<any>({ totals: {}, warehouses: [] });
  const [selectedWarehouseId, setSelectedWarehouseId] = useState<string>();
  const [selectedZoneId, setSelectedZoneId] = useState<string>();
  const [selectedLocationId, setSelectedLocationId] = useState<string>();
  const [viewMode, setViewMode] = useState<ViewMode>('LOCATION');
  const [warehouseDetail, setWarehouseDetail] = useState<any>();
  const [locations, setLocations] = useState<any[]>([]);
  const [balances, setBalances] = useState<any[]>([]);
  const [transactions, setTransactions] = useState<any[]>([]);
  const [documents, setDocuments] = useState<any[]>([]);
  const [layoutNodes, setLayoutNodes] = useState<any[]>([]);
  const [layoutCanvas, setLayoutCanvas] = useState({ width: 1200, height: 800 });
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');
  const [detailOpen, setDetailOpen] = useState(false);
  const [operationOpen, setOperationOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [approvalStats, setApprovalStats] = useState<any>({});

  const warehouses = useMemo(() => sortWarehouses(Array.isArray(overview?.warehouses) ? overview.warehouses : []), [overview?.warehouses]);
  const warehouse = warehouses.find((row: any) => row.id === selectedWarehouseId) || warehouses[0];
  const zones = Array.isArray(warehouse?.zones) ? warehouse.zones : [];
  const selectedZone = zones.find((row: any) => row.id === selectedZoneId);
  const selectedLocation = locations.find((row: any) => row.id === selectedLocationId);
  const currentDetail = selectedLocation || selectedZone || warehouseDetail || warehouse;
  const currentDetailKind: 'warehouse' | 'zone' | 'location' = selectedLocation ? 'location' : selectedZone ? 'zone' : 'warehouse';

  const loadOverview = async (attempt = 0) => {
    setLoading(true);
    try {
      const [result, approvalResult] = await Promise.all([api('/warehouses/virtual-overview'), api('/approvals/statistics').catch(() => ({}))]);
      const next = { totals: result?.totals || {}, warehouses: sortWarehouses(Array.isArray(result?.warehouses) ? result.warehouses : []) };
      setOverview(next); setApprovalStats(approvalResult || {}); setError('');
      setSelectedWarehouseId((current) => next.warehouses.some((row: any) => row.id === current)
        ? current
        : next.warehouses.find((row: any) => row.status === 'ACTIVE' && row.warehouseType === 'RAW')?.id
          || next.warehouses.find((row: any) => row.status === 'ACTIVE')?.id
          || next.warehouses[0]?.id);
    } catch (cause: any) {
      setError(cause?.message || 'NETWORK_ERROR: 暂时无法加载仓库地图');
      if (attempt < 2) retryRef.current = window.setTimeout(() => { void loadOverview(attempt + 1); }, (attempt + 1) * 1200);
    } finally { setLoading(false); }
  };

  const loadWarehouse = async (warehouseId: string) => {
    setDetailLoading(true); setSelectedZoneId(undefined); setSelectedLocationId(undefined); setWarehouseDetail(undefined); setLocations([]); setBalances([]); setTransactions([]); setDocuments([]); setLayoutNodes([]); setDetailOpen(false);
    try {
      const [detail, locationRows, balanceRows, transactionRows, documentRows, layouts] = await Promise.all([
        api(`/warehouses/${warehouseId}`), api(`/warehouses/${warehouseId}/locations`), api(`/inventory/balances?warehouseId=${warehouseId}&pageSize=100`), api(`/inventory/transactions?warehouseId=${warehouseId}&pageSize=10`), api(`/stock-documents?warehouseId=${warehouseId}&pageSize=10`), api(`/warehouses/${warehouseId}/layouts`),
      ]);
      setWarehouseDetail(detail || {});
      setLocations(Array.isArray(locationRows) ? locationRows : []);
      setBalances(Array.isArray(balanceRows?.items) ? balanceRows.items : []);
      setTransactions(Array.isArray(transactionRows?.items) ? transactionRows.items : []);
      setDocuments(Array.isArray(documentRows?.items) ? documentRows.items : []);
      const published = Array.isArray(layouts) ? layouts.find((row: any) => row.status === 'PUBLISHED') : undefined;
      setLayoutCanvas({ width: Math.max(1, number(published?.canvasWidth) || 1200), height: Math.max(1, number(published?.canvasHeight) || 800) });
      if (published?.id) setLayoutNodes(await api(`/warehouses/${warehouseId}/layouts/${published.id}/nodes`));
      setError('');
    } catch (cause: any) { setError(cause?.message || 'NETWORK_ERROR: 仓库详情加载失败'); }
    finally { setDetailLoading(false); }
  };

  useEffect(() => { void loadOverview(); return () => { if (retryRef.current) window.clearTimeout(retryRef.current); }; }, []);
  useEffect(() => { if (selectedWarehouseId) void loadWarehouse(selectedWarehouseId); }, [selectedWarehouseId]);
  useEffect(() => {
    if (selectedZoneId && !zones.some((zone: any) => zone.id === selectedZoneId)) setSelectedZoneId(undefined);
    if (selectedLocationId && !locations.some((location: any) => location.id === selectedLocationId && !location.isArchived)) setSelectedLocationId(undefined);
  }, [zones, locations, selectedZoneId, selectedLocationId]);
  useEffect(() => {
    const handler = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  const locationStats = useMemo(() => locations.filter((location: any) => !location.isArchived).map((location: any) => {
    const locationBalances = balances.filter((balance: any) => balance.locationId === location.id);
    const derivedLow = locationBalances.filter((row: any) => number(row.onHandQty) > 0 && number(row.onHandQty) <= number(row.minimumStock)).length;
    const derivedZero = locationBalances.filter((row: any) => number(row.onHandQty) === 0).length;
    return {
      ...location,
      itemCount: Math.max(number(location.itemCount), new Set(locationBalances.map((row: any) => row.itemId)).size),
      inventoryRecordCount: Math.max(number(location.inventoryRecordCount), locationBalances.length),
      lowStockCount: Math.max(number(location.lowStockCount), derivedLow),
      zeroStockCount: Math.max(number(location.zeroStockCount), derivedZero),
      unitCount: Math.max(number(location.unitCount), new Set(locationBalances.map((row: any) => row.unit).filter(Boolean)).size),
    };
  }), [locations, balances]);

  const mapLayout = useMemo(() => {
    const count = Math.max(zones.length, 1);
    const columns = count <= 3 ? count : Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / columns);
    const zoneBoxes = new Map<string, MapBox>();
    zones.forEach((zone: any, index: number) => {
      const node = layoutNodes.find((item: any) => item.businessId === zone.id);
      const auto: MapBox = { x: (index % columns) * (100 / columns) + 1.2, y: Math.floor(index / columns) * (100 / rows) + 2, width: 100 / columns - 2.4, height: 100 / rows - 4 };
      zoneBoxes.set(zone.id, node ? {
        x: Math.min(97, Math.max(0, number(node.x) / layoutCanvas.width * 100)),
        y: Math.min(95, Math.max(0, number(node.y) / layoutCanvas.height * 100)),
        width: Math.min(96, Math.max(13, number(node.width) / layoutCanvas.width * 100)),
        height: Math.min(92, Math.max(14, number(node.height) / layoutCanvas.height * 100)),
      } : auto);
    });
    const locationBoxes = new Map<string, MapBox>();
    zones.forEach((zone: any) => {
      const parent = zoneBoxes.get(zone.id);
      if (!parent) return;
      const items = locationStats.filter((row: any) => row.zoneId === zone.id);
      const cols = Math.max(1, Math.ceil(Math.sqrt(Math.max(items.length, 1))));
      const rowsInZone = Math.ceil(Math.max(items.length, 1) / cols);
      items.forEach((location: any, index: number) => {
        const node = layoutNodes.find((item: any) => item.businessId === location.id);
        locationBoxes.set(location.id, node ? {
          x: Math.min(98, Math.max(0, number(node.x) / layoutCanvas.width * 100)),
          y: Math.min(96, Math.max(0, number(node.y) / layoutCanvas.height * 100)),
          width: Math.min(45, Math.max(6, number(node.width) / layoutCanvas.width * 100)),
          height: Math.min(28, Math.max(6, number(node.height) / layoutCanvas.height * 100)),
        } : {
          x: parent.x + 1.2 + (index % cols) * ((parent.width - 2.4) / cols),
          y: parent.y + 9 + Math.floor(index / cols) * Math.max(8, (parent.height - 10) / rowsInZone),
          width: Math.max(7, (parent.width - 3.8) / cols),
          height: Math.max(7, (parent.height - 11.5) / rowsInZone),
        });
      });
    });
    return { zoneBoxes, locationBoxes };
  }, [zones, locationStats, layoutNodes, layoutCanvas]);

  useEffect(() => {
    if (!mapRef.current || !warehouse || !zones.length) return;
    const chart = echarts.init(mapRef.current);
    const zoneData = zones.map((zone: any) => ({ entity: zone, value: mapLayout.zoneBoxes.get(zone.id) || { x: 0, y: 0, width: 20, height: 20 } }));
    const locationData = locationStats.map((location: any) => ({ entity: location, value: mapLayout.locationBoxes.get(location.id) || { x: 0, y: 0, width: 10, height: 10 } }));
    const makeRect = (params: any, chartApi: any, row: any, isLocation: boolean) => {
      const value = chartApi.value as (index: number) => number;
      const point = chartApi.coord([value(0), value(1)]);
      const width = Math.abs(chartApi.size([value(2), 0])[0]) - (isLocation ? 5 : 9);
      const height = Math.abs(chartApi.size([0, value(3)])[1]) - (isLocation ? 5 : 9);
      const title = isLocation ? text(row.code, '未命名库位') : zoneLabel(row);
      const recordText = isLocation ? `物料 ${number(row.itemCount)}` : `库位 ${number(row.activeLocationCount || row.locationCount)} · 物料 ${number(row.itemCount)}`;
      const selected = isLocation ? row.id === selectedLocationId : row.id === selectedZoneId;
      return {
        type: 'group', children: [
          { type: 'rect', shape: { x: point[0], y: point[1], width: Math.max(24, width), height: Math.max(22, height), r: isLocation ? 5 : 10 }, style: { fill: selected ? '#eaf3ff' : isLocation ? '#fff' : '#f8fbff', stroke: stateColor(row, warehouse), lineWidth: selected ? 4 : isLocation ? 1.5 : 2, shadowBlur: selected ? 8 : 0, shadowColor: selected ? stateColor(row, warehouse) : undefined, opacity: row.status === 'ACTIVE' ? 1 : .6 } },
          { type: 'text', style: { x: point[0] + (isLocation ? 5 : 10), y: point[1] + (isLocation ? 5 : 9), text: `${title}\n${recordText}`, fill: isLocation ? '#23324a' : '#172b4d', font: isLocation ? '600 11px Microsoft YaHei' : '600 13px Microsoft YaHei', lineHeight: isLocation ? 16 : 20, width: Math.max(18, width - 10), overflow: 'truncate' } },
        ],
      };
    };
    chart.setOption({
      animation: false, grid: { left: 0, top: 0, right: 0, bottom: 0 },
      tooltip: { confine: true, formatter: (params: any) => {
        const row = params.seriesName === '库位' ? locationData[params.dataIndex]?.entity : zoneData[params.dataIndex]?.entity;
        if (!row) return '暂无详情';
        return `<strong>${params.seriesName === '库位' ? locationLabel(row) : zoneLabel(row)}</strong><br/>物料种类：${number(row.itemCount)}<br/>库存记录：${number(row.inventoryRecordCount)}<br/>低库存：${number(row.lowStockCount)}`;
      } },
      xAxis: { show: false, min: 0, max: 100 }, yAxis: { show: false, min: 0, max: 100, inverse: true },
      series: [
        { name: '库区', type: 'custom', coordinateSystem: 'cartesian2d', data: zoneData.map(row => ({ value: [row.value.x, row.value.y, row.value.width, row.value.height] })), renderItem: (params: any, chartApi: any) => makeRect(params, chartApi, zoneData[params.dataIndex]?.entity, false), z: 1 },
        ...(viewMode === 'LOCATION' ? [{ name: '库位', type: 'custom', coordinateSystem: 'cartesian2d', data: locationData.map(row => ({ value: [row.value.x, row.value.y, row.value.width, row.value.height] })), renderItem: (params: any, chartApi: any) => makeRect(params, chartApi, locationData[params.dataIndex]?.entity, true), z: 2 }] : []),
      ],
    });
    chart.on('click', (params: any) => {
      if (params.seriesName === '库位') {
        const row = locationData[params.dataIndex]?.entity;
        if (!row) return;
        setSelectedLocationId(row.id); setSelectedZoneId(row.zoneId); if (mobile) setDetailOpen(true);
      } else {
        const row = zoneData[params.dataIndex]?.entity;
        if (!row) return;
        setSelectedZoneId(row.id); setSelectedLocationId(undefined); if (mobile) setDetailOpen(true);
      }
    });
    chart.getZr().on('click', (event: any) => {
      if (!event.target) { setSelectedZoneId(undefined); setSelectedLocationId(undefined); if (mobile) setDetailOpen(true); }
    });
    const observer = new ResizeObserver(() => chart.resize()); observer.observe(mapRef.current);
    return () => { observer.disconnect(); chart.dispose(); };
  }, [warehouse, zones, locationStats, mapLayout, viewMode, mobile, selectedZoneId, selectedLocationId]);

  const open = (path: string) => {
    if (!warehouse || warehouse.status !== 'ACTIVE') return;
    const params = new URLSearchParams({ warehouseId: warehouse.id });
    if (selectedZone?.id) params.set('zoneId', selectedZone.id);
    if (selectedLocation?.id) params.set('locationId', selectedLocation.id);
    nav(`${path}${path.includes('?') ? '&' : '?'}${params.toString()}`);
  };
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await workspaceRef.current?.requestFullscreen();
    } catch { setError('当前浏览器不支持地图全屏，请使用浏览器的全屏功能。'); }
  };
  const operationButtons = operations.map((operation) => {
    const enabled = warehouse?.status === 'ACTIVE' && operation.types.includes(warehouse?.warehouseType) && allowed(user, operation.permission);
    const reason = warehouse?.status !== 'ACTIVE' ? '仓库已停用' : !operation.types.includes(warehouse?.warehouseType) ? `${typeLabel(warehouse?.warehouseType)}不支持此操作` : !allowed(user, operation.permission) ? '当前账号没有操作权限' : '';
    return <Tooltip key={operation.key} title={enabled ? operation.label : reason}><Button className="virtual-operation" disabled={!enabled} icon={operation.icon} onClick={() => open(operation.path)}>{operation.label}</Button></Tooltip>;
  });
  const metrics = [
    ['\u5f85\u6211\u5ba1\u6838', approvalStats?.pendingMine, FileDoneOutlined, 'purple'],
    ['启用仓库数', overview?.totals?.activeWarehouseCount, BankOutlined, 'blue'], ['启用库区数', overview?.totals?.activeZoneCount, AppstoreAddOutlined, 'cyan'],
    ['启用库位数', overview?.totals?.activeLocationCount, BoxPlotOutlined, 'purple'], ['库存物料种类', overview?.totals?.itemCount, AppstoreAddOutlined, 'orange'],
    ['低库存预警', overview?.totals?.lowStockCount, WarningOutlined, 'warning'], ['不良品库存记录', overview?.totals?.defectiveInventoryRecordCount, SafetyCertificateOutlined, 'danger'],
  ] as const;

  return <PageScaffold bare title="虚拟仓库" subtitle="直观查看全部仓库、库区与库位状态，并可直接发起库存作业。" extra={<Space wrap>
    <Button icon={<ReloadOutlined />} loading={loading || detailLoading} onClick={() => { void loadOverview(); if (selectedWarehouseId) void loadWarehouse(selectedWarehouseId); }}>刷新数据</Button>
    <Popover title="地图图例" content={<div className="virtual-legend"><span className="raw">正常原材料</span><span className="fg">正常成品</span><span className="low">低库存</span><span className="zero">零库存</span><span className="defective">不良品库</span><span className="inactive">停用</span></div>}><Button icon={<InfoCircleOutlined />}>图例说明</Button></Popover>
    <Button icon={<ExpandOutlined />} onClick={() => void toggleFullscreen()}>{fullscreen ? '退出全屏' : '全屏查看'}</Button>
  </Space>}>
    {error && <Alert closable type="warning" showIcon message={error.replace(/^NETWORK_ERROR:\s*/, '')} action={<Button size="small" onClick={() => { void loadOverview(); if (selectedWarehouseId) void loadWarehouse(selectedWarehouseId); }}>重新加载</Button>} className="virtual-error" />}
    <div className="virtual-dashboard" ref={workspaceRef}>
      <div className="virtual-metrics-scroll"><section className="virtual-metrics">{metrics.map(([label, value, Icon, tone]) => <Card key={label} className={`virtual-metric virtual-metric-${tone}`}><span className="virtual-metric-icon"><Icon /></span><div><small>{label}</small><strong>{number(value)}</strong><em>{label === '低库存预警' ? '待处理预警' : '全局实时统计'}</em></div></Card>)}</section></div>
      <Card className="virtual-overview-card" title="全部仓库" extra={<span className="virtual-overview-hint">点击卡片切换当前仓库</span>}>
        {warehouses.length ? <div className="virtual-warehouse-cards">{warehouses.map((row: any) => {
          const isSelected = row.id === warehouse?.id;
          return <button key={row.id} type="button" aria-pressed={isSelected} onClick={() => { setSelectedZoneId(undefined); setSelectedLocationId(undefined); setSelectedWarehouseId(row.id); if (mobile) setDetailOpen(true); }} className={`virtual-warehouse-card ${typeClass(row.warehouseType)} ${isSelected ? 'is-selected' : ''} ${row.status !== 'ACTIVE' ? 'is-inactive' : ''}`}>
          <div className="virtual-warehouse-card-title"><span><b>{text(row.warehouseCode, '未命名仓库')}</b> {text(row.displayName || row.name, '未命名仓库')}</span><div className="virtual-warehouse-card-badges">{isSelected && <span className="virtual-current-badge"><CheckCircleFilled /> 当前查看</span>}<Tag color={row.warehouseType === 'DEFECTIVE' ? 'error' : row.warehouseType === 'FG' ? 'success' : 'processing'}>{typeLabel(row.warehouseType)}</Tag></div></div>
          <div className="virtual-warehouse-card-grid"><span><small>库区数</small><b>{number(row.activeZoneCount ?? row.zoneCount)}</b></span><span><small>库位数</small><b>{number(row.activeLocationCount ?? row.locationCount)}</b></span><span><small>物料种类</small><b>{number(row.itemCount)}</b></span><span><small>库存记录</small><b>{number(row.inventoryRecordCount)}</b></span><span><small>低库存</small><b>{number(row.lowStockCount)}</b></span></div>
          <div className="virtual-warehouse-card-footer"><span>{row.status === 'ACTIVE' ? '启用中' : '已停用'}</span><span>最近更新 {dateText(row.lastInventoryAt)}</span></div>
        </button>;
        })}</div> : <Empty description="暂无仓库，请先在仓储档案中创建仓库与库区" />}
      </Card>
      {warehouse && <>
        <div className="virtual-operation-bar">{mobile ? <Button block icon={<MenuOutlined />} onClick={() => setOperationOpen(true)}>打开库存作业</Button> : operationButtons}</div>
        <div className="virtual-map-detail">
          <Card className="virtual-map-panel" title="当前仓库 · 库区地图" extra={<Segmented value={viewMode} options={[{ label: '库区视图', value: 'ZONE' }, { label: '库位视图', value: 'LOCATION' }]} onChange={(value) => { setViewMode(value as ViewMode); setSelectedLocationId(undefined); }} />} loading={detailLoading}>
            <div className="virtual-map-context"><strong>当前查看：{warehouseLabel(warehouse)}</strong><span>{typeLabel(warehouse.warehouseType)} · {viewMode === 'ZONE' ? '点击库区查看详情' : '点击库位查看库存明细与批次'}</span></div>
            {zones.length ? <div ref={mapRef} className="virtual-map-canvas" /> : <Empty className="virtual-map-empty" description="当前仓库暂无库区；请在仓储档案中维护库区" />}
            <div className="virtual-map-legend"><span><i className="raw" />正常原材料</span><span><i className="fg" />正常成品</span><span><i className="low" />低库存</span><span><i className="zero" />零库存</span><span><i className="defective" />不良品</span></div>
          </Card>
          {!mobile && <Card className="virtual-detail-panel" title={detailTitle(currentDetailKind)}>{currentDetail && <DetailPanel entity={currentDetail} kind={currentDetailKind} warehouse={warehouse} locations={locationStats} balances={balances} user={user} onAction={open} onTransactions={() => nav(`/inventory/management?tab=flows&warehouseId=${warehouse.id}`)} onInventory={() => nav(`/inventory/management?tab=reports&reportType=current&warehouseId=${warehouse.id}`)} onSelectZone={(zoneId: string) => { setSelectedZoneId(zoneId); setSelectedLocationId(undefined); }} onBackWarehouse={() => { setSelectedZoneId(undefined); setSelectedLocationId(undefined); }} onBackZone={() => setSelectedLocationId(undefined)} />}</Card>}
        </div>
      </>}
      <div className="virtual-recent-grid">
        <Card title="最近库存流水" extra={<Button type="link" onClick={() => nav(`/inventory/management?tab=flows${warehouse ? `&warehouseId=${warehouse.id}` : ''}`)}>查看全部</Button>}><Table size="small" rowKey="id" pagination={false} dataSource={transactions} locale={{ emptyText: '暂无库存流水' }} columns={[
          { title: '时间', dataIndex: 'createdAt', render: dateText }, { title: '物料名称', render: (_: any, row: any) => `${text(row.itemCode, '未命名物料')} ${text(row.itemName, '')}` },
          { title: '仓库 · 库位', render: (_: any, row: any) => `${text(row.warehouseCode, '未命名仓库')} · ${text(row.locationCode, '未命名库位')}` }, { title: '数量', dataIndex: 'deltaQty', align: 'right', render: formatQuantity },
        ]} /></Card>
        <Card title="最近库存单据" extra={<Button type="link" onClick={() => nav(`/inventory/management?tab=documents${warehouse ? `&warehouseId=${warehouse.id}` : ''}`)}>查看全部</Button>}><Table size="small" rowKey="id" pagination={false} dataSource={documents} locale={{ emptyText: '暂无库存单据' }} columns={[
          { title: '单据编号', dataIndex: 'documentNo', render: (value: any) => text(value, '-') }, { title: '单据类型', dataIndex: 'documentType', render: (value: any) => statusText[value] || text(value, '-') },
          { title: '仓库', render: (_: any, row: any) => text(row.warehouseName || row.warehouseCode, '未命名仓库') }, { title: '状态', dataIndex: 'status', render: (value: any) => <Tag color={value === 'POSTED' ? 'success' : value === 'VOIDED' ? 'default' : 'processing'}>{statusText[value] || text(value, '-')}</Tag> },
        ]} /></Card>
      </div>
    </div>
    <Drawer open={mobile && detailOpen} title={detailTitle(currentDetailKind)} width="100%" onClose={() => setDetailOpen(false)}>{currentDetail && warehouse && <DetailPanel entity={currentDetail} kind={currentDetailKind} warehouse={warehouse} locations={locationStats} balances={balances} user={user} onAction={open} onTransactions={() => nav(`/inventory/management?tab=flows&warehouseId=${warehouse.id}`)} onInventory={() => nav(`/inventory/management?tab=reports&reportType=current&warehouseId=${warehouse.id}`)} onSelectZone={(zoneId: string) => { setSelectedZoneId(zoneId); setSelectedLocationId(undefined); }} onBackWarehouse={() => { setSelectedZoneId(undefined); setSelectedLocationId(undefined); }} onBackZone={() => setSelectedLocationId(undefined)} />}</Drawer>
    <Drawer open={mobile && operationOpen} title="库存作业" placement="bottom" height="auto" onClose={() => setOperationOpen(false)}><div className="virtual-mobile-operations">{operationButtons}</div></Drawer>
  </PageScaffold>;
}
