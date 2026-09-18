import { useEffect, useMemo, useState } from 'react';
import dayjs from 'dayjs';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Checkbox, Descriptions, Drawer, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Switch, Tag, Typography, message } from 'antd';
import { DeleteOutlined, DownloadOutlined, PlusOutlined } from '@ant-design/icons';
import { api, idempotencyKey, token } from './api';
import { PageScaffold, StatusTag } from './components';
import { ResponsiveTable as Table } from './responsive';
import { formatBeijingTime, formatQuantity, statusText } from './domain';
import { useParams } from 'react-router-dom';
import type { User } from './App';

const fail = (error: any) => message.error(error?.message || '操作失败');
const normalize = (row: any) => ({
  ...row,
  warehouseId: row.warehouseId || row.warehouse_id,
  zoneId: row.zoneId || row.zone_id,
  itemId: row.itemId || row.item_id,
  batchNo: row.batchNo || row.batch_no,
});

export function ItemsV110Page() {
  const [data, setData] = useState<any>({ items: [] });
  const [units, setUnits] = useState<any[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [editing, setEditing] = useState<any>();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const load = () => Promise.all([
    api('/items?pageSize=100'),
    api('/units?pageSize=100&status=ACTIVE'),
    api('/item-categories?pageSize=100&status=ACTIVE'),
  ]).then(([items, unitRows, categoryRows]) => {
    setData(items); setUnits(unitRows.items); setCategories(categoryRows.items);
  }).catch(fail);
  useEffect(() => { void load(); }, []);
  const edit = async (record: any) => {
    try {
      const detail = await api(`/items/${record.id}`);
      setEditing(detail);
      form.setFieldsValue({ itemCode: detail.itemCode, itemType: detail.itemType, name: detail.name, unitId: detail.unitId, categoryId: detail.categoryId, minimumStock: Number(detail.minimumStock), status: detail.status });
      setOpen(true);
    } catch (error) { fail(error); }
  };
  const save = async (values: any) => {
    const common = { name: values.name, categoryId: values.categoryId, minimumStock: String(values.minimumStock || 0), status: values.status };
    const payload = editing
      ? { ...common, ...(editing.canEditIdentity ? { itemCode: values.itemCode, itemType: values.itemType, unitId: values.unitId } : {}) }
      : { ...common, itemCode: values.itemCode, itemType: values.itemType, unitId: values.unitId };
    try {
      await api(editing ? `/items/${editing.id}` : '/items', { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
      message.success('物料已保存'); setOpen(false); load();
    } catch (error) { fail(error); }
  };
  const remove = async (id: string) => {
    try { await api(`/items/${id}`, { method: 'DELETE' }); message.success('物料已删除'); load(); } catch (error) { fail(error); }
  };
  return <PageScaffold title="物料管理" subtitle="维护统一物料、分类、单位及安全库存。被业务引用后编码、类型和单位将锁定。">
    <div className="toolbar"><span /><Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(undefined); form.resetFields(); form.setFieldsValue({ itemType: 'MATERIAL', minimumStock: 0, status: 'ACTIVE' }); setOpen(true); }}>新增物料</Button></div>
    <Table rowKey="id" dataSource={data.items} columns={[
      { title: '编码', dataIndex: 'itemCode' }, { title: '名称', dataIndex: 'name' },
      { title: '分类', dataIndex: 'categoryName' }, { title: '类型', dataIndex: 'itemType', render: value => value === 'MATERIAL' ? '原材料' : '成品' },
      { title: '单位', dataIndex: 'unitName' }, { title: '安全库存', dataIndex: 'minimumStock', align: 'right', render: formatQuantity },
      { title: '状态', dataIndex: 'status', render: value => <StatusTag value={value} /> },
      { title: '操作', render: (_, record) => <Space><Button type="link" onClick={() => edit(record)}>编辑</Button><Popconfirm title="确认删除该物料？" onConfirm={() => remove(record.id)}><Button danger type="link">删除</Button></Popconfirm></Space> },
    ]} />
    <Modal title={editing ? '编辑物料' : '新增物料'} open={open} onCancel={() => setOpen(false)} onOk={() => form.submit()} destroyOnHidden>
      <Form form={form} layout="vertical" onFinish={save}>
        {editing && !editing.canEditIdentity && <Tag color="warning">该物料已被引用，编码、类型和单位不可修改</Tag>}
        <Form.Item label="编码" name="itemCode" rules={[{ required: true }]}><Input disabled={editing && !editing.canEditIdentity} /></Form.Item>
        <Form.Item label="名称" name="name" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item label="类型" name="itemType" rules={[{ required: true }]}><Select disabled={editing && !editing.canEditIdentity} options={[{ value: 'MATERIAL', label: '原材料' }, { value: 'FINISHED_GOOD', label: '成品' }]} /></Form.Item>
        <Form.Item label="分类" name="categoryId" rules={[{ required: true }]}><Select options={categories.map(row => ({ value: row.id, label: `${row.code} ${row.name}` }))} /></Form.Item>
        <Form.Item label="单位" name="unitId" rules={[{ required: true }]}><Select disabled={editing && !editing.canEditIdentity} options={units.map(row => ({ value: row.id, label: `${row.code} ${row.name}` }))} /></Form.Item>
        <Form.Item label="安全库存" name="minimumStock"><InputNumber min={0} precision={0} style={{ width: '100%' }} /></Form.Item>
        <Form.Item label="状态" name="status"><Select options={[{ value: 'ACTIVE', label: '启用' }, { value: 'INACTIVE', label: '停用' }]} /></Form.Item>
      </Form>
    </Modal>
  </PageScaffold>;
}

const masterConfig = {
  categories: { title: '物料分类', endpoint: '/item-categories' },
  units: { title: '计量单位', endpoint: '/units' },
} as const;

export function SimpleMasterPage({ kind }: { kind: keyof typeof masterConfig }) {
  const config = masterConfig[kind];
  const [rows, setRows] = useState<any[]>([]);
  const [editing, setEditing] = useState<any>();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const load = () => api(`${config.endpoint}?pageSize=100`).then(data => setRows(data.items)).catch(fail);
  useEffect(() => { void load(); }, [kind]);
  const save = async (values: any) => {
    try {
      await api(editing ? `${config.endpoint}/${editing.id}` : config.endpoint, { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(values) });
      message.success('保存成功'); setOpen(false); load();
    } catch (error) { fail(error); }
  };
  const remove = async (id: string) => { try { await api(`${config.endpoint}/${id}`, { method: 'DELETE' }); message.success('删除成功'); load(); } catch (error) { fail(error); } };
  return <PageScaffold title={config.title} subtitle="未引用数据可删除；已引用数据请停用，系统会返回具体关联数量。">
    <div className="toolbar"><span /><Button type="primary" onClick={() => { setEditing(undefined); form.resetFields(); setOpen(true); }}>新增</Button></div>
    <Table rowKey="id" dataSource={rows} columns={[
      { title: '编码', dataIndex: 'code' }, { title: '名称', dataIndex: 'name' }, { title: '状态', dataIndex: 'status', render: value => <StatusTag value={value} /> },
      { title: '操作', render: (_, record) => <Space><Button type="link" onClick={() => { setEditing(record); form.setFieldsValue(record); setOpen(true); }}>编辑</Button><Popconfirm title="确认删除？" onConfirm={() => remove(record.id)}><Button danger type="link">删除</Button></Popconfirm></Space> },
    ]} />
    <Modal title={`${editing ? '编辑' : '新增'}${config.title}`} open={open} onCancel={() => setOpen(false)} onOk={() => form.submit()}>
      <Form form={form} layout="vertical" onFinish={save}>
        <Form.Item label="编码" name="code" rules={[{ required: !editing }]}><Input disabled={!!editing} /></Form.Item>
        <Form.Item label="名称" name="name" rules={[{ required: true }]}><Input /></Form.Item>
        {editing && <Form.Item label="状态" name="status"><Select options={[{ value: 'ACTIVE', label: '启用' }, { value: 'INACTIVE', label: '停用' }]} /></Form.Item>}
      </Form>
    </Modal>
  </PageScaffold>;
}

export function WarehousesPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [editing, setEditing] = useState<any>();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const load = () => api('/warehouses').then(setRows).catch(fail);
  useEffect(() => { void load(); }, []);
  const save = async (values: any) => { try { await api(editing ? `/warehouses/${editing.id}` : '/warehouses', { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(values) }); message.success('仓库已保存'); setOpen(false); load(); } catch (error) { fail(error); } };
  const remove = async (id: string) => { try { await api(`/warehouses/${id}`, { method: 'DELETE' }); message.success('仓库已删除'); load(); } catch (error) { fail(error); } };
  return <PageScaffold title="仓库管理" subtitle="RAW、FG 为受保护的初始仓库；可新增原材料或成品类型仓库。">
    <div className="toolbar"><span /><Button type="primary" onClick={() => { setEditing(undefined); form.resetFields(); form.setFieldsValue({ warehouseType: 'RAW' }); setOpen(true); }}>新增仓库</Button></div>
    <Table rowKey="id" dataSource={rows} columns={[
      { title: '编码', dataIndex: 'warehouseCode' }, { title: '名称', dataIndex: 'name' }, { title: '类型', dataIndex: 'warehouseType' }, { title: '状态', dataIndex: 'status', render: value => <StatusTag value={value} /> },
      { title: '操作', render: (_, record) => <Space><Button type="link" onClick={async () => { setEditing(record); const managers=await api(`/warehouses/${record.id}/managers`).catch(()=>[]); form.setFieldsValue({...record,managerIds:(managers||[]).map((m:any)=>m.id)}); setOpen(true); }}>编辑</Button><Popconfirm title="确认删除仓库？" onConfirm={() => remove(record.id)}><Button danger type="link">删除</Button></Popconfirm></Space> },
    ]} />
    <Modal title={editing ? '编辑仓库' : '新增仓库'} open={open} onCancel={() => setOpen(false)} onOk={() => form.submit()}>
      <Form form={form} layout="vertical" onFinish={save}>
        <Form.Item label="编码" name="warehouseCode" rules={[{ required: !editing }]}><Input disabled={!!editing} /></Form.Item>
        <Form.Item label="名称" name="name" rules={[{ required: true }]}><Input /></Form.Item>
        {!editing && <Form.Item label="类型" name="warehouseType" rules={[{ required: true }]}><Select options={[{ value: 'RAW', label: '原材料仓' }, { value: 'FG', label: '成品仓' }]} /></Form.Item>}
        {editing && <Form.Item label="状态" name="status"><Select options={[{ value: 'ACTIVE', label: '启用' }, { value: 'INACTIVE', label: '停用' }]} /></Form.Item>}
      </Form>
    </Modal>
  </PageScaffold>;
}

