import { useEffect, useMemo, useState } from 'react';
import {
  Button, Card, DatePicker, Descriptions, Drawer, Empty, Input, Modal, Pagination, Select, Space, Spin, Table, Tabs, Tag, Typography, message,
} from 'antd';
import {
  DownloadOutlined, EyeOutlined, FileSearchOutlined, PrinterOutlined, ReloadOutlined, RollbackOutlined,
} from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { API_BASE, api, idempotencyKey, token } from './api';
import { formatBeijingTime, formatQuantity, statusText } from './domain';
import { selectDefaultInventoryWarehouse } from './inventory-report-model';
import { ResponsiveTable, useIsMobile } from './responsive';

type UserLike = { role: string; permissions?: string[] };
type TabKey = 'documents' | 'flows' | 'reports';

const safe = (value: any, fallback: any = '—'): any => value === undefined || value === null || value === '' ? fallback : value;
const dateTime = formatBeijingTime;
const can = (user: UserLike, permission: string) => user.role === 'ADMIN' || Boolean(user.permissions?.includes(permission));
const typeOptions = [
  'MATERIAL_INBOUND', 'FINISHED_INBOUND', 'FINISHED_OUTBOUND', 'INVENTORY_ADJUSTMENT', 'STOCK_MOVE', 'STOCK_CHECK',
  'PRODUCTION_ISSUE', 'PRODUCTION_RETURN', 'PRODUCTION_COMPLETION',
  'DEFECTIVE_RETURN', 'DEFECTIVE_REPAIR_RESTOCK', 'DEFECTIVE_PRODUCTION_RETURN', 'REVERSAL',
].map(value => ({ value, label: statusText[value] || value }));
const statusOptions = ['DRAFT', 'SUBMITTED', 'REJECTED', 'POSTED', 'VOIDED', 'CANCELLED']
  .map(value => ({ value, label: statusText[value] || value }));
const reportOptions = [
  ['current', '当前库存'], ['movement-summary', '出入库汇总'], ['item-ledger', '物料收发存'],
  ['warehouse-summary', '仓库库存统计'], ['low-stock', '低库存'], ['zero-stock', '零库存'],
  ['defective-stock', '不良品库存'], ['aging', '库龄与呆滞库存'], ['batch-stock', '批次库存'],
  ['production-materials', '生产领退料统计'],
].map(([value, label]) => ({ value, label }));

async function download(path: string, fallbackName: string) {
  const response = await fetch(`${API_BASE}${path}`, { headers: token() ? { Authorization: `Bearer ${token()}` } : {} });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || '导出失败');
  }
  const disposition = response.headers.get('content-disposition') || '';
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/)?.[1];
  const blob = await response.blob();
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = encoded ? decodeURIComponent(encoded) : fallbackName;
  link.click();
  URL.revokeObjectURL(link.href);
}

function Filters({ values, warehouses, onChange, onReset, flow = false }: any) {
  const rangeValue = (from?: string, to?: string) => from && to ? [dayjs(from), dayjs(to)] as any : null;
  const advancedFilters = flow ? <>
    <Input allowClear value={values.batchNo || ''} placeholder="批次号" onChange={event => onChange({ batchNo: event.target.value, page: 1 })} />
    <Input allowClear value={values.operator || ''} placeholder="操作人" onChange={event => onChange({ operator: event.target.value, page: 1 })} />
    <Input allowClear value={values.model || ''} placeholder="型号" onChange={event => onChange({ model: event.target.value, page: 1 })} />
    <Input allowClear value={values.parameter || ''} placeholder="规格/参数" onChange={event => onChange({ parameter: event.target.value, page: 1 })} />
    <DatePicker.RangePicker
      value={rangeValue(values.dateFrom, values.dateTo)}
      onChange={dates => onChange({ dateFrom: dates?.[0]?.format('YYYY-MM-DD'), dateTo: dates?.[1]?.format('YYYY-MM-DD'), page: 1 })}
      placeholder={['流水开始日期', '流水结束日期']}
    />
  </> : <>
    <Input allowClear value={values.createdByKeyword || ''} placeholder="创建人" onChange={event => onChange({ createdByKeyword: event.target.value, page: 1 })} />
    <DatePicker.RangePicker
      value={rangeValue(values.createdFrom, values.createdTo)}
      onChange={dates => onChange({ createdFrom: dates?.[0]?.format('YYYY-MM-DD'), createdTo: dates?.[1]?.format('YYYY-MM-DD'), page: 1 })}
      placeholder={['创建开始日期', '创建结束日期']}
    />
    <DatePicker.RangePicker
      value={rangeValue(values.postedFrom, values.postedTo)}
      onChange={dates => onChange({ postedFrom: dates?.[0]?.format('YYYY-MM-DD'), postedTo: dates?.[1]?.format('YYYY-MM-DD'), page: 1 })}
      placeholder={['过账开始日期', '过账结束日期']}
    />
  </>;
  return <div className="inventory-filter-bar">
    {advancedFilters}
    <Input allowClear value={values.keyword || ''} placeholder={flow ? '流水号 / 单号 / 物料' : '单号 / 生产任务 / 备注'} onChange={event => onChange({ keyword: event.target.value, page: 1 })} />
    {!flow && <Select allowClear value={values.documentType} placeholder="业务类型" options={[...typeOptions, { value: 'DEFECTIVE_INBOUND', label: '不良品入库' }]} onChange={value => onChange({ documentType: value, page: 1 })} />}
    {!flow && <Select allowClear value={values.status} placeholder="单据状态" options={statusOptions} onChange={value => onChange({ status: value, page: 1 })} />}
    {flow && <Select allowClear value={values.documentType} placeholder="业务类型" options={typeOptions} onChange={value => onChange({ documentType: value, page: 1 })} />}
    <Select allowClear showSearch optionFilterProp="label" value={values.warehouseId} placeholder="仓库" options={warehouses.map((w: any) => ({ value: w.id, label: `${safe(w.warehouseCode, '未编码')} ${safe(w.name, '未命名仓库')}` }))} onChange={value => onChange({ warehouseId: value, page: 1 })} />
    <Button onClick={onReset}>重置</Button>
  </div>;
}

