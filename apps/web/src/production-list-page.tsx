import { useEffect, useState } from 'react';
import dayjs from 'dayjs';
import { Badge, Button, DatePicker, Form, Input, InputNumber, message, Modal, Progress, Select, Space, Tag } from 'antd';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { User } from './App';
import { api } from './api';
import { PageScaffold, StatusTag } from './components';
import { formatQuantity } from './domain';
import { ResponsiveTable as Table } from './responsive';

const outputTypeText: Record<string, string> = {
  FINISHED_GOOD: '成品',
};

export function ProductionPage({ user }: { user: User }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [data, setData] = useState<any>({ items: [], statistics: {} });
  const [outputs, setOutputs] = useState<any[]>([]);
  const [warehouses, setWarehouses] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const load = async () => {
    try {
      const [orders, boms, warehouseRows] = await Promise.all([
        api(`/production-orders?pageSize=100&status=${searchParams.get('status') || 'all'}${searchParams.get('keyword') ? `&keyword=${encodeURIComponent(searchParams.get('keyword') || '')}` : ''}`),
        api('/boms?pageSize=100&status=ACTIVE'),
        api('/warehouses'),
      ]);
      setData(orders);
      setOutputs(boms.items.map((bom: any) => ({
        id: bom.finishedGoodId,
        code: bom.finishedGoodCode,
        name: bom.finishedGoodName,
        itemType: bom.outputItemType,
      })).filter((row: any, index: number, rows: any[]) =>
        rows.findIndex(candidate => candidate.id === row.id) === index));
      setWarehouses((warehouseRows || []).filter((row:any)=>row.warehouseType==='RAW'&&row.status==='ACTIVE'));
    } catch (error: any) {
      message.error(error.message);
    }
  };
  useEffect(() => { void load(); }, [searchParams.toString()]);

  const save = async (values: any) => {
    setSaving(true);
    try {
      await api('/production-orders', {
        method: 'POST',
        body: JSON.stringify({
          ...values,
          plannedQty: String(values.plannedQty),
          plannedDate: values.plannedDate?.format('YYYY-MM-DD'),
        }),
      });
      message.success('生产任务已创建并保存 BOM 快照');
      setOpen(false);
      await load();
    } catch (error: any) {
      message.error(error.message);
    } finally {
      setSaving(false);
    }
  };
  const release = (record: any) => Modal.confirm({
    title: '发布生产任务并检查缺料？',
    onOk: async () => {
      try {
        await api(`/production-orders/${record.id}/release`, { method: 'POST' });
        message.success('发布成功');
        await load();
      } catch (error: any) {
        message.error(error.message);
        throw error;
      }
    },
  });
  const productionManageable = ['ADMIN', 'PRODUCTION'].includes(user.role)
    || Boolean(user.permissions?.includes('production.manage'));

  return (
    <PageScaffold
      title="生产任务"
      subtitle="统一查看生产进度、缺料、待领料、待审核与待完工状态；任务创建时保存启用 BOM 快照。"
      extra={productionManageable ? <Button type="primary" onClick={() => { form.resetFields(); setOpen(true); }}>新建任务</Button> : undefined}
    >
      <div className="production-task-filters">
        {[
          ['all', '全部任务', 'all'], ['pending-approval', '待审核', 'pendingApproval'],
          ['pending-production', '待生产', 'pendingProduction'], ['shortage', '缺料', 'shortage'],
          ['pending-issue', '待领料', 'pendingIssue'], ['in-progress', '生产中', 'inProgress'],
          ['pending-completion', '待完工', 'pendingCompletion'], ['completed', '已完成', 'completed'],
        ].map(([value, label, key]) => <Button
          key={value}
          type={(searchParams.get('status') || 'all') === value ? 'primary' : 'default'}
          onClick={() => { const next = new URLSearchParams(searchParams); next.set('status', value); setSearchParams(next); }}
        >{label} <Badge count={Number(data.statistics?.[key] || 0)} showZero overflowCount={999} color={(searchParams.get('status') || 'all') === value ? '#fff' : '#1677ff'} /></Button>)}
        <Input.Search
          allowClear
          defaultValue={searchParams.get('keyword') || ''}
          placeholder="任务单号 / 产出物料"
          onSearch={value => { const next = new URLSearchParams(searchParams); value ? next.set('keyword', value) : next.delete('keyword'); setSearchParams(next); }}
        />
      </div>
      <Table
        rowKey="id"
        dataSource={data.items}
        columns={[
          { title: '任务单号', dataIndex: 'orderNo' },
          {
            title: '产出物料',
            render: (_: unknown, row: any) => (
              <span>{row.finishedGoodCode} {row.finishedGoodName}<small className="table-subtext">{outputTypeText[row.outputItemType]}</small></span>
            ),
          },
          {
            title: '生产进度',
            width: 190,
            render: (_: unknown, row: any) => <Progress
              size="small"
              percent={Math.min(100, Math.round(Number(row.completedQty) / Number(row.plannedQty) * 100))}
              format={() => `${formatQuantity(row.completedQty)} / ${formatQuantity(row.plannedQty)}`}
            />,
          },
          { title: '状态', dataIndex: 'status', render: (value: string) => <StatusTag value={value} /> },
          {
            title: '实时待办',
            render: (_: unknown, row: any) => <Space size={[4, 4]} wrap>
              {Number(row.pendingApprovalCount) > 0 && <Tag color="purple">待审核 {row.pendingApprovalCount}</Tag>}
              {Number(row.shortageMaterialCount) > 0 && <Tag color="red">缺料 {row.shortageMaterialCount} 种</Tag>}
              {Number(row.pendingIssueQty) > 0 && !['DRAFT', 'COMPLETED', 'CANCELLED'].includes(row.status) && <Tag color="orange">待领 {formatQuantity(row.pendingIssueQty)}</Tag>}
              {Number(row.pendingCompletionQty) > 0 && <Tag color="blue">待完工 {formatQuantity(row.pendingCompletionQty)}</Tag>}
              {Number(row.pendingReturnQty) > 0 && <Tag color="gold">待退备用件 {formatQuantity(row.pendingReturnQty)}</Tag>}
              {!row.todoTypes?.length && <span className="table-subtext">无待办</span>}
            </Space>,
          },
          { title: '计划日期', dataIndex: 'plannedDate', render: (value: string) => value ? dayjs(value).format('YYYY-MM-DD') : '-' },
          {
            title: '操作',
            render: (_: unknown, row: any) => <Space>
              <Button type="link" onClick={() => navigate(`/production/tasks/${row.id}`)}>详情</Button>
              {row.status === 'DRAFT' && productionManageable && <Button type="link" onClick={() => release(row)}>发布</Button>}
            </Space>,
          },
        ]}
      />
      <Modal title="新建生产任务" open={open} confirmLoading={saving} onCancel={() => setOpen(false)} onOk={() => form.submit()}>
        <Form form={form} layout="vertical" onFinish={save}>
          <Form.Item label="产出物料" name="finishedGoodId" rules={[{ required: true }]}>
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="选择已有启用 BOM 的成品"
              options={outputs.map(row => ({
                value: row.id,
                label: `${row.code} ${row.name}（${outputTypeText[row.itemType]}）`,
              }))}
            />
          </Form.Item>
          <Form.Item label="计划数量" name="plannedQty" rules={[{ required: true }]}>
            <InputNumber min={0.0001} precision={4} stringMode style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="默认领料仓库" name="defaultIssueWarehouseId">
            <Select allowClear placeholder="未选择时按仓库编码自动选择" options={warehouses.map(row=>({value:row.id,label:`${row.warehouseCode} ${row.name}`}))}/>
          </Form.Item>
          <Form.Item label="计划日期" name="plannedDate"><DatePicker style={{ width: '100%' }} /></Form.Item>
          <Form.Item label="备注" name="notes"><Input.TextArea maxLength={500} /></Form.Item>
        </Form>
      </Modal>
    </PageScaffold>
  );
}