export function LocationsPage() {
  const [warehouses, setWarehouses] = useState<any[]>([]);
  const [zones, setZones] = useState<any[]>([]);
  const [locations, setLocations] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [capacities, setCapacities] = useState<any[]>([]);
  const [mode, setMode] = useState<'zone' | 'location'>();
  const [capacityOpen, setCapacityOpen] = useState(false);
  const [form] = Form.useForm();
  const [capacityForm] = Form.useForm();
  const load = async () => {
    try {
      const [w, z, l, c, first] = await Promise.all([api('/warehouses'), api('/warehouse-zones?pageSize=100'), api('/warehouse-locations?pageSize=100'), api('/location-item-capacities'), api('/items?page=1&pageSize=100&status=ACTIVE')]);
      const pages = Math.ceil(Number(first.total || 0) / 100);
      const rest = pages > 1 ? await Promise.all(Array.from({ length: pages - 1 }, (_, index) => api(`/items?page=${index + 2}&pageSize=100&status=ACTIVE`))) : [];
      setWarehouses(w); setZones(z.items.map(normalize)); setLocations(l.items.map(normalize)); setCapacities(c); setItems([...(first.items || []), ...rest.flatMap((page: any) => page.items || [])]);
    } catch (error) { fail(error); }
  };
  useEffect(() => { void load(); }, []);
  const save = async (values: any) => { try { await api(mode === 'zone' ? '/warehouse-zones' : '/warehouse-locations', { method: 'POST', body: JSON.stringify(values) }); message.success('保存成功'); setMode(undefined); load(); } catch (error) { fail(error); } };
  const saveCapacity = async (values: any) => { try { await api('/location-item-capacities', { method: 'PUT', body: JSON.stringify({ ...values, capacity: String(values.capacity) }) }); message.success('物料容量已保存'); setCapacityOpen(false); capacityForm.resetFields(); void load(); } catch (error) { fail(error); } };
  const removeCapacity = async (row: any) => { try { await api(`/location-item-capacities/${row.locationId}/${row.itemId}`, { method: 'DELETE' }); message.success('已取消该物料容量限制'); void load(); } catch (error) { fail(error); } };
  return <PageScaffold title="库区、库位与容量" subtitle="库存必须落到具体库位；可按“库位 + 物料”设置入库容量上限。">
    <div className="toolbar"><span /><Space><Button onClick={() => { setMode('zone'); form.resetFields(); }}>新增库区</Button><Button type="primary" onClick={() => { setMode('location'); form.resetFields(); }}>新增库位</Button></Space></div>
    <Card title="库区"><Table rowKey="id" pagination={false} dataSource={zones} columns={[{ title: '仓库', dataIndex: 'warehouseId', render: id => warehouses.find(w => w.id === id)?.warehouseCode }, { title: '编码', dataIndex: 'code' }, { title: '名称', dataIndex: 'name' }, { title: '状态', dataIndex: 'status', render: value => <StatusTag value={value} /> }]} /></Card>
    <Card title="库位" style={{ marginTop: 16 }}><Table rowKey="id" pagination={false} dataSource={locations} columns={[{ title: '仓库', dataIndex: 'warehouseId', render: id => warehouses.find(w => w.id === id)?.warehouseCode }, { title: '编码', dataIndex: 'code' }, { title: '名称', dataIndex: 'name' }, { title: '状态', dataIndex: 'status', render: value => <StatusTag value={value} /> }]} /></Card>
    <Card title="库位物料容量" style={{ marginTop: 16 }} extra={<Button type="primary" onClick={() => { capacityForm.resetFields(); setCapacityOpen(true); }}>配置物料容量</Button>}>
      <Typography.Text type="secondary">未配置容量的物料在该库位不限量；容量按“库位 + 物料”分别维护。</Typography.Text>
      <Table style={{ marginTop: 12 }} rowKey={(row: any) => `${row.locationId}-${row.itemId}`} pagination={false} dataSource={capacities} columns={[
        { title: '仓库 / 库区 / 库位', render: (_: any, row: any) => `${row.warehouseCode} / ${row.zoneCode} / ${row.locationCode}` },
        { title: '物料', render: (_: any, row: any) => `${row.itemCode} ${row.itemName}` },
        { title: '容量', render: (_: any, row: any) => `${formatQuantity(row.capacity)} ${row.unit}` },
        { title: '操作', render: (_: any, row: any) => <Popconfirm title="取消后该物料在此库位将不再受容量限制，确认继续？" onConfirm={() => removeCapacity(row)}><Button danger type="link">取消限制</Button></Popconfirm> },
      ]} />
    </Card>
    <Modal title={mode === 'zone' ? '新增库区' : '新增库位'} open={!!mode} onCancel={() => setMode(undefined)} onOk={() => form.submit()}>
      <Form form={form} layout="vertical" onFinish={save}>
        <Form.Item label="仓库" name="warehouseId" rules={[{ required: true }]}><Select options={warehouses.map(w => ({ value: w.id, label: `${w.warehouseCode} ${w.name}` }))} /></Form.Item>
        {mode === 'location' && <Form.Item noStyle shouldUpdate={(before, current) => before.warehouseId !== current.warehouseId}>{({ getFieldValue }) => <Form.Item label="库区" name="zoneId" rules={[{ required: true }]}><Select options={zones.filter(z => z.warehouseId === getFieldValue('warehouseId')).map(z => ({ value: z.id, label: `${z.code} ${z.name}` }))} /></Form.Item>}</Form.Item>}
        <Form.Item label="编码" name="code" rules={[{ required: true }]}><Input /></Form.Item><Form.Item label="名称" name="name" rules={[{ required: true }]}><Input /></Form.Item>
      </Form>
    </Modal>
    <Modal title="配置库位物料容量" open={capacityOpen} onCancel={() => setCapacityOpen(false)} onOk={() => capacityForm.submit()} destroyOnHidden>
      <Form form={capacityForm} layout="vertical" onFinish={saveCapacity}>
        <Form.Item label="仓库" name="warehouseId" rules={[{ required: true }]}><Select options={warehouses.map(w => ({ value: w.id, label: `${w.warehouseCode} ${w.name}` }))} onChange={() => capacityForm.setFieldValue('locationId', undefined)} /></Form.Item>
        <Form.Item noStyle shouldUpdate>{({ getFieldValue }) => <Form.Item label="库位" name="locationId" rules={[{ required: true }]}><Select showSearch optionFilterProp="label" options={locations.filter(location => location.warehouseId === getFieldValue('warehouseId')).map(location => ({ value: location.id, label: `${location.code} ${location.name}` }))} /></Form.Item>}</Form.Item>
        <Form.Item label="物料" name="itemId" rules={[{ required: true }]}><Select showSearch optionFilterProp="label" options={items.map(item => ({ value: item.id, label: `${item.itemCode} ${item.name}（${item.unit}）` }))} /></Form.Item>
        <Form.Item label="容量" name="capacity" rules={[{ required: true }]}><InputNumber min={1} precision={0} style={{ width: '100%' }} /></Form.Item>
      </Form>
    </Modal>
  </PageScaffold>;
}