function DocumentDetail({ detail, open, mobile, onClose, onAction, onEdit, user }: any) {
  const actionButtons = [];
  if (['DRAFT', 'REJECTED'].includes(detail?.status) && can(user, 'stock.edit')) actionButtons.push(<Button key="edit" onClick={onEdit}>编辑</Button>);
  if (detail?.status === 'DRAFT') {
    if (can(user, 'stock.submit')) actionButtons.push(<Button key="submit" type="primary" onClick={() => onAction('submit')}>提交审核</Button>);
    if (can(user, 'stock.edit')) actionButtons.push(<Button key="cancel" danger onClick={() => onAction('cancel')}>取消单据</Button>);
  }
  if (detail?.status === 'SUBMITTED') actionButtons.push(
    can(user, 'stock.withdraw') && <Button key="withdraw" onClick={() => onAction('withdraw')}>撤回</Button>,
  );
  if (detail?.status === 'REJECTED') {
    if (can(user, 'stock.submit')) actionButtons.push(<Button key="resubmit" type="primary" onClick={() => onAction('submit')}>重新提交</Button>);
    if (can(user, 'stock.edit')) actionButtons.push(<Button key="cancel" danger onClick={() => onAction('cancel')}>取消单据</Button>);
  }
  if (detail?.status === 'POSTED' && detail?.documentType !== 'REVERSAL' && can(user, 'stock.void')) actionButtons.push(
    <Button key="void" danger icon={<RollbackOutlined />} onClick={() => onAction('void')}>冲销</Button>,
  );
  return <Drawer
    rootClassName="document-print-drawer"
    title={`库存单据详情 · ${safe(detail?.documentNo, '未生成单号')}`}
    width={mobile ? '100%' : 820}
    open={open}
    onClose={onClose}
    footer={<Space wrap style={{ display: 'flex', justifyContent: 'flex-end' }}><Button icon={<PrinterOutlined/>} onClick={()=>window.print()}>打印</Button><Button onClick={onClose}>关闭</Button>{actionButtons}</Space>}
  >
    {detail ? <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div className="document-print-header"><Typography.Title level={3}>库存单据</Typography.Title><span>{statusText[detail.status]||detail.status}</span></div>
      <Descriptions bordered size="small" column={mobile ? 1 : 2}>
        <Descriptions.Item label="业务类型">{statusText[detail.documentType] || safe(detail.documentType)}</Descriptions.Item>
        <Descriptions.Item label="状态"><Tag>{statusText[detail.status] || safe(detail.status)}</Tag></Descriptions.Item>
        <Descriptions.Item label="仓库">{safe(detail.warehouseCode, '未编码')} {safe(detail.warehouseName, '未命名仓库')}</Descriptions.Item>
        <Descriptions.Item label="来源业务">{safe(detail.sourceBusiness)}</Descriptions.Item>
        <Descriptions.Item label="来源单号">{safe(detail.sourceDocumentNo)}</Descriptions.Item>
        <Descriptions.Item label="创建人">{safe(detail.createdByName, '未知人员')}</Descriptions.Item>
        <Descriptions.Item label="创建时间">{dateTime(detail.createdAt)}</Descriptions.Item>
        <Descriptions.Item label="提交人">{safe(detail.submittedByName)}</Descriptions.Item>
        <Descriptions.Item label="提交时间">{dateTime(detail.submittedAt)}</Descriptions.Item>
        <Descriptions.Item label="审核人">{safe(detail.approvedByName)}</Descriptions.Item>
        <Descriptions.Item label="审核时间">{dateTime(detail.approvedAt)}</Descriptions.Item>
        <Descriptions.Item label="过账人">{safe(detail.postedByName)}</Descriptions.Item>
        <Descriptions.Item label="过账时间">{dateTime(detail.postedAt)}</Descriptions.Item>
        {detail.voidedAt && <Descriptions.Item label="冲销人">{safe(detail.voidedByName)}</Descriptions.Item>}
        {detail.voidedAt && <Descriptions.Item label="冲销时间">{dateTime(detail.voidedAt)}</Descriptions.Item>}
        <Descriptions.Item label="备注" span={2}>{safe(detail.notes, '无')}</Descriptions.Item>
      </Descriptions>
      <Table size="small" rowKey="id" pagination={false} scroll={{ x: 900 }} dataSource={detail.lines || []} columns={[
        { title: '物料', render: (_: any, row: any) => `${safe(row.itemCode, '未编码')} ${safe(row.itemName, '未命名物料')}` },
        { title: '型号/规格', render: (_: any, row: any) => `${safe(row.model)} / ${safe(row.spec)}` },
        { title: '来源位置', render: (_: any, row: any) => `${safe(row.sourceWarehouseCode, detail.warehouseCode)} / ${safe(row.sourceZoneCode)} / ${safe(row.locationCode)}` },
        { title: '目标位置', render: (_: any, row: any) => row.targetWarehouseCode ? `${row.targetWarehouseCode} / ${safe(row.targetZoneCode)} / ${safe(row.targetLocationCode)}` : '—' },
        { title: '批次', dataIndex: 'batchNo', render: safe },
        { title: '数量', align: 'right' as const, render: (_: any, row: any) => `${formatQuantity(row.quantity)} ${safe(row.unit, '')}` },
      ]} />
      {detail.documentType==='STOCK_CHECK'&&<Card size="small" title="盘点明细"><Table size="small" rowKey="id" pagination={false} dataSource={detail.stockCheckLines||[]} columns={[
        {title:'物料',render:(_:any,row:any)=>`${safe(row.itemCode)} ${safe(row.itemName)}`},{title:'库位',render:(_:any,row:any)=>`${safe(row.zoneCode)} / ${safe(row.locationCode)}`},{title:'批次',dataIndex:'batchNo',render:safe},{title:'账面数',dataIndex:'systemQtySnapshot',render:(v:any)=>v===null?'提交时生成':formatQuantity(v)},{title:'实盘数',dataIndex:'countedQty',render:formatQuantity},{title:'差异',dataIndex:'differenceQty',render:(v:any)=>v===null?'—':formatQuantity(v)},{title:'单位',dataIndex:'unit'}
      ]}/></Card>}
      {detail.receiptAllocations?.length>0&&<Card size="small" title="审核入库分配"><Table size="small" rowKey={(row:any)=>`${row.documentLineId}-${row.disposition}-${row.locationId}`} pagination={false} dataSource={detail.receiptAllocations} columns={[
        {title:'类别',dataIndex:'disposition',render:(value:string)=>value==='NORMAL'?'正常品':'不良品'},
        {title:'仓库 / 库位',render:(_:any,row:any)=>`${safe(row.warehouseCode)} / ${safe(row.locationCode)}`},
        {title:'数量',dataIndex:'quantity',render:formatQuantity},{title:'不良原因',dataIndex:'defectReason',render:safe},
      ]}/></Card>}
      <Card size="small" title="操作记录">
        <Table size="small" rowKey={(row: any) => `${row.action}-${row.createdAt}`} pagination={false} dataSource={detail.operationRecords || []} columns={[
          { title: '时间', dataIndex: 'createdAt', render: dateTime },
          { title: '操作人', dataIndex: 'actorName', render: (value: any) => safe(value, '未知人员') },
          { title: '操作', dataIndex: 'description', render: safe },
          { title: '结果', dataIndex: 'result', render: safe },
        ]} />
      </Card>
      <Card size="small" title="关联流水">
        <Table size="small" rowKey="id" pagination={false} dataSource={detail.transactions || []} columns={[
          { title: '时间', dataIndex: 'createdAt', render: dateTime },
          { title: '物料', render: (_: any, row: any) => `${safe(row.itemCode)} ${safe(row.itemName)}` },
          { title: '仓库/库位', render: (_: any, row: any) => `${safe(row.warehouseCode)} / ${safe(row.locationCode)}` },
          { title: '变动', dataIndex: 'deltaQty', align: 'right' as const, render: (value: any) => <span className={Number(value) >= 0 ? 'qty-in' : 'qty-out'}>{Number(value) >= 0 ? '+' : ''}{formatQuantity(value)}</span> },
        ]} />
      </Card>
      <div className="document-print-signatures"><span>制单：{safe(detail.createdByName)}</span><span>审核：{safe(detail.approvedByName)}</span><span>仓库签字：_______________</span></div>
    </Space> : <Empty description="暂无单据详情" />}
  </Drawer>;
}

