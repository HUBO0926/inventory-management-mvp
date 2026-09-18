import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Empty, Form, Input, InputNumber, Modal, Select, Space, Table, Tag, Tooltip, message } from 'antd';
import { ApartmentOutlined, DatabaseOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from './api';
import { PageScaffold } from './components';
import { formatQuantity } from './domain';

type User = { role?: string; permissions?: string[] };
const labels: Record<string, string> = { DISABLED: '已停用', FULL: '满库', LOCKED: '库存锁定', WARNING: '容量预警', LOW: '低库存', NORMAL: '正常', EMPTY: '空库位', UNLIMITED: '不限量' };
const colors: Record<string, string> = { DISABLED: 'default', FULL: 'red', LOCKED: 'purple', WARNING: 'orange', LOW: 'gold', NORMAL: 'green', EMPTY: 'blue', UNLIMITED: 'cyan' };
const can = (user: User | undefined, permission: string) => user?.role === 'ADMIN' || Boolean(user?.permissions?.includes(permission));

export function LocationCapacityPage({ user }: { user?: User }) {
  const nav = useNavigate(); const location = useLocation(); const [tree, setTree] = useState<any>({ warehouses: [], zones: [], locations: [] }); const [selected, setSelected] = useState<any>(); const [loading, setLoading] = useState(true); const [open, setOpen] = useState(false); const [editing, setEditing] = useState<any>(); const [contextLocked, setContextLocked] = useState(false); const [items, setItems] = useState<any[]>([]); const [form] = Form.useForm(); const formWarehouseId = Form.useWatch('warehouseId', form); const formZoneId = Form.useWatch('zoneId', form);
  const manageable = can(user, 'warehouse.capacity.manage');
  const params = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const warehouses = tree.warehouses || [];
  const selectedWarehouse = warehouses.find((row: any) => row.id === formWarehouseId);
  const zones = selectedWarehouse?.zones || [];
  const selectedZone = zones.find((row: any) => row.id === formZoneId);
  const locations = selectedZone?.locations || [];
  const load = async () => {
    setLoading(true);
    try {
      const data = await api('/location-item-capacities/workspace/tree'); setTree(data);
      const warehouse = data.warehouses?.find((row: any) => row.warehouseCode === params.get('warehouse')) || data.warehouses?.[0];
      const zone = warehouse?.zones?.find((row: any) => row.code === params.get('zone')) || warehouse?.zones?.[0];
      const target = zone?.locations?.find((row: any) => row.locationCode === params.get('location')) || zone?.locations?.[0];
      setSelected(target);
    } catch (error: any) { message.error(error.message || '库位容量数据加载失败'); } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  const loadItems = async (warehouseId?: string) => { if (!warehouseId) return setItems([]); try { setItems((await api(`/location-item-capacities/item-options?warehouseId=${warehouseId}`)).items || []); } catch (error: any) { message.error(error.message || '物料候选加载失败'); } };
  const start = (row?: any, contextual = false) => {
    if (!manageable) return;
    setEditing(row); setContextLocked(contextual || Boolean(row)); const source = contextual || row ? selected : undefined;
    form.resetFields(); form.setFieldsValue({ warehouseId: source?.warehouseId, zoneId: source?.zoneId, locationId: source?.locationId, itemId: row?.itemId, capacity: row?.capacityQty ? Number(row.capacityQty) : undefined, notes: row?.notes || '' });
    void loadItems(source?.warehouseId); setOpen(true);
  };
  const save = async (values: any) => { try { await api('/location-item-capacities', { method: 'PUT', body: JSON.stringify({ locationId: values.locationId, itemId: values.itemId, capacity: String(values.capacity), notes: values.notes }) }); message.success('容量配置已保存'); setOpen(false); await load(); } catch (error: any) { message.error(error.message || '保存失败'); } };
  const chooseWarehouse = (warehouseId: string) => { const warehouse = warehouses.find((row: any) => row.id === warehouseId); form.setFieldsValue({ zoneId: warehouse?.zones?.[0]?.id, locationId: warehouse?.zones?.[0]?.locations?.[0]?.locationId, itemId: undefined }); void loadItems(warehouseId); };
  const chooseZone = (zoneId: string) => { const zone = zones.find((row: any) => row.id === zoneId); form.setFieldsValue({ locationId: zone?.locations?.[0]?.locationId, itemId: undefined }); };
  const itemRows = selected?.items || [];
  return <PageScaffold title="库位容量" subtitle="按仓库、库区、库位配置物料容量；未配置容量即不限量。" extra={<Space><Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新</Button>{manageable && <Button type="primary" icon={<PlusOutlined />} onClick={() => start()}>新增容量</Button>}</Space>}>
    <div className="capacity-workbench">
      <Card className="capacity-tree" title="仓储层级" loading={loading}>
        {!warehouses.length ? <Empty description="暂无可查看仓库" /> : warehouses.map((warehouse: any) => <section key={warehouse.id} className="capacity-tree-warehouse"><strong>{warehouse.name} <small>{warehouse.warehouseCode}</small></strong>{warehouse.zones.map((zone: any) => <div key={zone.id} className="capacity-tree-zone"><span><ApartmentOutlined /> {zone.name} <small>{zone.code} · {zone.locationCount} 库位</small></span>{zone.locations.map((row: any) => <button type="button" key={row.locationId} onClick={() => setSelected(row)} className={selected?.locationId === row.locationId ? 'is-selected' : ''}><i className={`capacity-dot ${String(row.status).toLowerCase()}`} />{row.locationCode}<small>{row.itemTypeCount ? `${row.itemTypeCount} 物料` : '未配置容量'} · {labels[row.status] || row.status}</small></button>)}</div>)}</section>)}</Card>
      <section className="capacity-detail">
        {selected ? <><Card className="capacity-overview" title={`${selected.locationCode} · ${selected.locationName}`} extra={<Button icon={<DatabaseOutlined />} onClick={() => nav(`/virtual-warehouse?warehouse=${selected.warehouseCode}&zone=${selected.zoneCode}&location=${selected.locationCode}`)}>在虚拟仓库查看</Button>}><div className="capacity-overview-grid"><span><small>仓库</small>{selected.warehouseName} ({selected.warehouseCode})</span><span><small>库区</small>{selected.zoneName} ({selected.zoneCode})</span><span><small>库位状态</small><Tag color={colors[selected.status]}>{labels[selected.status]}</Tag></span><span><small>物料种类</small>{selected.itemTypeCount}</span></div></Card>
          <Card title="物料容量明细" className="capacity-table-card" extra={manageable && <Button type="link" icon={<PlusOutlined />} onClick={() => start(undefined, true)}>为此库位新增</Button>}><Table rowKey={(row: any) => row.itemId} dataSource={itemRows} pagination={false} scroll={{ y: 440, x: 1100 }} locale={{ emptyText: '当前库位暂无库存或容量配置，可新增容量。' }} columns={[
            { title: '物料', width: 220, render: (_: any, row: any) => <Tooltip title={row.itemName}>{row.itemCode} · {row.itemName}</Tooltip> }, { title: '型号', dataIndex: 'model', width: 130, render: (value: any) => value || '—' }, { title: '单位', dataIndex: 'unit', width: 80 }, { title: '现存', dataIndex: 'onHandQty', align: 'right', render: formatQuantity }, { title: '出库预占', dataIndex: 'outboundReservedQty', align: 'right', render: formatQuantity }, { title: '待入库占用', dataIndex: 'pendingInboundQty', align: 'right', render: formatQuantity }, { title: '可用', dataIndex: 'availableQty', align: 'right', render: formatQuantity }, { title: '容量', dataIndex: 'capacityQty', align: 'right', render: (value: any) => value === null ? '不限量' : formatQuantity(value) }, { title: '剩余', dataIndex: 'remainingCapacityQty', align: 'right', render: (value: any) => value === null ? '—' : formatQuantity(value) }, { title: '使用率', dataIndex: 'usageRate', align: 'right', render: (value: any) => value === null ? '—' : `${value}%` }, { title: '状态', dataIndex: 'capacityStatus', render: (value: string) => <Tag color={colors[value]}>{labels[value] || value}</Tag> }, { title: '备注', dataIndex: 'notes', ellipsis: true, width: 140, render: (value: string) => value || '—' }, ...(manageable ? [{ title: '操作', fixed: 'right' as const, render: (_: any, row: any) => <Button type="link" icon={<EditOutlined />} onClick={() => start(row, true)}>配置</Button> }] : [])
          ]} /></Card></> : <Card><Empty description="请选择库位" /></Card>}
      </section>
    </div>
    <Modal title={editing ? '编辑库位物料容量' : '新增库位物料容量'} open={open} onCancel={() => setOpen(false)} onOk={() => form.submit()} destroyOnHidden><Form form={form} layout="vertical" onFinish={save}>
      <Form.Item name="warehouseId" label="仓库" rules={[{ required: true }]}><Select disabled={contextLocked} onChange={chooseWarehouse} options={warehouses.map((row: any) => ({ value: row.id, label: `${row.name} (${row.warehouseCode})` }))} /></Form.Item>
      <Form.Item name="zoneId" label="库区" rules={[{ required: true }]}><Select disabled={contextLocked} onChange={chooseZone} options={zones.map((row: any) => ({ value: row.id, label: `${row.name} (${row.code})` }))} /></Form.Item>
      <Form.Item name="locationId" label="库位" rules={[{ required: true }]}><Select disabled={contextLocked} options={locations.map((row: any) => ({ value: row.locationId, label: `${row.locationCode} ${row.locationName}` }))} /></Form.Item>
      <Form.Item name="itemId" label="物料" rules={[{ required: true }]}><Select showSearch optionFilterProp="label" disabled={Boolean(editing)} options={items.map(row => ({ value: row.id, label: `${row.itemCode} ${row.name} (${row.unit})` }))} /></Form.Item>
      <Form.Item name="capacity" label="容量上限" rules={[{ required: true }]}><InputNumber min={1} precision={0} style={{ width: '100%' }} /></Form.Item><Form.Item name="notes" label="备注"><Input.TextArea maxLength={500} rows={3} /></Form.Item>
    </Form></Modal>
  </PageScaffold>;
}