export function BatchesPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const load = () => Promise.all([api('/batches?pageSize=100'), api('/items?pageSize=100&status=ACTIVE')]).then(([b, i]) => { setRows(b.items.map(normalize)); setItems(i.items); }).catch(fail);
  useEffect(() => { void load(); }, []);
  const save = async (values: any) => { try { await api('/batches', { method: 'POST', body: JSON.stringify(values) }); message.success('批次已创建'); setOpen(false); load(); } catch (error) { fail(error); } };
  return <PageScaffold title="批次管理" subtitle="批次在同一物料内唯一；业务出入库时手工选择，不启用 FIFO/FEFO。">
    <div className="toolbar"><span /><Button type="primary" onClick={() => { form.resetFields(); setOpen(true); }}>新增批次</Button></div>
    <Table rowKey="id" dataSource={rows} columns={[{ title: '物料', dataIndex: 'itemId', render: id => { const item = items.find(i => i.id === id); return item ? `${item.itemCode} ${item.name}` : id; } }, { title: '批次号', dataIndex: 'batchNo' }, { title: '状态', dataIndex: 'status', render: value => <StatusTag value={value} /> }, { title: '备注', dataIndex: 'notes' }]} />
    <Modal title="新增批次" open={open} onCancel={() => setOpen(false)} onOk={() => form.submit()}><Form form={form} layout="vertical" onFinish={save}><Form.Item label="物料" name="itemId" rules={[{ required: true }]}><Select showSearch optionFilterProp="label" options={items.map(i => ({ value: i.id, label: `${i.itemCode} ${i.name}` }))} /></Form.Item><Form.Item label="批次号" name="batchNo" rules={[{ required: true }]}><Input /></Form.Item><Form.Item label="备注" name="notes"><Input.TextArea /></Form.Item></Form></Modal>
  </PageScaffold>;
}

type StockType = 'MATERIAL_INBOUND' | 'FINISHED_INBOUND' | 'FINISHED_OUTBOUND' | 'INVENTORY_ADJUSTMENT' | 'STOCK_MOVE';
const stockMeta: Record<StockType, { title: string; endpoint: string; itemType?: string }> = {
  MATERIAL_INBOUND: { title: '原材料入库', endpoint: '/stock-documents/material-inbound', itemType: 'MATERIAL' },
  FINISHED_INBOUND: { title: '成品入库', endpoint: '/stock-documents/finished-inbound', itemType: 'FINISHED_GOOD' },
  FINISHED_OUTBOUND: { title: '成品出库', endpoint: '/stock-documents/finished-outbound', itemType: 'FINISHED_GOOD' },
  INVENTORY_ADJUSTMENT: { title: '库存调整', endpoint: '/stock-documents/inventory-adjustment' },
  STOCK_MOVE: { title: '移库', endpoint: '/stock-documents/move' },
};