function DocumentsTab({ user, params, updateParams, warehouses }: any) {
  const mobile = useIsMobile();
  const navigate = useNavigate();
  const [data, setData] = useState<any>({ items: [], total: 0 });
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<any>();
  const documentId = params.get('documentId');
  const values = Object.fromEntries(params.entries());
  const load = async () => {
    setLoading(true);
    try {
      const query = new URLSearchParams();
      [
        'keyword', 'documentType', 'status', 'warehouseId', 'createdByKeyword',
        'createdFrom', 'createdTo', 'postedFrom', 'postedTo',
        'page', 'pageSize', 'sortField', 'sortOrder',
      ].forEach(key => values[key] && query.set(key, values[key]));
      const result = await api(`/stock-documents?${query}`);
      setData(result || { items: [], total: 0 });
    } catch (error: any) { message.error(error.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [params.toString()]);
  useEffect(() => {
    if (!documentId) { setDetail(undefined); return; }
    api(`/stock-documents/${documentId}`).then(setDetail).catch((error: any) => message.error(error.message));
  }, [documentId]);
  const perform = async (action: string) => {
    if (!detail) return;
    const confirmed = await new Promise<boolean>(resolve => Modal.confirm({
      title: `确认${({ submit: '提交', withdraw: '撤回', cancel: '取消', void: '冲销' } as any)[action] || '执行'}该单据？`,
      onOk: () => resolve(true), onCancel: () => resolve(false),
    }));
    if (!confirmed) return;
    try {
      const headers = action === 'void' ? { 'Idempotency-Key': idempotencyKey() } : undefined;
      const body = action === 'void' ? { reason: '库存管理页发起冲销' } : {};
      await api(`/stock-documents/${detail.id}/${action}`, { method: 'POST', headers, body: JSON.stringify(body) });
      message.success('操作成功');
      await Promise.all([load(), api(`/stock-documents/${detail.id}`).then(setDetail)]);
      window.dispatchEvent(new Event('inventory:refresh'));
    } catch (error: any) { message.error(error.message); }
  };
  const columns: any[] = [
    { title: '单据编号', dataIndex: 'documentNo', sorter: true, render: (value: any, row: any) => <Button type="link" onClick={() => updateParams({ documentId: row.id })}>{safe(value, '未生成单号')}</Button> },
    { title: '业务类型', dataIndex: 'documentType', render: (value: any) => statusText[value] || safe(value) },
    { title: '状态', dataIndex: 'status', render: (value: any) => <Tag color={value === 'POSTED' ? 'green' : value === 'SUBMITTED' ? 'blue' : value === 'REJECTED' ? 'red' : 'default'}>{statusText[value] || safe(value)}</Tag> },
    { title: '仓库', render: (_: any, row: any) => `${safe(row.warehouseCode, '未编码')} ${safe(row.warehouseName, '未命名仓库')}` },
    { title: '来源业务', dataIndex: 'sourceBusiness', render: safe },
    { title: '创建人', dataIndex: 'createdByName', render: (value: any) => safe(value, '未知人员') },
    { title: '创建时间', dataIndex: 'createdAt', sorter: true, render: dateTime },
    { title: '过账时间', dataIndex: 'postedAt', sorter: true, render: dateTime },
    { title: '操作', fixed: 'right', render: (_: any, row: any) => <Button size="small" icon={<EyeOutlined />} onClick={() => updateParams({ documentId: row.id })}>详情</Button> },
  ];
  const edit = () => {
    if (!detail) return;
    if (detail.productionOrderId) {
      navigate(`/production/tasks/${detail.productionOrderId}?documentId=${detail.id}`);
      return;
    }
    const path: Record<string, string> = {
      MATERIAL_INBOUND: '/inbound', FINISHED_INBOUND: '/finished-inbound', FINISHED_OUTBOUND: '/outbound',
      INVENTORY_ADJUSTMENT: '/adjustments', STOCK_MOVE: '/moves',
    };
    navigate(`${path[detail.documentType] || '/inventory/management'}?documentId=${detail.id}`);
  };
  return <Card className="inventory-tab-card">
    <div className="inventory-tab-toolbar">
      <Filters values={values} warehouses={warehouses} onChange={updateParams} onReset={() => updateParams({
        keyword: undefined, documentType: undefined, status: undefined, warehouseId: undefined,
        createdByKeyword: undefined, createdFrom: undefined, createdTo: undefined,
        postedFrom: undefined, postedTo: undefined, page: 1,
      })} />
      <Button icon={<DownloadOutlined />} onClick={() => download(`/stock-documents/export?${params}`, '库存单据.csv').catch(error => message.error(error.message))}>导出</Button>
    </div>
    <Table rowKey="id" loading={loading} columns={columns} dataSource={data.items || []} scroll={{ x: 1200 }} onChange={(pagination, _filters, sorter: any) => updateParams({ page: pagination.current, sortField: sorter.field, sortOrder: sorter.order === 'ascend' ? 'ASC' : 'DESC' })} pagination={{ current: Number(values.page || 1), pageSize: 20, total: data.total || 0, showTotal: total => `共 ${total} 条` }} />
    <DocumentDetail detail={detail} open={Boolean(documentId)} mobile={mobile} onClose={() => updateParams({ documentId: undefined })} onAction={perform} onEdit={edit} user={user} />
  </Card>;
}

function FlowsTab({ params, updateParams, warehouses }: any) {
  const mobile = useIsMobile();
  const [data, setData] = useState<any>({ items: [], total: 0 });
  const [detail, setDetail] = useState<any>();
  const [loading, setLoading] = useState(false);
  const values = Object.fromEntries(params.entries());
  const flowId = params.get('flowId');
  const load = async () => {
    setLoading(true);
    try {
      const query = new URLSearchParams();
      [
        'keyword', 'documentType', 'warehouseId', 'batchNo', 'operator',
        'model', 'parameter', 'dateFrom', 'dateTo', 'page', 'pageSize',
      ].forEach(key => values[key] && query.set(key, values[key]));
      setData(await api(`/inventory/transactions?${query}`));
    } catch (error: any) { message.error(error.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [params.toString()]);
  useEffect(() => { if (flowId) api(`/inventory/transactions/${flowId}`).then(setDetail).catch((error: any) => message.error(error.message)); else setDetail(undefined); }, [flowId]);
  return <Card className="inventory-tab-card">
    <Filters flow values={values} warehouses={warehouses} onChange={updateParams} onReset={() => updateParams({
      keyword: undefined, documentType: undefined, warehouseId: undefined, batchNo: undefined,
      operator: undefined, model: undefined, parameter: undefined, dateFrom: undefined, dateTo: undefined, page: 1,
    })} />
    <Table rowKey="id" loading={loading} dataSource={data.items || []} scroll={{ x: 1250 }} columns={[
      { title: '流水号', dataIndex: 'transactionNo', render: (value: any, row: any) => <Button type="link" onClick={() => updateParams({ flowId: row.id })}>{safe(value)}</Button> },
      { title: '时间', dataIndex: 'createdAt', render: dateTime },
      { title: '单据', render: (_: any, row: any) => <Button type="link" onClick={() => updateParams({ tab: 'documents', documentId: row.documentId, flowId: undefined })}>{safe(row.documentNo)}</Button> },
      { title: '业务类型', dataIndex: 'documentType', render: (value: any) => statusText[value] || safe(value) },
      { title: '仓库/库位', render: (_: any, row: any) => `${safe(row.warehouseCode)} / ${safe(row.zoneCode)} / ${safe(row.locationCode)}` },
      { title: '物料', render: (_: any, row: any) => `${safe(row.itemCode)} ${safe(row.itemName)}` },
      { title: '批次', dataIndex: 'batchNo', render: safe },
      { title: '变动量', dataIndex: 'deltaQty', align: 'right', render: (value: any, row: any) => <span className={Number(value) >= 0 ? 'qty-in' : 'qty-out'}>{Number(value) >= 0 ? '+' : ''}{formatQuantity(value)} {safe(row.unit, '')}</span> },
      { title: '结余', dataIndex: 'balanceAfter', align: 'right', render: formatQuantity },
      { title: '操作人', dataIndex: 'operator', render: (value: any) => safe(value, '未知人员') },
    ]} pagination={{ current: Number(values.page || 1), pageSize: 20, total: data.total || 0, showTotal: total => `共 ${total} 条`, onChange: page => updateParams({ page }) }} />
    <Drawer title={`库存流水详情 · ${safe(detail?.transactionNo)}`} width={mobile ? '100%' : 680} open={Boolean(flowId)} onClose={() => updateParams({ flowId: undefined })}>
      {detail && <Descriptions bordered size="small" column={mobile ? 1 : 2}>
        <Descriptions.Item label="发生时间">{dateTime(detail.createdAt)}</Descriptions.Item>
        <Descriptions.Item label="操作人">{safe(detail.operator, '未知人员')}</Descriptions.Item>
        <Descriptions.Item label="来源单据"><Button type="link" onClick={() => updateParams({ tab: 'documents', documentId: detail.documentId, flowId: undefined })}>{safe(detail.documentNo)}</Button></Descriptions.Item>
        <Descriptions.Item label="业务类型">{statusText[detail.documentType] || safe(detail.documentType)}</Descriptions.Item>
        <Descriptions.Item label="仓库/库位" span={2}>{safe(detail.warehouseCode)} / {safe(detail.zoneCode)} / {safe(detail.locationCode)}</Descriptions.Item>
        <Descriptions.Item label="物料" span={2}>{safe(detail.itemCode)} {safe(detail.itemName)} · {safe(detail.model)} / {safe(detail.spec)}</Descriptions.Item>
        <Descriptions.Item label="批次">{safe(detail.batchNo)}</Descriptions.Item>
        <Descriptions.Item label="变动数量">{formatQuantity(detail.deltaQty)} {safe(detail.unit, '')}</Descriptions.Item>
        <Descriptions.Item label="变动前">{formatQuantity(detail.balanceBefore)}</Descriptions.Item>
        <Descriptions.Item label="变动后">{formatQuantity(detail.balanceAfter)}</Descriptions.Item>
      </Descriptions>}
    </Drawer>
  </Card>;
}

function CurrentInventoryDetail({ itemId, warehouseId, open, mobile, onClose, onDocument }: any) {
  const [summary, setSummary] = useState<any>();
  const [distribution, setDistribution] = useState<any>({ items: [], total: 0 });
  const [ledger, setLedger] = useState<any>({ items: [], total: 0 });
  const [activeTab, setActiveTab] = useState('distribution');
  const [distributionPage, setDistributionPage] = useState(1);
  const [ledgerPage, setLedgerPage] = useState(1);
  const [ledgerFilters, setLedgerFilters] = useState<any>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !itemId || !warehouseId) return;
    setActiveTab('distribution');
    setDistributionPage(1);
    setLedgerPage(1);
    setLedgerFilters({});
    setSummary(undefined);
    api(`/inventory/reports/current?warehouseId=${warehouseId}&itemId=${itemId}&page=1&pageSize=1`)
      .then(result => setSummary(result?.items?.[0]))
      .catch((error: any) => message.error(error.message));
  }, [open, itemId, warehouseId]);

  useEffect(() => {
    if (!open || !itemId || !warehouseId || activeTab !== 'distribution') return;
    setLoading(true);
    api(`/inventory/balances?warehouseId=${warehouseId}&itemId=${itemId}&page=${distributionPage}&pageSize=20`)
      .then(result => setDistribution(result || { items: [], total: 0 }))
      .catch((error: any) => message.error(error.message))
      .finally(() => setLoading(false));
  }, [open, itemId, warehouseId, activeTab, distributionPage]);

  useEffect(() => {
    if (!open || !itemId || !warehouseId || !['inbound', 'outbound'].includes(activeTab)) return;
    const query = new URLSearchParams({
      warehouseId,
      itemId,
      direction: activeTab === 'inbound' ? 'IN' : 'OUT',
      page: String(ledgerPage),
      pageSize: '20',
    });
    ['keyword', 'documentType', 'dateFrom', 'dateTo'].forEach(key => ledgerFilters[key] && query.set(key, ledgerFilters[key]));
    setLoading(true);
    api(`/inventory/transactions?${query}`)
      .then(result => setLedger(result || { items: [], total: 0 }))
      .catch((error: any) => message.error(error.message))
      .finally(() => setLoading(false));
  }, [open, itemId, warehouseId, activeTab, ledgerPage, JSON.stringify(ledgerFilters)]);

  const distributionColumns = [
    { title: '库区', render: (_: any, row: any) => `${safe(row.zoneCode, '未命名库区')} ${safe(row.zoneName, '')}` },
    { title: '库位', render: (_: any, row: any) => `${safe(row.locationCode, '未命名库位')} ${safe(row.locationName, '')}` },
    { title: '批次', dataIndex: 'batchNo', render: safe },
    { title: '当前库存', dataIndex: 'onHandQty', align: 'right' as const, render: formatQuantity },
    { title: '可用库存', dataIndex: 'availableQty', align: 'right' as const, render: formatQuantity },
    { title: '冻结库存', dataIndex: 'frozenQty', align: 'right' as const, render: formatQuantity },
    { title: '预占库存', dataIndex: 'reservedQty', align: 'right' as const, render: formatQuantity },
    { title: '更新时间', dataIndex: 'updatedAt', render: dateTime },
  ];
  const ledgerColumns = [
    { title: '发生时间', dataIndex: 'createdAt', render: dateTime },
    { title: '来源单据', render: (_: any, row: any) => <Button type="link" onClick={() => onDocument(row.documentId)}>{safe(row.documentNo, '未生成单号')}</Button> },
    { title: '业务类型', dataIndex: 'documentType', render: (value: any) => statusText[value] || safe(value) },
    { title: '库区/库位', render: (_: any, row: any) => `${safe(row.zoneCode, '未命名库区')} / ${safe(row.locationCode, '未命名库位')}` },
    { title: '批次', dataIndex: 'batchNo', render: safe },
    { title: '变动数量', dataIndex: 'deltaQty', align: 'right' as const, render: (value: any, row: any) => <span className={Number(value) >= 0 ? 'qty-in' : 'qty-out'}>{Number(value) >= 0 ? '+' : ''}{formatQuantity(value)} {safe(row.unit, '')}</span> },
    { title: '变动后结余', dataIndex: 'balanceAfter', align: 'right' as const, render: formatQuantity },
    { title: '操作人', dataIndex: 'operator', render: (value: any) => safe(value, '未知人员') },
  ];
  const ledgerView = <Space direction="vertical" size={12} style={{ width: '100%' }}>
    <div className="inventory-detail-filters">
      <Input allowClear value={ledgerFilters.keyword || ''} placeholder="单号或物料关键字" onChange={event => { setLedgerPage(1); setLedgerFilters((value: any) => ({ ...value, keyword: event.target.value })); }} />
      <Select allowClear value={ledgerFilters.documentType} placeholder="业务类型" options={typeOptions} onChange={value => { setLedgerPage(1); setLedgerFilters((current: any) => ({ ...current, documentType: value })); }} />
      <DatePicker.RangePicker
        value={ledgerFilters.dateFrom && ledgerFilters.dateTo ? [dayjs(ledgerFilters.dateFrom), dayjs(ledgerFilters.dateTo)] : null}
        onChange={dates => { setLedgerPage(1); setLedgerFilters((value: any) => ({ ...value, dateFrom: dates?.[0]?.format('YYYY-MM-DD'), dateTo: dates?.[1]?.format('YYYY-MM-DD') })); }}
        placeholder={['开始日期', '结束日期']}
      />
      <Button onClick={() => { setLedgerPage(1); setLedgerFilters({}); }}>重置</Button>
    </div>
    <ResponsiveTable mobile={mobile} rowKey="id" loading={loading} pagination={false} dataSource={ledger.items || []} columns={ledgerColumns} scroll={{ x: 1050 }} />
    {ledger.total > 20 && <Pagination current={ledgerPage} pageSize={20} total={ledger.total} showSizeChanger={false} showTotal={total => `共 ${total} 条`} onChange={setLedgerPage} />}
  </Space>;

  return <Drawer
    title={`${safe(summary?.warehouseCode, '未命名仓库')} · ${safe(summary?.itemCode, '未编码物料')} ${safe(summary?.itemName, '未命名物料')}`}
    width={mobile ? '100%' : 920}
    open={open}
    onClose={onClose}
  >
    {!summary ? <div className="page-loading"><Spin /></div> : <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Descriptions bordered size="small" column={mobile ? 1 : 3}>
        <Descriptions.Item label="仓库">{safe(summary.warehouseCode, '未命名仓库')} {safe(summary.warehouseName, '')}</Descriptions.Item>
        <Descriptions.Item label="物料">{safe(summary.itemCode, '未编码物料')} {safe(summary.itemName, '未命名物料')}</Descriptions.Item>
        <Descriptions.Item label="单位">{safe(summary.unit, '无单位')}</Descriptions.Item>
        <Descriptions.Item label="型号">{safe(summary.model)}</Descriptions.Item>
        <Descriptions.Item label="规格">{safe(summary.spec)}</Descriptions.Item>
        <Descriptions.Item label="库存状态"><Tag color={summary.riskStatus === 'ZERO' ? 'default' : summary.riskStatus === 'LOW' ? 'orange' : 'green'}>{summary.riskStatus === 'ZERO' ? '零库存' : summary.riskStatus === 'LOW' ? '低库存' : '正常库存'}</Tag></Descriptions.Item>
      </Descriptions>
      <div className="inventory-detail-summary">
        {[
          ['当前库存', summary.onHandQty], ['可用库存', summary.availableQty], ['冻结库存', summary.frozenQty],
          ['预占库存', summary.reservedQty], ['安全库存', summary.minimumStock], ['库存记录', summary.inventoryRecordCount],
        ].map(([label, value]) => <div key={label}><span>{label}</span><strong>{label === '库存记录' ? safe(value, 0) : formatQuantity(value)}</strong></div>)}
      </div>
      <Tabs activeKey={activeTab} onChange={value => { setActiveTab(value); setLedgerPage(1); }} items={[
        {
          key: 'distribution', label: `库存分布（${safe(summary.inventoryRecordCount, 0)}）`,
          children: <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <ResponsiveTable mobile={mobile} rowKey="id" loading={loading} pagination={false} dataSource={distribution.items || []} columns={distributionColumns} scroll={{ x: 1000 }} />
            {distribution.total > 20 && <Pagination current={distributionPage} pageSize={20} total={distribution.total} showSizeChanger={false} showTotal={total => `共 ${total} 条`} onChange={setDistributionPage} />}
          </Space>,
        },
        { key: 'inbound', label: '入库流水', children: ledgerView },
        { key: 'outbound', label: '出库流水', children: ledgerView },
      ]} />
    </Space>}
  </Drawer>;
}

function ReportsTab({ params, updateParams, warehouses }: any) {
  const mobile = useIsMobile();
  const values = Object.fromEntries(params.entries());
  const reportType = values.reportType || 'current';
  const detailItemId = values.itemId;
  const [data, setData] = useState<any>({ items: [], total: 0, summary: { unitTotals: [] } });
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (reportType !== 'current' || values.warehouseId || !warehouses.length) return;
    const selected = selectDefaultInventoryWarehouse(warehouses);
    if (selected) updateParams({ warehouseId: selected.id, page: 1 });
  }, [reportType, values.warehouseId, warehouses]);
  const load = async () => {
    if (reportType === 'current' && !values.warehouseId) {
      setData({ items: [], total: 0, summary: { unitTotals: [] } });
      return;
    }
    setLoading(true);
    try {
      const query = new URLSearchParams();
      ['keyword', 'warehouseId', 'dateFrom', 'dateTo', 'page', 'pageSize'].forEach(key => values[key] && query.set(key, values[key]));
      setData(await api(`/inventory/reports/${reportType}?${query}`));
    } catch (error: any) { message.error(error.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [params.toString()]);
  const columns = useMemo(() => {
    if (reportType === 'current') return [
      { title: '物料编码', dataIndex: 'itemCode', render: (value: any, row: any) => <Button type="link" onClick={() => updateParams({ itemId: row.itemId })}>{safe(value, '未编码物料')}</Button> },
      { title: '物料名称', dataIndex: 'itemName', render: (value: any) => safe(value, '未命名物料') },
      { title: '型号', dataIndex: 'model', render: safe },
      { title: '规格', dataIndex: 'spec', render: safe },
      { title: '单位', dataIndex: 'unit', render: (value: any) => safe(value, '无单位') },
      { title: '当前库存', dataIndex: 'onHandQty', align: 'right' as const, render: formatQuantity },
      { title: '可用库存', dataIndex: 'availableQty', align: 'right' as const, render: formatQuantity },
      { title: '冻结库存', dataIndex: 'frozenQty', align: 'right' as const, render: formatQuantity },
      { title: '预占库存', dataIndex: 'reservedQty', align: 'right' as const, render: formatQuantity },
      { title: '安全库存', dataIndex: 'minimumStock', align: 'right' as const, render: formatQuantity },
      { title: '库位数', dataIndex: 'locationCount', align: 'right' as const, render: (value: any) => safe(value, 0) },
      { title: '批次数', dataIndex: 'batchCount', align: 'right' as const, render: (value: any) => safe(value, 0) },
      { title: '库存记录', dataIndex: 'inventoryRecordCount', align: 'right' as const, render: (value: any) => safe(value, 0) },
      { title: '库存状态', dataIndex: 'riskStatus', render: (value: any) => <Tag color={value === 'ZERO' ? 'default' : value === 'LOW' ? 'orange' : 'green'}>{value === 'ZERO' ? '零库存' : value === 'LOW' ? '低库存' : '正常库存'}</Tag> },
      { title: '更新时间', dataIndex: 'updatedAt', render: dateTime },
      { title: '操作', fixed: 'right' as const, render: (_: any, row: any) => <Button size="small" icon={<EyeOutlined />} onClick={() => updateParams({ itemId: row.itemId })}>详情</Button> },
    ];
    const row = data.items?.[0];
    if (!row) return [];
    const hidden = new Set(['warehouseId', 'zoneId', 'locationId', 'itemId', 'batchId', 'productionOrderId']);
    const labels: Record<string, string> = {
      warehouseCode: '仓库编码', warehouseName: '仓库名称', warehouseType: '仓库类型', zoneCode: '库区', locationCode: '库位',
      itemCode: '物料编码', itemName: '物料名称', model: '型号', spec: '规格', unit: '单位', batchNo: '批次',
      onHandQty: '当前库存', frozenQty: '冻结库存', minimumStock: '安全库存', updatedAt: '更新时间',
      itemCount: '物料种类', inventoryRecordCount: '库存记录', lowStockCount: '低库存', zeroStockCount: '零库存',
      inQty: '入库数量', outQty: '出库数量', openingQty: '期初数量', closingQty: '结存数量', movementCount: '变动次数',
      lastInboundAt: '最近入库', lastMovementAt: '最近变动', stockAgeDays: '库龄（天）', idleDays: '呆滞（天）',
      productionOrderNo: '生产任务', outputItemCode: '产出物料', issuedQty: '领料数量', returnedQty: '退料数量',
      availableQty: '可用库存', reservedQty: '预占库存', locationCount: '库位数',
      batchCount: '批次数', riskStatus: '库存状态',
    };
    return Object.keys(row).filter(key => !hidden.has(key)).map(key => ({
      title: labels[key] || key, dataIndex: key, key,
      align: /Qty$|Count$|Days$/.test(key) ? 'right' as const : undefined,
      render: (value: any) => key.endsWith('At') ? dateTime(value) : safe(value),
    }));
  }, [data.items, reportType]);
  const query = new URLSearchParams();
  ['keyword', 'warehouseId', 'dateFrom', 'dateTo'].forEach(key => values[key] && query.set(key, values[key]));
  return <Card className="inventory-tab-card">
    <div className="inventory-tab-toolbar">
      <div className="inventory-filter-bar">
        <DatePicker.RangePicker
          value={values.dateFrom && values.dateTo ? [dayjs(values.dateFrom), dayjs(values.dateTo)] : null}
          onChange={dates => updateParams({ dateFrom: dates?.[0]?.format('YYYY-MM-DD'), dateTo: dates?.[1]?.format('YYYY-MM-DD'), page: 1 })}
          placeholder={['统计开始日期', '统计结束日期']}
        />
        <Select value={reportType} options={reportOptions} onChange={value => updateParams({ reportType: value, itemId: undefined, page: 1 })} />
        <Input allowClear value={values.keyword || ''} placeholder="物料或仓库关键字" onChange={event => updateParams({ keyword: event.target.value, page: 1 })} />
        <Select allowClear={reportType !== 'current'} showSearch optionFilterProp="label" value={values.warehouseId} placeholder="仓库" options={warehouses.map((w: any) => ({ value: w.id, label: `${safe(w.warehouseCode)} ${safe(w.name, '未命名仓库')}${w.status === 'INACTIVE' ? '（停用）' : ''}` }))} onChange={value => updateParams({ warehouseId: value, itemId: undefined, page: 1 })} />
        <Button onClick={() => updateParams({
          keyword: undefined, warehouseId: reportType === 'current' ? values.warehouseId : undefined, itemId: undefined, dateFrom: undefined, dateTo: undefined, page: 1,
        })}>重置</Button>
      </div>
      <Space>
        <Button icon={<PrinterOutlined />} onClick={() => window.print()}>打印当前结果</Button>
        <Button type="primary" icon={<DownloadOutlined />} onClick={() => download(`/inventory/reports/${reportType}/export?${query}`, `${reportOptions.find(option => option.value === reportType)?.label || '库存报表'}.xlsx`).catch(error => message.error(error.message))}>导出 Excel</Button>
      </Space>
    </div>
    <div className="report-summary">{(data.summary?.unitTotals || []).map((row: any) => <Tag key={row.unit}>{row.unit}：{formatQuantity(row.quantity)}</Tag>)}</div>
    <Table rowKey={(row: any, index) => row.id || `${row.warehouseId}-${row.itemId}-${row.batchNo || index}`} loading={loading} dataSource={data.items || []} columns={columns} scroll={{ x: Math.max(900, columns.length * 150) }} pagination={{ current: Number(values.page || 1), pageSize: 20, total: data.total || 0, showTotal: total => `共 ${total} 条`, onChange: page => updateParams({ page }) }} />
    {reportType === 'current' && <CurrentInventoryDetail
      itemId={detailItemId}
      warehouseId={values.warehouseId}
      open={Boolean(detailItemId && values.warehouseId)}
      mobile={mobile}
      onClose={() => updateParams({ itemId: undefined })}
      onDocument={(documentId: string) => updateParams({ tab: 'documents', documentId, itemId: undefined })}
    />}
  </Card>;
}

export function InventoryManagementPage({ user }: { user: UserLike }) {
  const [params, setParams] = useSearchParams();
  const [warehouses, setWarehouses] = useState<any[]>([]);
  const allowed = useMemo(() => ({
    documents: can(user, 'stock.view'),
    flows: can(user, 'inventory.view'),
    reports: can(user, 'inventory.report.view'),
  }), [user]);
  const firstAllowed = (Object.keys(allowed) as TabKey[]).find(key => allowed[key]) || 'documents';
  const requestedTab = (params.get('tab') as TabKey) || firstAllowed;
  const tab = allowed[requestedTab] ? requestedTab : firstAllowed;
  const updateParams = (changes: Record<string, any>) => {
    const next = new URLSearchParams(params);
    Object.entries(changes).forEach(([key, value]) => value === undefined || value === null || value === '' ? next.delete(key) : next.set(key, String(value)));
    setParams(next, { replace: false });
  };
  useEffect(() => { api('/warehouses?page=1&pageSize=100').then(result => setWarehouses(result?.items || result || [])).catch(() => setWarehouses([])); }, []);
  useEffect(() => { if (requestedTab !== tab) updateParams({ tab }); }, [requestedTab, tab]);
  const tabs = [
    allowed.documents && { key: 'documents', label: '库存单据', children: <DocumentsTab user={user} params={params} updateParams={updateParams} warehouses={warehouses} /> },
    allowed.flows && { key: 'flows', label: '库存流水', children: <FlowsTab params={params} updateParams={updateParams} warehouses={warehouses} /> },
    allowed.reports && { key: 'reports', label: '库存报表', children: <ReportsTab params={params} updateParams={updateParams} warehouses={warehouses} /> },
  ].filter(Boolean) as any[];
  return <div className="inventory-management-page">
    <div className="page-heading">
      <div><Typography.Title level={2}>库存管理</Typography.Title><Typography.Text type="secondary">统一查询库存单据、不可修改流水和库存报表，详情在当前页面打开。</Typography.Text></div>
      <Button icon={<ReloadOutlined />} onClick={() => window.dispatchEvent(new Event('inventory:refresh'))}>刷新</Button>
    </div>
    {tabs.length ? <Tabs activeKey={tab} items={tabs} onChange={key => updateParams({ tab: key, page: 1, documentId: undefined, flowId: undefined })} /> : <Card><Empty image={<FileSearchOutlined />} description="当前账号没有库存管理查看权限" /></Card>}
  </div>;
}
