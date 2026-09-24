import { useEffect, useMemo, useRef, useState } from 'react';
import { EnvironmentOutlined, ReloadOutlined } from '@ant-design/icons';
import { Alert, AutoComplete, Button, Card, Empty, Form, Input, InputNumber, Select, Space, Spin, Table, Tag, Typography } from 'antd';
import { api } from './api';
import { formatQuantity } from './domain';
import { LocationName, locationDisplayName } from './location-name';
import { WarehouseLocationSelector } from './warehouse-location-selector';

const displayOf = (row: any) => locationDisplayName(row);

type Props = { form: any; items: any[]; suggestedLocationId?: string; onWarehouseSelected?: (warehouseId: string) => void };

export function FinishedInboundEditor({ form, items, suggestedLocationId, onWarehouseSelected }: Props) {
  const lines = Form.useWatch('lines', form) || [];
  const warehouseId = Form.useWatch('warehouseId', form);
  const [distributions, setDistributions] = useState<Record<string, any>>({});
  const [batches, setBatches] = useState<any[]>([]);
  const [locations, setLocations] = useState<Record<string, any>>({});
  const [picker, setPicker] = useState<{ index: number; itemId: string }>();
  const suggestedApplied = useRef(false);
  const distributionCache = useRef(new Map<string, any>());
  const [slowItems, setSlowItems] = useState<Record<string, boolean>>({});
  const selectedItemKey = useMemo(() => lines.map((line: any) => line?.itemId || '').join('|'), [lines]);

  useEffect(() => { suggestedApplied.current = false; }, [suggestedLocationId, lines[0]?.itemId]);

  useEffect(() => {
    const itemIds = [...new Set(selectedItemKey.split('|').filter(Boolean))] as string[];
    let alive = true;
    const controllers: AbortController[] = [];
    for (const itemId of itemIds) {
      const cached = distributionCache.current.get(itemId);
      if (cached) { setDistributions(current => current[itemId] ? current : { ...current, [itemId]: { data: cached } }); continue; }
      const controller = new AbortController(); controllers.push(controller);
      const slowTimer = window.setTimeout(() => { if (alive) setSlowItems(current => ({ ...current, [itemId]: true })); }, 1000);
      setDistributions(current => ({ ...current, [itemId]: { loading: true } }));
      const params = new URLSearchParams({ itemId });
      if (itemId === lines[0]?.itemId && suggestedLocationId) params.set('suggestedLocationId', suggestedLocationId);
      api(`/stock-documents/finished-inbound/item-distribution?${params}`, { signal: controller.signal })
        .then((data: any) => { if (!alive) return; distributionCache.current.set(itemId, data); setDistributions(current => ({ ...current, [itemId]: { data } })); setLocations(current => ({ ...current, ...Object.fromEntries([...(data.locations || []), ...(data.suggestedLocation ? [data.suggestedLocation] : [])].map((row: any) => [row.locationId, row])) })); })
        .catch((error: any) => { if (alive && error?.name !== 'AbortError') setDistributions(current => ({ ...current, [itemId]: { error: error.message || '库存分布查询失败，请重试。' } })); })
        .finally(() => window.clearTimeout(slowTimer));
    }
    return () => { alive = false; controllers.forEach(controller => controller.abort()); };
  }, [selectedItemKey, suggestedLocationId]);
  useEffect(() => {
    const itemIds = [...new Set(selectedItemKey.split('|').filter(Boolean))] as string[];
    let alive = true;
    for (const itemId of itemIds) if (!batches.some(batch => batch.itemId === itemId)) api(`/batches?itemId=${encodeURIComponent(itemId)}&pageSize=100`).then((result: any) => { if (alive) setBatches(current => [...current.filter(batch => batch.itemId !== itemId), ...(result.items || [])]); }).catch(() => undefined);
    return () => { alive = false; };
  }, [selectedItemKey]);
  useEffect(() => {
    const suggested = distributions[lines[0]?.itemId]?.data?.suggestedLocation;
    if (!suggested || suggestedApplied.current || warehouseId) return;
    suggestedApplied.current = true; choose(0, suggested);
  }, [distributions, warehouseId, lines]);
  const syncWarehouse = (nextLines: any[]) => {
    const selectedWarehouses = [...new Set(nextLines.filter(line => line?.locationId && line?.warehouseId).map(line => line.warehouseId))];
    const nextWarehouseId = selectedWarehouses[0];
    form.setFieldValue('warehouseId', nextWarehouseId);
    if (nextWarehouseId) onWarehouseSelected?.(nextWarehouseId);
  };
  const clearLineLocation = (index: number, itemId: string) => {
    const nextLines = [...(form.getFieldValue('lines') || [])];
    nextLines[index] = { itemId, quantity: 1, batchId: undefined, batchNo: undefined, warehouseId: undefined, zoneId: undefined, locationId: undefined, locationPath: undefined };
    form.setFieldValue('lines', nextLines);
    syncWarehouse(nextLines);
  };
  const removeLine = (index: number, remove: (index: number) => void) => {
    const nextLines = [...(form.getFieldValue('lines') || [])];
    nextLines.splice(index, 1);
    remove(index);
    syncWarehouse(nextLines);
  };
  const choose = (index: number, row: any) => {
    const nextLines = [...(form.getFieldValue('lines') || [])];
    const selectedElsewhere = nextLines.find((line, lineIndex) => lineIndex !== index && line?.locationId && line?.warehouseId)?.warehouseId;
    if (selectedElsewhere && selectedElsewhere !== row.warehouseId) return;
    const current = nextLines[index] || {};
    nextLines[index] = { ...current, warehouseId: row.warehouseId, zoneId: row.zoneId, locationId: row.locationId, locationPath: displayOf(row) };
    form.setFieldValue('lines', nextLines);
    syncWarehouse(nextLines);
    setLocations(current => ({ ...current, [row.locationId]: row }));
    setPicker(undefined);
  };
  const otherWarehouseId = (index?: number) => lines.find((line: any, lineIndex: number) => lineIndex !== index && line?.locationId && line?.warehouseId)?.warehouseId;

  return <>
    <Form.Item name="warehouseId" hidden><Input /></Form.Item>
    <Form.Item label="归属仓库"><Typography.Text>{warehouseId ? '已由首条入库位置确定；同一单据只能选择该仓库库位' : '请先选择物料和具体入库库位'}</Typography.Text></Form.Item>
    <Form.List name="lines">{(fields, { add, remove }) => <>{fields.map(field => {
      const line = lines[field.name] || {}; const item = items.find((row: any) => row.id === line.itemId || row.itemId === line.itemId); const result = line.itemId ? distributions[line.itemId] : undefined; const selected = locations[line.locationId]; const lockedWarehouseId = otherWarehouseId(field.name);
      const quantity = Number(line.quantity || 0); const capacityBlocked = selected?.remainingCapacityQty !== null && selected?.remainingCapacityQty !== undefined && quantity > Number(selected.remainingCapacityQty);
      const follow = (row: any) => choose(field.name, row);
      return <Card className="finished-inbound-line" size="small" key={field.key} title={`入库明细 ${field.name + 1}`} extra={field.name > 0 ? <Button danger type="link" onClick={() => removeLine(field.name, remove)}>删除</Button> : null}>
        <Form.Item {...field} label="物料" name={[field.name, 'itemId']} rules={[{ required: true, message: '请选择成品物料' }]}><Select showSearch optionFilterProp="label" placeholder="先选择成品物料" options={items.map((row: any) => ({ value: row.id || row.itemId, label: `${row.itemCode} ${row.name}${row.model ? ` · ${row.model}` : ''}` }))} onChange={(itemId) => clearLineLocation(field.name, itemId)} /></Form.Item>
        {!line.itemId ? null : result?.loading ? <div className="finished-inbound-distribution"><Spin size="small"/> 正在查询该物料的库存分布……{slowItems[line.itemId] && <Typography.Text type="secondary"> 查询时间较长，请稍候。</Typography.Text>}</div> : result?.error ? <Alert type="error" showIcon message="库存分布查询失败，请重试。" description={<Space><span>{result.error}</span><Button size="small" icon={<ReloadOutlined/>} onClick={() => { distributionCache.current.delete(line.itemId); setSlowItems(current => ({ ...current, [line.itemId]: false })); setDistributions(current => { const next = { ...current }; delete next[line.itemId]; return next; }); }}>重新查询</Button></Space>}/> : result?.data?.hasInventory ? <div className="finished-inbound-distribution"><Typography.Text strong>该物料现有库存分布</Typography.Text><Table size="small" rowKey="locationId" pagination={false} rowClassName={(row: any) => row.locationId === line.locationId ? 'finished-inbound-selected-row' : ''} dataSource={result.data.locations} columns={[{ title: '库位', render: (_: any, row: any) => <Space direction="vertical" size={0}><LocationName location={row}/><Typography.Text type="secondary">{[row.warehouseName, row.zoneName].filter(Boolean).join(' · ')}</Typography.Text></Space> }, { title: '当前库存', dataIndex: 'onHandQty', align: 'right', render: formatQuantity }, { title: '冻结 / 占用', align: 'right', render: (_: any, row: any) => `${formatQuantity(row.frozenQty)} / ${formatQuantity(row.reservedQty)}` }, { title: '可用库存', dataIndex: 'availableQty', align: 'right', render: formatQuantity }, { title: '剩余容量', align: 'right', render: (_: any, row: any) => row.remainingCapacityQty === null ? '不限容量' : formatQuantity(row.remainingCapacityQty) }, { title: '操作', render: (_: any, row: any) => <Space>{row.recommended && <Tag color="blue">推荐</Tag>}<Button type={row.locationId === line.locationId ? 'primary' : 'link'} disabled={!row.canInbound || (lockedWarehouseId && lockedWarehouseId !== row.warehouseId) || (quantity > 0 && row.remainingCapacityQty !== null && quantity > Number(row.remainingCapacityQty))} title={!row.canInbound ? row.disabledReason : lockedWarehouseId && lockedWarehouseId !== row.warehouseId ? '本单据已绑定其他仓库' : undefined} onClick={() => follow(row)}>{row.locationId === line.locationId ? '✓ 已选择' : '跟随入库'}</Button></Space> }]} /></div> : <div className="finished-inbound-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<span>暂无库存记录<br/>该物料尚未存放于任何可查看库位，请选择本次入库位置。</span>}><Button type="primary" onClick={() => setPicker({ index: field.name, itemId: line.itemId })}>选择入库位置</Button></Empty></div>}
        <Form.Item name={[field.name, 'warehouseId']} hidden><Input /></Form.Item><Form.Item name={[field.name, 'zoneId']} hidden><Input /></Form.Item>
        <Form.Item label="入库位置" name={[field.name, 'locationId']} rules={[{ required: true, message: '请先选择入库位置' }]} validateStatus={capacityBlocked ? 'error' : undefined} help={capacityBlocked ? `数量超过该库位剩余容量 ${formatQuantity(selected?.remainingCapacityQty)}` : undefined}><div>{selected ? <LocationName location={selected}/> : <Typography.Text>{line.locationPath || '尚未选择入库位置'}</Typography.Text>}<Button style={{ marginLeft: 8 }} icon={<EnvironmentOutlined/>} disabled={!line.itemId} onClick={() => setPicker({ index: field.name, itemId: line.itemId })}>{line.locationId ? '重新选择入库位置' : '选择入库位置'}</Button></div></Form.Item>
        <Space align="start" wrap><Form.Item {...field} label={item?.enableBatch ? '批次' : '批次（可选）'} name={[field.name, 'batchNo']} rules={item?.enableBatch ? [{ required: true, message: '请输入或选择批次号' }] : []}><AutoComplete style={{ width: 220 }} placeholder={item?.enableBatch ? '输入或选择批次号' : '可选'} options={batches.filter((batch: any) => batch.itemId === line.itemId).map((batch: any) => ({ value: batch.batchNo }))}><Input /></AutoComplete></Form.Item><Form.Item {...field} label="入库数量" name={[field.name, 'quantity']} rules={[{ required: true, message: '请输入入库数量' }, { validator: (_: any, value: any) => selected?.remainingCapacityQty !== null && selected?.remainingCapacityQty !== undefined && Number(value || 0) > Number(selected.remainingCapacityQty) ? Promise.reject(new Error(`数量不能超过剩余容量 ${formatQuantity(selected.remainingCapacityQty)}`)) : Promise.resolve() }]}><InputNumber min={1} precision={0} style={{ width: 160 }} /></Form.Item><Form.Item label="单位"><Input disabled value={item?.unit || '—'} style={{ width: 100 }} /></Form.Item></Space>
      </Card>;
    })}<Button block type="dashed" onClick={() => add({ quantity: 1 })}>增加明细</Button></>}</Form.List>
    <WarehouseLocationSelector open={!!picker} mode="inbound" inboundEndpoint="finished-inbound" itemId={picker?.itemId} queryScope={{ warehouseId: warehouseId || undefined }} selectedLocationId={picker ? lines[picker.index]?.locationId : undefined} onClose={() => setPicker(undefined)} onConfirm={row => picker && choose(picker.index, row)} />
  </>;
}