export function StockDocumentsV110Page({ type }: { type: StockType }) {
  const meta = stockMeta[type];
  const adjustment = type === 'INVENTORY_ADJUSTMENT';
  const moving = type === 'STOCK_MOVE';
  const inbound = type === 'MATERIAL_INBOUND' || type === 'FINISHED_INBOUND';
  const outbound = type === 'FINISHED_OUTBOUND';
  const [rows, setRows] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [sourceItems, setSourceItems] = useState<any[]>([]);
  const [sourceItemsLoading, setSourceItemsLoading] = useState(false);
  const [warehouses, setWarehouses] = useState<any[]>([]);
  const [locations, setLocations] = useState<any[]>([]);
  const [batches, setBatches] = useState<any[]>([]);
  const [editing, setEditing] = useState<any>();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const watchedWarehouseId = Form.useWatch('warehouseId', form);
  const watchedLines = Form.useWatch('lines', form);
  const [inventoryByKey, setInventoryByKey] = useState<Record<string, any>>({});
  const load = () => Promise.all([
    api(`/stock-documents?documentType=${type}&pageSize=100`), api(`/items?pageSize=100&status=ACTIVE${meta.itemType ? `&itemType=${meta.itemType}` : ''}`),
    api('/warehouses'), api('/warehouse-locations?pageSize=100'), api('/batches?pageSize=100'),
  ]).then(([docs, itemRows, warehouseRows, locationRows, batchRows]) => {
    setRows(docs.items); setItems(itemRows.items); setWarehouses(warehouseRows);
    setLocations(locationRows.items.map(normalize)); setBatches(batchRows.items.map(normalize));
  }).catch(fail);
  useEffect(() => { void load(); }, [type]);
  useEffect(() => {
    if (!open || !(outbound || moving) || !watchedWarehouseId) {
      setSourceItems([]);
      setSourceItemsLoading(false);
      return;
    }
    let active = true;
    const purpose = moving ? 'MOVE_SOURCE' : 'OUTBOUND';
    const loadCandidates = async () => {
      setSourceItemsLoading(true);
      const first = await api(`/stock-documents/source-item-options?${new URLSearchParams({ warehouseId: watchedWarehouseId, purpose, page: '1', pageSize: '100' })}`);
      const pageCount = Math.ceil(Number(first.total || 0) / Number(first.pageSize || 100));
      const rest = await Promise.all(Array.from({ length: Math.max(0, pageCount - 1) }, (_, index) => api(`/stock-documents/source-item-options?${new URLSearchParams({ warehouseId: watchedWarehouseId, purpose, page: String(index + 2), pageSize: String(first.pageSize || 100) })}`)));
      if (active) setSourceItems([...(first.items || []), ...rest.flatMap((page: any) => page.items || [])]);
    };
    void loadCandidates().catch(error => { if (active) fail(error); }).finally(() => { if (active) setSourceItemsLoading(false); });
    return () => { active = false; };
  }, [moving, open, outbound, watchedWarehouseId]);
  useEffect(() => {
    if (!(inbound || outbound || moving)) return;
    const lines = watchedLines || [];
    const requests = new Map<string, { warehouseId: string; itemId: string; purpose: string }>();
    for (const line of lines) {
      if (watchedWarehouseId && line?.itemId) requests.set(`${watchedWarehouseId}:${line.itemId}:${moving ? 'MOVE_SOURCE' : outbound ? 'OUTBOUND' : 'INBOUND'}`, { warehouseId: watchedWarehouseId, itemId: line.itemId, purpose: moving ? 'MOVE_SOURCE' : outbound ? 'OUTBOUND' : 'INBOUND' });
      if (moving && line?.targetWarehouseId && line?.itemId) requests.set(`${line.targetWarehouseId}:${line.itemId}:MOVE_TARGET`, { warehouseId: line.targetWarehouseId, itemId: line.itemId, purpose: 'MOVE_TARGET' });
    }
    let active = true;
    void Promise.all([...requests.entries()].map(async ([key, params]) => [key, await api(`/stock-documents/item-location-inventory?${new URLSearchParams(params)}`)] as const))
      .then(rows => { if (active) setInventoryByKey(current => ({ ...current, ...Object.fromEntries(rows) })); })
      .catch(fail);
    return () => { active = false; };
  }, [inbound, moving, outbound, watchedLines, watchedWarehouseId]);
  const save = async (values: any) => {
    const lines = values.lines.map(({ sourceKey, ...line }: any) => adjustment
      ? { ...line, adjustmentQty: String(line.adjustmentQty) }
      : { ...line, quantity: String(line.quantity) });
    try {
      await api(editing ? `/stock-documents/${editing.id}` : meta.endpoint, { method: editing ? 'PATCH' : 'POST', body: JSON.stringify({ warehouseId: values.warehouseId, notes: values.notes, lines }) });
      message.success('单据已保存'); setOpen(false); setEditing(undefined); load();
    } catch (error) { fail(error); }
  };
  const run = async (record: any, action: string, body?: any) => {
    try {
      await api(`/stock-documents/${record.id}/${action}`, {
        method: 'POST',
        headers: action === 'void' ? { 'Idempotency-Key': idempotencyKey() } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      message.success({ submit: '已提交审核', withdraw: '已撤回', void: '已冲销' }[action] || '操作成功');
      load();
    } catch (error) { fail(error); }
  };
  const edit = async (record: any) => {
    try {
      const detail = await api(`/stock-documents/${record.id}`);
      setEditing(detail); form.setFieldsValue({ warehouseId: detail.warehouseId, notes: detail.notes, lines: detail.lines.map((line: any) => ({ itemId: line.itemId, locationId: line.locationId, batchId: line.batchId, sourceKey: `${line.locationId}:${line.batchId || ''}`, targetWarehouseId: line.targetWarehouseId, targetLocationId: line.targetLocationId, targetBatchId: line.targetBatchId, quantity: Number(line.quantity) })) }); setOpen(true);
    } catch (error) { fail(error); }
  };
  useEffect(() => {
    const documentId = new URLSearchParams(window.location.search).get('documentId');
    if (documentId) void edit({ id: documentId });
  }, [type]);
  const remove = async (id: string) => { try { await api(`/stock-documents/${id}`, { method: 'DELETE' }); message.success('单据已删除'); load(); } catch (error) { fail(error); } };
  return <PageScaffold title={meta.title} subtitle="草稿提交后进入一级审核；只有审核通过才会改变库存和生产累计。">
    <div className="toolbar"><span /><Button type="primary" onClick={() => { const params = new URLSearchParams(window.location.search); const warehouseId = params.get('warehouseId') || undefined; const zoneId = params.get('zoneId') || undefined; const sourceLocation = locations.find(location => location.warehouseId === warehouseId && (!zoneId || location.zoneId === zoneId)); setEditing(undefined); form.resetFields(); form.setFieldsValue({ warehouseId, lines: [{ locationId: sourceLocation?.id }] }); setOpen(true); }}>新建{meta.title}单</Button></div>
    <Table rowKey="id" dataSource={rows} columns={[
      { title: '单号', dataIndex: 'documentNo' }, { title: '仓库', dataIndex: 'warehouseCode' }, { title: '状态', dataIndex: 'status', render: value => <StatusTag value={value} /> },
      { title: '创建时间', dataIndex: 'createdAt', render: formatBeijingTime },
      { title: '操作', render: (_, record) => <Space wrap>
        {['DRAFT', 'REJECTED'].includes(record.status) && <Button type="link" onClick={() => edit(record)}>编辑</Button>}
        {['DRAFT', 'REJECTED'].includes(record.status) && <Button type="link" onClick={() => run(record, 'submit')}>提交</Button>}
        {record.status === 'SUBMITTED' && <Button type="link" onClick={() => run(record, 'withdraw')}>撤回</Button>}
        {record.status === 'POSTED' && <Button danger type="link" onClick={() => run(record, 'void', { reason: '页面冲销' })}>冲销</Button>}
        {['DRAFT', 'REJECTED'].includes(record.status) && <Popconfirm title="确认删除该草稿？" onConfirm={() => remove(record.id)}><Button danger type="link" icon={<DeleteOutlined />}>删除</Button></Popconfirm>}
      </Space> },
    ]} />
    <Modal width={760} title={`${editing ? '编辑' : '新建'}${meta.title}单`} open={open} onCancel={() => setOpen(false)} onOk={() => form.submit()} destroyOnHidden>
      <Form form={form} layout="vertical" onFinish={save}>
        <Form.Item label="仓库" name="warehouseId" rules={[{ required: true }]}><Select options={warehouses.filter(w => !meta.itemType || w.warehouseType === (meta.itemType === 'MATERIAL' ? 'RAW' : 'FG')).map(w => ({ value: w.id, label: `${w.warehouseCode} ${w.name}` }))} onChange={() => { setInventoryByKey({}); form.setFieldValue('lines', (form.getFieldValue('lines') || []).map(() => ({}))); }} /></Form.Item>
        {(outbound || moving) && watchedWarehouseId && !sourceItemsLoading && !sourceItems.length && <Typography.Text type="warning">该仓库暂无可出库或移库的可用库存。</Typography.Text>}
        <Form.List name="lines">{(fields, { add, remove: removeLine }) => <>{fields.map(field => <Card size="small" key={field.key} style={{ marginBottom: 10 }}>
          <Form.Item {...field} label="物料" name={[field.name, 'itemId']} rules={[{ required: true }]}><Select showSearch optionFilterProp="label" loading={(outbound || moving) && sourceItemsLoading} disabled={(outbound || moving) && !watchedWarehouseId} notFoundContent={watchedWarehouseId ? '暂无可用库存物料' : '请先选择仓库'} options={((outbound || moving) ? sourceItems : items).map(i => ({ value: i.itemId || i.id, label: outbound || moving ? `${i.itemCode} ${i.name}｜可用 ${formatQuantity(i.availableQty)} ${i.unit}｜${i.locationCount} 个库位` : `${i.itemCode} ${i.name}` }))} onChange={(itemId) => form.setFieldValue(['lines', field.name], { itemId })} /></Form.Item>
          <Form.Item noStyle shouldUpdate>{({ getFieldValue }) => {
            const warehouseId = getFieldValue('warehouseId');
            const itemId = getFieldValue(['lines', field.name, 'itemId']);
            const sourcePurpose = moving ? 'MOVE_SOURCE' : outbound ? 'OUTBOUND' : 'INBOUND';
            const source = itemId && warehouseId ? inventoryByKey[`${warehouseId}:${itemId}:${sourcePurpose}`] : undefined;
            const targetWarehouseId = getFieldValue(['lines', field.name, 'targetWarehouseId']);
            const target = moving && itemId && targetWarehouseId ? inventoryByKey[`${targetWarehouseId}:${itemId}:MOVE_TARGET`] : undefined;
            const sourceBatches = (source?.locations || []).flatMap((location: any) => (location.batches || []).filter((batch: any) => Number(batch.availableQty) > 0).map((batch: any) => ({ ...batch, location })));
            const sourceKey = getFieldValue(['lines', field.name, 'sourceKey']);
            const selectedSourceBatch = sourceBatches.find((batch: any) => `${batch.location.locationId}:${batch.batchId || ''}` === sourceKey);
            const sourceAvailableQty = selectedSourceBatch ? Number(selectedSourceBatch.availableQty) : undefined;
            const sourceOptions = (outbound || moving)
              ? sourceBatches.map((batch: any) => ({ value: `${batch.location.locationId}:${batch.batchId || ''}`, batchId: batch.batchId, locationId: batch.location.locationId, label: `${batch.location.zoneCode} / ${batch.location.locationCode}｜批次 ${batch.batchNo || '无'}｜可用 ${formatQuantity(batch.availableQty)}` }))
              : inbound ? (source?.locations || []).map((location: any) => ({ value: location.locationId, disabled: location.isFull, label: `${location.zoneCode} / ${location.locationCode}｜现存 ${formatQuantity(location.onHandQty)}｜${location.capacityQty === null ? '不限量' : `剩余 ${formatQuantity(location.availableCapacityQty)}`}` }))
                : locations.filter(location => location.warehouseId === warehouseId).map(location => ({ value: location.id, label: `${location.code} ${location.name}` }));
            const targetOptions = (target?.locations || []).map((location: any) => ({ value: location.locationId, disabled: location.isFull, label: `${location.zoneCode} / ${location.locationCode}｜现存 ${formatQuantity(location.onHandQty)}｜${location.capacityQty === null ? '不限量' : `剩余 ${formatQuantity(location.availableCapacityQty)}`}` }));
            const sourceWarehouse = warehouses.find(warehouse => warehouse.id === warehouseId);
            const targetWarehouseOptions = warehouses.filter(warehouse => !sourceWarehouse || warehouse.warehouseType === sourceWarehouse.warehouseType).map(warehouse => ({ value: warehouse.id, label: `${warehouse.warehouseCode} ${warehouse.name}` }));
            const displayed = (outbound || moving) ? sourceBatches : (source?.locations || []);
            return <>
              <Space align="start" wrap>
                {(outbound || moving) ? <Form.Item {...field} label="来源库位 / 批次" name={[field.name, 'sourceKey']} rules={[{ required: true }]}><Select style={{ width: 310 }} options={sourceOptions} onChange={(_value, option: any) => { form.setFieldValue(['lines', field.name, 'locationId'], option?.locationId); form.setFieldValue(['lines', field.name, 'batchId'], option?.batchId); form.setFieldValue(['lines', field.name, 'quantity'], undefined); if (moving) form.setFieldValue(['lines', field.name, 'targetBatchId'], option?.batchId); }} /></Form.Item> : <><Form.Item {...field} label={inbound ? '入库库位' : '库位'} name={[field.name, 'locationId']} rules={[{ required: true }]}><Select style={{ width: 280 }} options={sourceOptions} /></Form.Item><Form.Item {...field} label="批次（可选）" name={[field.name, 'batchId']}><Select allowClear style={{ width: 180 }} options={batches.filter(b => b.itemId === itemId).map(b => ({ value: b.id, label: b.batchNo }))} /></Form.Item></>}
                {moving && <><Form.Item {...field} label="目标仓库" name={[field.name, 'targetWarehouseId']} rules={[{ required: true }]}><Select style={{ width: 190 }} options={targetWarehouseOptions} onChange={() => { form.setFieldValue(['lines', field.name, 'targetLocationId'], undefined); form.setFieldValue(['lines', field.name, 'targetBatchId'], undefined); }} /></Form.Item><Form.Item {...field} label="目标库位" name={[field.name, 'targetLocationId']} rules={[{ required: true }]}><Select style={{ width: 280 }} options={targetOptions} /></Form.Item><Form.Item {...field} label="目标批次（可选）" name={[field.name, 'targetBatchId']}><Select allowClear style={{ width: 180 }} options={batches.filter(b => b.itemId === itemId).map(b => ({ value: b.id, label: b.batchNo }))} /></Form.Item></>}
                <Form.Item {...field} label={adjustment ? '调整数量（正增负减）' : moving ? '移库数量' : inbound ? '入库数量' : '出库数量'} name={[field.name, adjustment ? 'adjustmentQty' : 'quantity']} rules={[{ required: true }, ...((outbound || moving) && sourceAvailableQty !== undefined ? [{ validator: (_rule: any, value: number | undefined) => value !== undefined && Number(value) > sourceAvailableQty ? Promise.reject(new Error(`数量不能超过可用库存 ${formatQuantity(sourceAvailableQty)}`)) : Promise.resolve() }] : [])]}><InputNumber precision={0} min={adjustment ? undefined : 1} max={(outbound || moving) ? sourceAvailableQty : undefined} style={{ width: 180 }} /></Form.Item>
                {fields.length > 1 && <Button danger onClick={() => removeLine(field.name)}>删除行</Button>}
              </Space>
              {(inbound || outbound || moving) && itemId && <Table size="small" style={{ marginTop: 8 }} rowKey={(row: any) => row.batchId ? `${row.locationId}-${row.batchId}` : row.locationId} pagination={false} dataSource={displayed} columns={[
                { title: '库区 / 库位', render: (_: any, row: any) => `${row.location?.zoneCode || row.zoneCode} / ${row.location?.locationCode || row.locationCode}` },
                ...(outbound || moving ? [{ title: '批次', dataIndex: 'batchNo', render: (value: any) => value || '无' }] : []),
                { title: '现存', dataIndex: 'onHandQty', align: 'right', render: formatQuantity },
                { title: '冻结', dataIndex: 'frozenQty', align: 'right', render: formatQuantity },
                { title: '已预占', dataIndex: 'reservedQty', align: 'right', render: formatQuantity },
                { title: outbound || moving ? '可用数量' : '剩余容量', align: 'right', render: (_: any, row: any) => outbound || moving ? formatQuantity(row.availableQty) : row.capacityQty === null ? '不限量' : formatQuantity(row.availableCapacityQty) },
              ]} />}
              {(outbound || moving) && source && !sourceBatches.length && <Typography.Text type="warning">当前仓库没有该物料可用库存，请更换物料或仓库。</Typography.Text>}
              {inbound && source && !(source.locations || []).some((location: any) => !location.isFull) && <Typography.Text type="warning">当前仓库没有可接收入库的库位，请先配置容量或调整库位容量。</Typography.Text>}
            </>;
          }}</Form.Item>
        </Card>)}<Button block type="dashed" onClick={() => add()}>增加明细</Button></>}</Form.List>
        <Form.Item label="备注" name="notes"><Input.TextArea /></Form.Item>
      </Form>
    </Modal>
  </PageScaffold>;
}

export function InventoryV110Page() {
  const [data, setData] = useState<any>({ items: [] });
  const [warehouses, setWarehouses] = useState<any[]>([]);
  const [zones, setZones] = useState<any[]>([]);
  const [locations, setLocations] = useState<any[]>([]);
  const [filters, setFilters] = useState<any>({});
  const query = (values = filters) => new URLSearchParams(Object.entries(values).filter(([, value]) => value !== undefined && value !== '') as [string, string][]).toString();
  const load = (values = filters) => api(`/inventory/balances?pageSize=100&${query(values)}`).then(setData).catch(fail);
  useEffect(() => {
    load();
    Promise.all([api('/warehouses'), api('/warehouse-zones?pageSize=100'), api('/warehouse-locations?pageSize=100')]).then(([w, z, l]) => { setWarehouses(w); setZones(z.items.map(normalize)); setLocations(l.items.map(normalize)); }).catch(fail);
  }, []);
  const change = (patch: any) => { const next = { ...filters, ...patch }; setFilters(next); load(next); };
  const exportCsv = async () => {
    try {
      const response = await fetch(`/api/inventory/export?${query(filters)}`, { headers: { Authorization: `Bearer ${token()}` } });
      if (!response.ok) throw new Error((await response.json()).message || '导出失败');
      const url = URL.createObjectURL(await response.blob()); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `inventory-${new Date().toISOString().slice(0, 10)}.csv`; anchor.click(); URL.revokeObjectURL(url);
    } catch (error) { fail(error); }
  };
  const reconcile = async () => { try { const result = await api('/inventory/reconciliation'); result.consistent ? message.success('余额与流水一致') : Modal.error({ title: '发现库存差异', content: `共 ${result.differences.length} 条差异，请停止写入并排查。` }); } catch (error) { fail(error); } };
  return <PageScaffold title="当前库存" subtitle="按仓库、库区、库位、物料与批次维度查询；不同单位不跨物料汇总。">
    <div className="toolbar"><Space wrap>
      <Input.Search allowClear placeholder="物料编码/名称/批次" onSearch={value => change({ keyword: value })} />
      <Select allowClear placeholder="仓库" style={{ width: 170 }} options={warehouses.map(w => ({ value: w.id, label: `${w.warehouseCode} ${w.name}` }))} onChange={value => change({ warehouseId: value, zoneId: undefined, locationId: undefined })} />
      <Select allowClear placeholder="库区" style={{ width: 150 }} options={zones.filter(z => !filters.warehouseId || z.warehouseId === filters.warehouseId).map(z => ({ value: z.id, label: z.code }))} onChange={value => change({ zoneId: value })} />
      <Select allowClear placeholder="库位" style={{ width: 170 }} options={locations.filter(l => !filters.warehouseId || l.warehouseId === filters.warehouseId).map(l => ({ value: l.id, label: l.code }))} onChange={value => change({ locationId: value })} />
    </Space><Space><Button icon={<DownloadOutlined />} onClick={exportCsv}>导出 CSV</Button><Button onClick={reconcile}>一致性检查</Button></Space></div>
    <Table rowKey="id" dataSource={data.items} columns={[
      { title: '仓库', dataIndex: 'warehouseCode' }, { title: '库区', dataIndex: 'zoneCode' }, { title: '库位', dataIndex: 'locationCode' },
      { title: '物料', render: (_, r) => `${r.itemCode} ${r.itemName}` }, { title: '批次', dataIndex: 'batchNo', render: value => value || '-' },
      { title: '当前库存', dataIndex: 'onHandQty', align: 'right', render: value => <strong>{formatQuantity(value)}</strong> }, { title: '安全库存', dataIndex: 'minimumStock', align: 'right', render: formatQuantity },
      { title: '状态', render: (_, r) => Number(r.onHandQty) === 0 ? <Tag color="error">零库存</Tag> : Number(r.onHandQty) <= Number(r.minimumStock) ? <Tag color="warning">低库存</Tag> : <Tag color="success">正常</Tag> },
      { title: '单位', dataIndex: 'unit' },
    ]} />
  </PageScaffold>;
}

export function TransactionsV110Page() {
  const [data, setData] = useState<any>({ items: [] });
  const [keyword, setKeyword] = useState('');
  const load = () => api(`/inventory/transactions?pageSize=100&keyword=${encodeURIComponent(keyword)}`).then(setData).catch(fail);
  useEffect(() => { void load(); }, []);
  return <PageScaffold title="库存流水" subtitle="流水不可修改或删除；记录变动前数量、库位、批次、变动量和变动后结余。">
    <div className="toolbar"><Input.Search allowClear style={{ width: 320 }} placeholder="物料或来源单号" onChange={event => setKeyword(event.target.value)} onSearch={load} /></div>
    <Table rowKey="id" dataSource={data.items} columns={[
      { title: '时间', dataIndex: 'createdAt', render: formatBeijingTime }, { title: '仓库', dataIndex: 'warehouseCode' }, { title: '库位', dataIndex: 'locationCode' },
      { title: '物料', render: (_, r) => `${r.itemCode} ${r.itemName}` }, { title: '批次', dataIndex: 'batchNo', render: value => value || '-' },
      { title: '来源单号', dataIndex: 'documentNo' }, { title: '类型', dataIndex: 'documentType', render: value => statusText[value] || value },
      { title: '变动前', dataIndex: 'balanceBefore', align: 'right', render: formatQuantity }, { title: '变动量', dataIndex: 'deltaQty', align: 'right', render: value => <span className={Number(value) >= 0 ? 'positive' : 'negative'}>{Number(value) > 0 ? '+' : ''}{formatQuantity(value)}</span> },
      { title: '变动后', dataIndex: 'balanceAfter', align: 'right', render: formatQuantity }, { title: '操作人', dataIndex: 'operator' },
    ]} />
  </PageScaffold>;
}

export function ProductionDetailV110Page({ user }: { user: User }) {
  const { id } = useParams();
  const [data, setData] = useState<any>();
  const [warehouses, setWarehouses] = useState<any[]>([]);
  const [locations, setLocations] = useState<any[]>([]);
  const [batches, setBatches] = useState<any[]>([]);
  const [action, setAction] = useState<'issue' | 'return' | 'complete'>();
  const [form] = Form.useForm();
  const load = () => Promise.all([api(`/production-orders/${id}`), api('/warehouses'), api('/warehouse-locations?pageSize=100'), api('/batches?pageSize=100')]).then(([order, w, l, b]) => {
    setData(order); setWarehouses(w); setLocations(l.items.map(normalize)); setBatches(b.items.map(normalize));
  }).catch(fail);
  useEffect(() => { void load(); }, [id]);
  const selectedWarehouse = Form.useWatch('warehouseId', form);
  const submit = async (values: any) => {
    const payload = action === 'complete'
      ? { warehouseId: values.warehouseId, locationId: values.locationId, batchId: values.batchId, quantity: String(values.quantity), notes: values.notes }
      : { warehouseId: values.warehouseId, lines: values.lines.map((line: any) => ({ ...line, quantity: String(line.quantity) })), notes: values.notes };
    try {
      await api(`/production-orders/${id}/${action}`, { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey() }, body: JSON.stringify(payload) });
      message.success('关联库存单据已提交审核，审核通过后才会更新库存与任务累计'); setAction(undefined); load();
    } catch (error) { fail(error); }
  };
  const shortages = async () => { try { const rows = await api(`/production-orders/${id}/shortages`); rows.length ? Modal.warning({ title: '缺料明细', content: <ul>{rows.map((row: any) => <li key={row.materialId}>{row.itemCode} 缺少 {formatQuantity(row.shortageQty)}</li>)}</ul> }) : message.success('当前原材料总库存充足'); } catch (error) { fail(error); } };
  const cancel = () => Modal.confirm({ title: '确认取消生产任务？', content: '存在未退净领料或待审核业务时系统可能拒绝取消。', onOk: async () => { try { await api(`/production-orders/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason: '页面取消' }) }); message.success('任务已取消'); load(); } catch (error) { fail(error); } } });
  if (!data) return <PageScaffold title="生产任务详情"><span>加载中...</span></PageScaffold>;
  const canIssue = user.role === 'ADMIN' || user.permissions?.includes('production.issue');
  const canComplete = user.role === 'ADMIN' || user.permissions?.includes('production.complete');
  const canManage = user.role === 'ADMIN' || user.permissions?.includes('production.manage');
  const actionable = ['RELEASED', 'IN_PROGRESS'].includes(data.status);
  const warehouseType = action === 'complete' ? 'FG' : 'RAW';
  return <PageScaffold title="生产任务详情" subtitle="领料、退料和报产先生成待审核单据；待审核数量不计入实际累计。">
    <div className="toolbar"><Space><Button onClick={shortages}>缺料检查</Button></Space><Space wrap>
      {actionable && canIssue && <><Button type="primary" onClick={() => { setAction('issue'); form.resetFields(); form.setFieldsValue({ lines: [{}] }); }}>生产领料</Button><Button onClick={() => { setAction('return'); form.resetFields(); form.setFieldsValue({ lines: [{}] }); }}>生产退料</Button></>}
      {actionable && canComplete && <Button type="primary" onClick={() => { setAction('complete'); form.resetFields(); }}>完工报产</Button>}
      {['DRAFT', 'RELEASED', 'IN_PROGRESS'].includes(data.status) && canManage && <Button danger onClick={cancel}>取消任务</Button>}
    </Space></div>
    <Card><Descriptions column={{ xs: 1, md: 3 }} items={[
      { label: '任务单号', children: data.orderNo }, { label: '成品', children: `${data.finishedGoodCode} ${data.finishedGoodName}` },
      { label: '计划数量', children: formatQuantity(data.plannedQty) }, { label: '累计完工', children: formatQuantity(data.completedQty) },
      { label: '状态', children: <StatusTag value={data.status} /> }, { label: '计划日期', children: data.plannedDate || '-' },
    ]} /></Card>
    <Card title="BOM 快照与实际累计" style={{ marginTop: 16 }}><Table rowKey="materialId" pagination={false} dataSource={data.materials} columns={[
      { title: '物料', render: (_, r) => `${r.itemCode} ${r.name}` }, { title: '需求量', dataIndex: 'requiredQty', align: 'right', render: formatQuantity },
      { title: '累计领料', dataIndex: 'issuedQty', align: 'right', render: formatQuantity }, { title: '累计退料', dataIndex: 'returnedQty', align: 'right', render: formatQuantity },
      { title: '净领料', dataIndex: 'netIssuedQty', align: 'right', render: formatQuantity }, { title: 'RAW 总库存', dataIndex: 'rawOnHandQty', align: 'right', render: formatQuantity },
    ]} /></Card>
    <Card title="关联库存单据" style={{ marginTop: 16 }}><Table rowKey="id" pagination={false} dataSource={data.documents} columns={[
      { title: '单号', dataIndex: 'documentNo' }, { title: '类型', dataIndex: 'documentType', render: value => statusText[value] || value },
      { title: '状态', dataIndex: 'status', render: value => <StatusTag value={value} /> }, { title: '提交时间', dataIndex: 'submittedAt', render: formatBeijingTime },
      { title: '过账时间', dataIndex: 'postedAt', render: formatBeijingTime },
    ]} /></Card>
    <Modal width={760} title={action === 'issue' ? '生产领料' : action === 'return' ? '生产退料' : '完工报产'} open={!!action} onCancel={() => setAction(undefined)} onOk={() => form.submit()} destroyOnHidden>
      <Form form={form} layout="vertical" onFinish={submit}>
        <Form.Item label="仓库" name="warehouseId" rules={[{ required: true }]}><Select options={warehouses.filter(w => w.warehouseType === warehouseType).map(w => ({ value: w.id, label: `${w.warehouseCode} ${w.name}` }))} /></Form.Item>
        {action === 'complete' ? <>
          <Form.Item label="入库库位" name="locationId" rules={[{ required: true }]}><Select options={locations.filter(l => l.warehouseId === selectedWarehouse).map(l => ({ value: l.id, label: `${l.code} ${l.name}` }))} /></Form.Item>
          <Form.Item label="批次（可选）" name="batchId"><Select allowClear options={batches.filter(b => b.itemId === data.finishedGoodId).map(b => ({ value: b.id, label: b.batchNo }))} /></Form.Item>
          <Form.Item label="本次完工数量" name="quantity" rules={[{ required: true }]}><InputNumber min={1} max={Number(data.plannedQty) - Number(data.completedQty)} precision={0} style={{ width: '100%' }} /></Form.Item>
        </> : <Form.List name="lines">{(fields, { add, remove }) => <>{fields.map(field => <Card key={field.key} size="small" style={{ marginBottom: 10 }}>
          <Form.Item {...field} label="物料" name={[field.name, 'materialId']} rules={[{ required: true }]}><Select options={data.materials.map((m: any) => ({ value: m.materialId, label: `${m.itemCode} ${m.name}` }))} /></Form.Item>
          <Form.Item noStyle shouldUpdate>{({ getFieldValue }) => { const itemId = getFieldValue(['lines', field.name, 'materialId']); return <Space wrap align="start">
            <Form.Item {...field} label="库位" name={[field.name, 'locationId']} rules={[{ required: true }]}><Select style={{ width: 200 }} options={locations.filter(l => l.warehouseId === selectedWarehouse).map(l => ({ value: l.id, label: l.code }))} /></Form.Item>
            <Form.Item {...field} label="批次（可选）" name={[field.name, 'batchId']}><Select allowClear style={{ width: 180 }} options={batches.filter(b => b.itemId === itemId).map(b => ({ value: b.id, label: b.batchNo }))} /></Form.Item>
            <Form.Item {...field} label="数量" name={[field.name, 'quantity']} rules={[{ required: true }]}><InputNumber min={1} precision={0} /></Form.Item>
            {fields.length > 1 && <Button danger onClick={() => remove(field.name)}>删除行</Button>}
          </Space>; }}</Form.Item>
        </Card>)}<Button block type="dashed" onClick={() => add()}>增加明细</Button></>}</Form.List>}
        <Form.Item label="备注" name="notes"><Input.TextArea /></Form.Item>
      </Form>
    </Modal>
  </PageScaffold>;
}

export function RolesPage() {
  const [roles, setRoles] = useState<any[]>([]);
  const [permissions, setPermissions] = useState<any[]>([]);
  const [editing, setEditing] = useState<any>();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const load = () => Promise.all([api('/roles'), api('/permissions')]).then(([r, p]) => { setRoles(r); setPermissions(p); }).catch(fail);
  useEffect(() => { void load(); }, []);
  const save = async (values: any) => { try { await api(editing ? `/roles/${editing.id}` : '/roles', { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(values) }); message.success('角色已保存'); setOpen(false); load(); } catch (error) { fail(error); } };
  return <PageScaffold title="角色与权限" subtitle="权限码采用 resource.action；内置角色受保护，可调整名称、状态与权限集合。">
    <div className="toolbar"><span /><Button type="primary" onClick={() => { setEditing(undefined); form.resetFields(); setOpen(true); }}>新增角色</Button></div>
    <Table rowKey="id" dataSource={roles} columns={[{ title: '编码', dataIndex: 'code' }, { title: '名称', dataIndex: 'name' }, { title: '权限数', dataIndex: 'permissions', render: value => value?.length || 0 }, { title: '状态', dataIndex: 'status', render: value => <StatusTag value={value} /> }, { title: '操作', render: (_, record) => <Button type="link" onClick={() => { setEditing(record); form.setFieldsValue(record); setOpen(true); }}>编辑</Button> }]} />
    <Modal width={720} title={editing ? '编辑角色' : '新增角色'} open={open} onCancel={() => setOpen(false)} onOk={() => form.submit()}><Form form={form} layout="vertical" onFinish={save}><Form.Item label="编码" name="code" rules={[{ required: !editing }]}><Input disabled={!!editing} /></Form.Item><Form.Item label="名称" name="name" rules={[{ required: true }]}><Input /></Form.Item><Form.Item label="权限" name="permissions" rules={[{ required: true }]}><Checkbox.Group options={permissions.map(p => ({ value: p.code, label: `${p.name} (${p.code})` }))} /></Form.Item>{editing && <Form.Item label="启用" name="status" valuePropName="checked" getValueProps={value => ({ checked: value === 'ACTIVE' })} normalize={checked => checked ? 'ACTIVE' : 'INACTIVE'}><Switch /></Form.Item>}</Form></Modal>
  </PageScaffold>;
}

export function UsersV110Page() {
  const [data, setData] = useState<any>({ items: [] });
  const [roles, setRoles] = useState<any[]>([]);
  const [editing, setEditing] = useState<any>();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const load = () => Promise.all([api('/users?pageSize=100'), api('/roles')]).then(([users, roleRows]) => { setData(users); setRoles(roleRows); }).catch(fail);
  useEffect(() => { void load(); }, []);
  const save = async (values: any) => { try { await api(editing ? `/users/${editing.id}` : '/users', { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(values) }); message.success(editing ? '账号已更新' : '账号已创建'); setOpen(false); load(); } catch (error) { fail(error); } };
  const toggle = async (record: any) => { try { await api(`/users/${record.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: record.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }) }); message.success('账号状态已更新'); load(); } catch (error) { fail(error); } };
  const reset = (record: any) => {
    let password = '';
    Modal.confirm({ title: `重置 ${record.username} 的密码`, content: <Input.Password placeholder="至少 8 位新密码" onChange={event => { password = event.target.value; }} />, onOk: async () => {
      if (password.length < 8) { message.error('密码至少 8 位'); return Promise.reject(); }
      try { await api(`/users/${record.id}/reset-password`, { method: 'POST', body: JSON.stringify({ password }) }); message.success('密码已重置'); } catch (error) { fail(error); return Promise.reject(error); }
    } });
  };
  return <PageScaffold title="账号管理" subtitle="账号绑定动态角色；停用账号后，已签发 JWT 在下一次请求时立即失效。">
    <div className="toolbar"><span /><Button type="primary" onClick={() => { setEditing(undefined); form.resetFields(); setOpen(true); }}>新增账号</Button></div>
    <Table rowKey="id" dataSource={data.items} columns={[{ title: '账号', dataIndex: 'username' }, { title: '姓名', dataIndex: 'name' }, { title: '岗位', dataIndex: 'positionType' }, { title: '上级', dataIndex: 'managerName' }, { title: '角色', dataIndex: 'roleName' }, { title: '状态', dataIndex: 'status', render: value => <StatusTag value={value} /> }, { title: '操作', render: (_, record) => <Space><Button type="link" onClick={() => { setEditing(record); form.setFieldsValue(record); setOpen(true); }}>编辑</Button><Button type="link" onClick={() => toggle(record)}>{record.status === 'ACTIVE' ? '停用' : '启用'}</Button><Button type="link" onClick={() => reset(record)}>重置密码</Button></Space> }]} />
    <Modal title={editing ? '编辑账号' : '新增账号'} open={open} onCancel={() => setOpen(false)} onOk={() => form.submit()}><Form form={form} layout="vertical" onFinish={save}>
      <Form.Item label="账号" name="username" rules={[{ required: true }]}><Input disabled={!!editing} /></Form.Item>
      <Form.Item label="姓名" name="employeeName" rules={[{ required: true }]}><Input /></Form.Item>
      <Form.Item label="角色" name="roleId" rules={[{ required: true }]}><Select options={roles.filter(role => role.status === 'ACTIVE').map(role => ({ value: role.id, label: `${role.name} (${role.code})` }))} /></Form.Item>
      <Form.Item label="岗位" name="positionType" rules={[{ required: true }]}><Select options={[{value:'PRODUCTION',label:'生产人员'},{value:'WAREHOUSE_MANAGER',label:'仓库管理员'},{value:'MANAGER',label:'管理人员'},{value:'SYSTEM_ADMIN',label:'系统管理员'}]} /></Form.Item>
      <Form.Item label="部门" name="departmentName"><Input /></Form.Item>
      <Form.Item noStyle shouldUpdate={(prev, next) => prev.positionType !== next.positionType}>{({ getFieldValue }) => <Form.Item label="上级审批人" name="managerUserId" rules={[{ required: ['PRODUCTION','WAREHOUSE_MANAGER'].includes(getFieldValue('positionType')), message: '生产人员和仓库管理员必须绑定上级审批人' }]}><Select allowClear options={(data.items || []).filter((row:any) => row.id !== editing?.id && row.status === 'ACTIVE' && row.canApprove && ['MANAGER','SYSTEM_ADMIN'].includes(row.positionType)).map((row:any) => ({value:row.id,label:`${row.name}（${row.positionType || row.roleName}）`}))} /></Form.Item>}</Form.Item>
      <Form.Item label="具备审批权限" name="canApprove" valuePropName="checked"><Switch /></Form.Item>
      {!editing && <Form.Item label="初始密码" name="password" rules={[{ required: true }, { min: 8 }]}><Input.Password /></Form.Item>}
    </Form></Modal>
  </PageScaffold>;
}

export function AuditPage() {
  const [data, setData] = useState<any>({ items: [] });
  useEffect(() => { api('/audit/logs?pageSize=100').then(setData).catch(fail); }, []);
  return <PageScaffold title="操作日志" subtitle="查看用户、对象、结果、错误码、请求编号和应用版本；密码与 Token 不记录。"><Table rowKey="id" dataSource={data.items} columns={[{ title: '时间', dataIndex: 'createdAt', render: formatBeijingTime }, { title: '用户', dataIndex: 'username' }, { title: '操作', dataIndex: 'action' }, { title: '对象', render: (_, r) => `${r.entityType || '-'} / ${r.entityId || '-'}` }, { title: '结果', dataIndex: 'result' }, { title: '版本', dataIndex: 'appVersion' }]} /></PageScaffold>;
}

export function AboutPage() {
  const [version, setVersion] = useState<any>();
  useEffect(() => { api('/system/version').then(setVersion).catch(fail); }, []);
  return <PageScaffold title="关于系统" subtitle="构建信息由 CI 注入，版本号以根 package.json 为唯一来源。"><Card><Descriptions column={1} items={[
    { label: '系统版本', children: version?.version || '-' }, { label: '版本摘要', children: '完善数据维护与审批' },
    { label: '构建时间', children: version?.buildTime || '-' }, { label: 'Git Commit', children: version?.gitCommit || '-' }, { label: '运行环境', children: version?.environment || '-' },
  ]} /></Card></PageScaffold>;
}

// === V1.1.0 New Pages ===

export function MaterialArchivePage() {
  const [data, setData] = useState<any>({ items: [] });
  const [tab, setTab] = useState('ALL');
  const nav = useNavigate();
  const load = () => api('/materials?pageSize=100').then(setData).catch(fail);
  useEffect(() => { void load(); }, []);

  const filtered = tab === 'ALL' ? data.items
    : tab === 'MATERIAL' ? data.items.filter((i: any) => i.itemType === 'MATERIAL')
    : tab === 'FINISHED_GOOD' ? data.items.filter((i: any) => i.itemType === 'FINISHED_GOOD')
    : data.items.filter((i: any) => i.status === 'INACTIVE');

  return <PageScaffold title="物料档案" subtitle="统一管理原材料和成品。物料分类和计量单位通过弹窗维护。">
    <div className="toolbar"><div/>
      <Space>
        <Select defaultValue="ALL" style={{ width: 120 }} onChange={setTab}
          options={[{value:'ALL',label:'全部'},{value:'MATERIAL',label:'原材料'},{value:'FINISHED_GOOD',label:'成品'},{value:'INACTIVE',label:'已停用'}]} />
        <Button type="primary" icon={<PlusOutlined />} onClick={() => nav('/items')}>新增物料</Button>
      </Space>
    </div>
    <Table rowKey="id" dataSource={filtered} columns={[
      { title: '编码', dataIndex: 'itemCode' }, { title: '名称', dataIndex: 'name' },
      { title: '型号', dataIndex: 'model' }, { title: '规格', dataIndex: 'spec' },
      { title: '分类', dataIndex: 'categoryName' }, { title: '类型', dataIndex: 'itemType', render: (v: string) => v === 'MATERIAL' ? '原材料' : '成品' },
      { title: '单位', dataIndex: 'unitName' }, { title: '库存', dataIndex: 'onHandQty', align: 'right', render: formatQuantity },
      { title: '安全库存', dataIndex: 'minimumStock', align: 'right', render: formatQuantity },
      { title: '状态', dataIndex: 'status', render: (v: string) => <StatusTag value={v} /> },
      { title: '创建人', dataIndex: 'createdByName' },
      { title: '操作', render: (_: any, r: any) => <Space>
        <Button type="link" onClick={() => nav(`/items/${r.id}`)}>详情</Button>
      </Space> },
    ]} />
  </PageScaffold>;
}

export function WarehouseArchivePage() {
  const [warehouses, setWarehouses] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const load = () => Promise.all([api('/warehouses'),api('/users?pageSize=100')]).then(([rows,people])=>{setWarehouses(rows);setUsers(people.items||[]);}).catch(fail);
  useEffect(() => { void load(); }, []);
  const [editing, setEditing] = useState<any>();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const save = async (values: any) => { try { const row=await api(editing ? `/warehouses/${editing.id}` : '/warehouses', { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(values) }); const id=editing?.id||row.id; await api(`/warehouses/${id}/managers`,{method:'PUT',body:JSON.stringify({userIds:values.managerIds||[]})}); message.success('仓库已保存'); setOpen(false); load(); } catch (error) { fail(error); } };
  const remove = async (id: string) => { try { await api(`/warehouses/${id}`, { method: 'DELETE' }); message.success('仓库已删除'); load(); } catch (error) { fail(error); } };
  return <PageScaffold title="仓储档案" subtitle="管理仓库、库区、货架和库位。">
    <div className="toolbar"><span /><Button type="primary" onClick={() => { setEditing(undefined); form.resetFields(); form.setFieldsValue({ warehouseType: 'RAW' }); setOpen(true); }}>新增仓库</Button></div>
    <Table rowKey="id" dataSource={warehouses} columns={[
      { title: '编码', dataIndex: 'warehouseCode' }, { title: '名称', dataIndex: 'displayName' },
      { title: '类型', dataIndex: 'warehouseType', render: (v: string) => v === 'RAW' ? '原材料库' : v === 'FG' ? '成品库' : v },
      { title: '库区数', dataIndex: 'zoneCount' }, { title: '库位数', dataIndex: 'locationCount' },
      { title: '状态', dataIndex: 'status', render: (v: string) => <StatusTag value={v} /> },
      { title: '操作', render: (_, record) => <Space><Button type="link" onClick={() => { setEditing(record); form.setFieldsValue(record); setOpen(true); }}>编辑</Button><Popconfirm title="确认删除仓库？" onConfirm={() => remove(record.id)}><Button danger type="link">删除</Button></Popconfirm></Space> },
    ]} />
    <Modal title={editing ? '编辑仓库' : '新增仓库'} open={open} onCancel={() => setOpen(false)} onOk={() => form.submit()}>
      <Form form={form} layout="vertical" onFinish={save}>
        <Form.Item label="编码" name="warehouseCode" rules={[{ required: !editing }]}><Input disabled={!!editing} /></Form.Item>
        <Form.Item label="显示名" name="displayName" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item label="名称" name="name" rules={[{ required: true }]}><Input /></Form.Item>
        {!editing && <Form.Item label="类型" name="warehouseType" rules={[{ required: true }]}><Select options={[{ value: 'RAW', label: '原材料库' }, { value: 'FG', label: '成品库' }]} /></Form.Item>}
        {editing && <Form.Item label="状态" name="status"><Select options={[{ value: 'ACTIVE', label: '启用' }, { value: 'INACTIVE', label: '停用' }]} /></Form.Item>}
        <Form.Item label="仓库管理员" name="managerIds"><Select mode="multiple" options={users.filter(u=>u.positionType==='WAREHOUSE_MANAGER'&&u.status==='ACTIVE').map(u=>({value:u.id,label:`${u.name}（${u.username}）`}))} /></Form.Item>
      </Form>
    </Modal>
  </PageScaffold>;
}

export function StockDocumentsPage() {
  const [data, setData] = useState<any>({ items: [] });
  const [tab, setTab] = useState('ALL');
  const nav = useNavigate();
  const load = () => api(`/stock-documents?pageSize=100${tab !== 'ALL' ? `&documentType=${tab}` : ''}`).then(setData).catch(fail);
  useEffect(() => { void load(); }, [tab]);

  const tabs = [
    { value: 'ALL', label: '全部' }, { value: 'MATERIAL_INBOUND', label: '原材料入库' },
    { value: 'FINISHED_INBOUND', label: '成品入库' }, { value: 'FINISHED_OUTBOUND', label: '成品出库' },
    { value: 'INVENTORY_ADJUSTMENT', label: '库存调整' }, { value: 'PRODUCTION_ISSUE', label: '生产领料' },
    { value: 'PRODUCTION_RETURN', label: '生产退料' }, { value: 'STOCK_MOVE', label: '移库' },
  ];

  const action = (r: any, kind: string) => Modal.confirm({
    title: kind === 'submit' ? '确认提交审核？' : '确认冲销？',
    onOk: async () => {
      try {
        const endpoint = kind === 'submit' ? `/stock-documents/${r.id}/submit` : `/stock-documents/${r.id}/void`;
        await api(endpoint, { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey() }, body: kind === 'void' ? JSON.stringify({ reason: '页面冲销' }) : undefined });
        message.success('操作成功'); load();
      } catch (e) { fail(e); }
    },
  });

  return <PageScaffold title="库存单据" subtitle="统一管理所有库存业务单据。">
    <div className="toolbar">
      <Select defaultValue="ALL" style={{ width: 120 }} onChange={setTab} options={tabs} />
      {(['DRAFT','REJECTED'].includes(tab) || tab === 'ALL')}
    </div>
    <Table rowKey="id" dataSource={data.items} columns={[
      { title: '单号', dataIndex: 'documentNo' }, { title: '类型', dataIndex: 'documentType', render: (v: string) => statusText[v] || v },
      { title: '状态', dataIndex: 'status', render: (v: string) => <StatusTag value={v} /> },
      { title: '仓库', dataIndex: 'warehouseCode' }, { title: '创建时间', dataIndex: 'createdAt', render: formatBeijingTime },
      { title: '操作', render: (_: any, r: any) => <Space>
        <Button type="link" onClick={() => nav(`/stock-documents/${r.id}`)}>详情</Button>
        {r.status === 'DRAFT' && <Button type="link" onClick={() => action(r, 'submit')}>提交</Button>}
        {r.status === 'POSTED' && <Button danger type="link" onClick={() => action(r, 'void')}>冲销</Button>}
      </Space> },
    ]} />
  </PageScaffold>;
}

