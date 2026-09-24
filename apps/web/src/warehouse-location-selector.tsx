import { Alert, Button, Drawer, Input, Select, Space, Spin, Tree, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { formatQuantity } from './domain';
import { LocationName, locationDisplayName } from './location-name';

export type LocationSelectorMode = 'inbound' | 'outbound' | 'transfer-source' | 'transfer-target';
export type LocationSelectorContext = { warehouseId?: string; zoneId?: string; locationId?: string };

type Props = {
  open: boolean;
  mode: LocationSelectorMode;
  itemId?: string;
  /** Used for expansion and highlighting only; it does not have to narrow the server query. */
  context?: LocationSelectorContext;
  /** Explicit server-side range, for example after a single-warehouse document is locked. */
  queryScope?: LocationSelectorContext;
  selectedLocationId?: string;
  /** Finished inbound has its own item-aware capacity endpoint; all other target modes use the shared tree. */
  inboundEndpoint?: 'finished-inbound' | 'shared';
  onClose: () => void;
  onConfirm: (location: any, batch?: any) => void;
};

const filterOptions = [{ value: 'ALL', label: '全部状态' }, { value: 'NORMAL', label: '仅正常' }, { value: 'AVAILABLE_CAPACITY', label: '仅有剩余容量' }, { value: 'EMPTY', label: '仅空库位' }];
const locationContext = (row: any) => [row.warehouseName, row.zoneName || row.zoneCode].filter(Boolean).join(' · ');

/** Builds read-only selector parameters without allowing a transfer target to inherit source scope. */
export function buildLocationSelectorParams(mode: LocationSelectorMode, itemId: string, context: LocationSelectorContext = {}, filter = 'ALL', keyword = '', queryScope?: LocationSelectorContext) {
  const isTransferTarget = mode === 'transfer-target';
  const scope = Object.fromEntries(Object.entries(queryScope ?? (isTransferTarget ? {} : context)).filter(([, value]) => Boolean(value)));
  const params = new URLSearchParams({ itemId, ...scope as Record<string, string> });
  if (mode !== 'outbound' && mode !== 'transfer-source') params.set('filter', filter);
  if (isTransferTarget && context.locationId) params.set('excludeLocationId', context.locationId);
  if (keyword.trim()) params.set('keyword', keyword.trim());
  return params;
}

/**
 * One selector for every stock operation. The API remains the permission boundary:
 * this component only renders locations the server has already authorized.
 */
export function WarehouseLocationSelector({ open, mode, itemId, context = {}, queryScope, selectedLocationId, inboundEndpoint = 'shared', onClose, onConfirm }: Props) {
  const [data, setData] = useState<any>();
  const [keyword, setKeyword] = useState('');
  const [filter, setFilter] = useState('ALL');
  const [pending, setPending] = useState<any>();
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  const sourceMode = mode === 'outbound' || mode === 'transfer-source';

  useEffect(() => {
    if (!open || !itemId) return;
    const controller = new AbortController();
    setData(undefined); setPending(undefined);
    const params = buildLocationSelectorParams(mode, itemId, context, filter, keyword, queryScope);
    let url: string;
    if (sourceMode) url = `/stock-documents/source-distribution?${params}`;
    else if (mode === 'inbound' && inboundEndpoint === 'finished-inbound') {
      url = `/stock-documents/finished-inbound/location-tree?${params}`;
    } else {
      url = `/stock-documents/target-location-tree?${params}`;
    }
    api(url, { signal: controller.signal }).then(setData).catch((error: any) => {
      if (error?.name !== 'AbortError') setData({ error: error.message || '库位查询失败，请重试。' });
    });
    return () => controller.abort();
  }, [open, mode, itemId, context.warehouseId, context.zoneId, context.locationId, queryScope?.warehouseId, queryScope?.zoneId, queryScope?.locationId, inboundEndpoint, filter, keyword]);

  useEffect(() => {
    if (!open) return;
    setExpandedKeys([...(context.warehouseId ? [`w-${context.warehouseId}`, `target-w-${context.warehouseId}`] : []), ...(context.zoneId ? [`z-${context.zoneId}`, `target-z-${context.zoneId}`] : [])]);
  }, [open, context.warehouseId, context.zoneId]);

  const treeData = useMemo(() => {
    if (sourceMode) {
      return (data?.locations || []).map((location: any) => ({
        key: `w-${location.warehouseId}`, selectable: false, title: <strong>{location.warehouseName}</strong>,
        children: [{ key: `z-${location.zoneId}`, selectable: false, title: `${location.zoneName || location.zoneCode}`, children: (location.batches || []).filter((batch: any) => Number(batch.availableQty) > 0).map((batch: any) => ({
          key: `${location.locationId}:${batch.batchId || ''}`, isLeaf: true, location, batch, disabled: !location.canSource,
          title: <span><strong><LocationName location={location} /></strong> · 批次 {batch.batchNo || '无'} · 可用 {formatQuantity(batch.availableQty)}{!location.canSource ? ` · ${location.disabledReason || '库位不可操作'}` : ''}</span>,
        })) }],
      }));
    }
    return (data?.warehouses || data?.nodes || []).map((warehouse: any) => ({
      key: `w-${warehouse.id}`,
      selectable: false,
      title: <span><strong>{warehouse.name}</strong> <small>{warehouse.code}</small></span>,
      children: (warehouse.zones || []).map((zone: any) => ({
        key: `z-${zone.id}`,
        selectable: false,
        title: <span>{zone.name} <small>{zone.code}</small></span>,
        children: (zone.locations || []).map((location: any) => {
          const allowed = Boolean(location.canInbound);
          return {
            key: location.locationId,
            isLeaf: true,
            location,
            disabled: !allowed,
            title: <span><strong><LocationName location={location} /></strong> · {location.remainingCapacityQty === null ? '不限容量' : `剩余 ${formatQuantity(location.remainingCapacityQty)}`} · {allowed ? location.state : location.disabledReason || location.state}</span>,
          };
        }),
      })),
    }));
  }, [data, sourceMode]);

  const title = mode === 'inbound' ? '选择入库位置' : mode === 'outbound' ? '选择出库位置' : mode === 'transfer-source' ? '选择移出位置' : '选择移库目标位置（同类型仓库）';
  const pendingName = pending ? locationDisplayName(pending.location) : '尚未选择库位';
  return <Drawer width={720} title={title} open={open} onClose={onClose} extra={!sourceMode && <Space><Input allowClear value={keyword} onChange={event => setKeyword(event.target.value)} placeholder="搜索仓库 / 库区 / 库位 / 物料" /><Select value={filter} style={{ width: 140 }} onChange={setFilter} options={filterOptions} /></Space>} footer={<div className="finished-inbound-picker-footer"><span>{pending ? <Space direction="vertical" size={0}><LocationName location={pending.location} /><Typography.Text type="secondary">{locationContext(pending.location)}</Typography.Text></Space> : pendingName}</span><Space><Button onClick={onClose}>取消</Button><Button type="primary" disabled={!pending} onClick={() => pending && onConfirm(pending.location, pending.batch)}>确认选择</Button></Space></div>}>
    {!itemId ? <Alert type="info" showIcon message="请先选择物料" /> : !data ? <Spin /> : data.error ? <Alert type="error" showIcon message="库存位置查询失败，请重试。" description={data.error} /> : <Tree showLine treeData={treeData} expandedKeys={expandedKeys} onExpand={keys => setExpandedKeys(keys.map(String))} selectedKeys={pending ? [pending.location.locationId] : selectedLocationId ? [selectedLocationId] : []} onSelect={(_keys, info: any) => { if (!info.node?.isLeaf || info.node.disabled) return; setPending({ location: info.node.location, batch: info.node.batch }); }} />}
  </Drawer>;
}