export function WarehouseVirtualPage() {
  const [warehouses, setWarehouses] = useState<any[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [overview, setOverview] = useState<any>(null);
  const [locations, setLocations] = useState<any[]>([]);
  const [detailLoc, setDetailLoc] = useState<any>(null);
  const loadWarehouses = () => api('/warehouses').then(setWarehouses).catch(fail);
  useEffect(() => { void loadWarehouses(); }, []);

  const [loading, setLoading] = useState(false);
  useEffect(() => { if (!selected) return; setLoading(true); setOverview(null); setLocations([]); Promise.all([ api(`/warehouses/${selected}/overview`), api(`/warehouses/${selected}/locations`) ]).then(([ov, locs]) => { setOverview(ov); setLocations(Array.isArray(locs) ? locs : []); }).catch(fail).finally(() => setLoading(false)); }, [selected]);

  const overviewTags = overview ? <Space><Tag>物料{overview.itemCategoryCount}类</Tag><Tag>库存{overview.totalStock}</Tag><Tag>库位{overview.usedLocations}/{overview.totalLocations}</Tag></Space> : null;

  return <PageScaffold title="虚拟仓库" subtitle="可视化查看仓库库位和库存分布。">
    <div className="toolbar">
      <Select placeholder="选择仓库" style={{ width: 200 }} value={selected || undefined}
        onChange={setSelected}
        options={warehouses.map((w: any) => ({ value: w.id, label: `${w.displayName || w.name} (${w.warehouseCode})` }))} />
      {loading && <Tag>加载中...</Tag>}
      {overviewTags}
    </div>
    {locations.length > 0 && <Table rowKey="id" dataSource={locations} columns={[
      { title: '库位编码', dataIndex: 'code' }, { title: '库位名称', dataIndex: 'name' },
      { title: '库区', dataIndex: 'zoneName' }, { title: '货架', dataIndex: 'rackName' },
      { title: '库存量', dataIndex: 'onHandQty', align: 'right', render: formatQuantity },
      { title: '冻结量', dataIndex: 'frozenQty', align: 'right', render: formatQuantity },
      { title: '品类数', dataIndex: 'itemCount', align: 'right' },
      { title: '状态', dataIndex: 'status', render: (v: string) => <StatusTag value={v} /> },
      { title: '操作', render: (_: any, r: any) => <Button type="link" onClick={() => setDetailLoc(r)}>详情</Button> },
    ]} />}
    <Drawer width={550} title="库位详情" open={!!detailLoc} onClose={() => setDetailLoc(null)}>
      {detailLoc && <Descriptions column={1} items={[
        { label: '库位编码', children: detailLoc.code }, { label: '库位名称', children: detailLoc.name },
        { label: '库区', children: detailLoc.zoneName }, { label: '货架', children: detailLoc.rackName || '-' },
        { label: '层', children: detailLoc.layer || '-' }, { label: '列', children: detailLoc.colPos || '-' },
        { label: '位置说明', children: detailLoc.positionDesc || '-' },
        { label: '库存量', children: formatQuantity(detailLoc.onHandQty) },
        { label: '冻结量', children: formatQuantity(detailLoc.frozenQty) },
        { label: '状态', children: <StatusTag value={detailLoc.status} /> },
      ]} />}
    </Drawer>
  </PageScaffold>;
}
