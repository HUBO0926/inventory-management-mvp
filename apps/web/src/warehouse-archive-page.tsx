import { useEffect, useState } from 'react';
import {
  Button,
  Collapse,
  Col,
  Descriptions,
  Form,
  Input,
  InputNumber,
  message,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
} from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { api } from './api';
import { PageScaffold, StatusTag } from './components';
import { ResponsiveTable as Table } from './responsive';

const zoneCode = (warehouseCode: string | undefined, sequenceNo: unknown) => {
  const code = String(warehouseCode || '').trim().toUpperCase();
  const sequence = Number(sequenceNo);
  return code && Number.isInteger(sequence) ? `${code}${String(sequence).padStart(2, '0')}` : '保存后自动生成';
};
const locationCodes = (warehouseCode: string | undefined, zoneName: unknown, count: unknown) => {
  const code = String(warehouseCode || '').trim().toUpperCase();
  const name = String(zoneName || '').trim();
  const size = Number(count);
  if (!code || !name || !Number.isInteger(size) || size < 1) return [];
  return Array.from({ length: Math.min(size, 500) }, (_, index) => `${code}-${name}-${String(index + 1).padStart(2, '0')}`);
};

export function WarehouseArchivePage() {
  const [warehouses, setWarehouses] = useState<any[]>([]);
  const [editing, setEditing] = useState<any>();
  const [detail, setDetail] = useState<any>();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [nextSequence, setNextSequence] = useState(2);
  const [form] = Form.useForm();
  const warehouseCode = Form.useWatch('warehouseCode', form);

  const load = async () => {
    try {
      setWarehouses(await api('/warehouses'));
    } catch (error: any) {
      message.error(error.message);
    }
  };
  useEffect(() => { void load(); }, []);

  const create = () => {
    setEditing(undefined);
    setNextSequence(2);
    form.resetFields();
    form.setFieldsValue({
      warehouseType: 'RAW',
      status: 'ACTIVE',
      zones: [{ sequenceNo: 1, name: '主库区', actualLocation: '', locationCount: 1, status: 'ACTIVE' }],
    });
    setOpen(true);
  };
  const edit = async (record: any) => {
    try {
      const detail = await api(`/warehouses/${record.id}`);
      setEditing(detail);
      setNextSequence(Math.max(0, ...detail.zones.map((zone: any) => Number(zone.sequenceNo))) + 1);
      form.setFieldsValue(detail);
      setOpen(true);
    } catch (error: any) {
      message.error(error.message);
    }
  };
  const view = async (record: any) => {
    try { setDetail(await api(`/warehouses/${record.id}`)); } catch (error: any) { message.error(error.message); }
  };
  const save = async (values: any) => {
    setSaving(true);
    try {
      await api(editing ? `/warehouses/${editing.id}` : '/warehouses', {
        method: editing ? 'PATCH' : 'POST',
        body: JSON.stringify({
          ...values,
          warehouseCode: values.warehouseCode.trim().toUpperCase(),
          zones: values.zones.map((zone: any) => ({ ...zone, sequenceNo: Number(zone.sequenceNo) })),
        }),
      });
      message.success('仓库和库区已保存');
      setOpen(false);
      await load();
    } catch (error: any) {
      message.error(error.message);
    } finally {
      setSaving(false);
    }
  };
  const remove = async (record: any) => {
    try {
      const result = await api(`/warehouses/${record.id}`, { method: 'DELETE' });
      message.success(result.deletionMode === 'ARCHIVED' ? '仓库已安全归档，历史数据仍可查询' : '仓库已删除');
      await load();
    } catch (error: any) {
      message.error(error.message);
    }
  };

  return (
    <PageScaffold
      title="仓储档案"
      subtitle="在仓库资料中直接维护库区；库区编号由仓库编码与两位序号自动组成。"
      extra={<Button type="primary" icon={<PlusOutlined />} onClick={create}>新增仓库</Button>}
    >
      <Table
        rowKey="id"
        dataSource={warehouses}
        columns={[
          { title: '编码', dataIndex: 'warehouseCode' },
          { title: '显示名', dataIndex: 'displayName' },
          { title: '名称', dataIndex: 'name' },
          { title: '类型', dataIndex: 'warehouseType', render: (value: string) => value === 'RAW' ? '原材料库' : value === 'FG' ? '成品库' : '不良品库' },
          { title: '库区数', dataIndex: 'zoneCount', align: 'right' },
          { title: '状态', dataIndex: 'status', render: (value: string) => <StatusTag value={value} /> },
          {
            title: '操作',
            render: (_: unknown, record: any) => <Space>
              <Button type="link" onClick={() => view(record)}>详情</Button>
              <Button type="link" onClick={() => edit(record)}>编辑</Button>
              <Popconfirm title="有业务引用时将安全归档，确认删除仓库？" onConfirm={() => remove(record)}>
                <Button danger type="link">删除</Button>
              </Popconfirm>
            </Space>,
          },
        ]}
      />
      <Modal
        width={860}
        title={editing ? '编辑仓库' : '新增仓库'}
        open={open}
        confirmLoading={saving}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={save}>
          <Row gutter={12}>
            <Col xs={24} sm={12}><Form.Item label="仓库编码" name="warehouseCode" rules={[
              { required: true },
              { pattern: /^[A-Za-z0-9][A-Za-z0-9-]{0,19}$/, message: '仅允许字母、数字和横线，最长 20 位' },
            ]}><Input onInput={event => { event.currentTarget.value = event.currentTarget.value.toUpperCase(); }} /></Form.Item></Col>
            <Col xs={24} sm={12}><Form.Item label="仓库类型" name="warehouseType" rules={[{ required: true }]}>
              <Select options={[{ value: 'RAW', label: '原材料库' }, { value: 'FG', label: '成品库' }, { value: 'DEFECTIVE', label: '不良品库' }]} />
            </Form.Item></Col>
            <Col xs={24} sm={12}><Form.Item label="仓库名称" name="name" rules={[{ required: true }]}><Input maxLength={100} /></Form.Item></Col>
            <Col xs={24} sm={12}><Form.Item label="显示名" name="displayName" rules={[{ required: true }]}><Input maxLength={100} /></Form.Item></Col>
            <Col xs={24} sm={12}><Form.Item label="仓库状态" name="status" rules={[{ required: true }]}>
              <Select options={[{ value: 'ACTIVE', label: '启用' }, { value: 'INACTIVE', label: '停用' }]} />
            </Form.Item></Col>
          </Row>
          <div className="warehouse-zone-heading">
            <strong>库区明细</strong>
            <span>设置标准库位数量；历史默认库位会保留用于追溯，不计入该数量。</span>
          </div>
          <Form.List name="zones">
            {(fields, { add, remove: removeZone }) => <>
              {fields.map(field => (
                <div className="warehouse-zone-card" key={field.key}>
                  <Form.Item {...field} name={[field.name, 'id']} hidden><Input /></Form.Item>
                  <Row gutter={10} align="middle">
                    <Col xs={12} sm={4}><Form.Item {...field} label="序号" name={[field.name, 'sequenceNo']} rules={[{ required: true }]}>
                      <InputNumber min={1} max={99} precision={0} style={{ width: '100%' }} />
                    </Form.Item></Col>
                    <Col xs={12} sm={5}><Form.Item noStyle shouldUpdate={(previous, current) =>
                      previous.warehouseCode !== current.warehouseCode
                      || previous.zones?.[field.name]?.sequenceNo !== current.zones?.[field.name]?.sequenceNo
                    }>
                      {() => <Form.Item label="库区编号">
                        <Input disabled value={zoneCode(warehouseCode, form.getFieldValue(['zones', field.name, 'sequenceNo']))} />
                      </Form.Item>}
                    </Form.Item></Col>
                    <Col xs={24} sm={4}><Form.Item {...field} label="库区名称" name={[field.name, 'name']} rules={[{ required: true }, { pattern: /^[\u4e00-\u9fffA-Za-z0-9-]+$/, message: '仅允许中文、字母、数字和横线' }]}><Input maxLength={24} /></Form.Item></Col>
                    <Col xs={24} sm={5}><Form.Item {...field} label="实际位置" name={[field.name, 'actualLocation']} rules={[{ required: true }]}><Input maxLength={200} placeholder="例如：厂房一层东侧" /></Form.Item></Col>
                    <Col xs={12} sm={3}><Form.Item {...field} label="库位数量" name={[field.name, 'locationCount']} rules={[{ required: true, message: '库位数量必须为大于0的整数' }, { type: 'number', min: 1, max: 500, message: '库位数量必须为 1 至 500 的整数' }]}><InputNumber min={1} max={500} precision={0} style={{ width: '100%' }} /></Form.Item></Col>
                    <Col xs={12} sm={3}><Form.Item {...field} label="状态" name={[field.name, 'status']} rules={[{ required: true }]}>
                      <Select options={[{ value: 'ACTIVE', label: '启用' }, { value: 'INACTIVE', label: '停用' }]} />
                    </Form.Item></Col>
                    <Col xs={24} sm={1}><Button danger type="text" icon={<DeleteOutlined />} aria-label="删除库区" onClick={() => removeZone(field.name)} /></Col>
                  </Row>
                  <Form.Item noStyle shouldUpdate={(previous, current) => previous.warehouseCode !== current.warehouseCode || previous.zones?.[field.name]?.name !== current.zones?.[field.name]?.name || previous.zones?.[field.name]?.locationCount !== current.zones?.[field.name]?.locationCount}>
                    {() => {
                      const zone = form.getFieldValue(['zones', field.name]) || {};
                      const preview = locationCodes(warehouseCode, zone.name, zone.locationCount);
                      return <Collapse size="small" ghost items={[{ key: 'preview', label: `查看自动生成库位（${preview.length} 个）`, children: preview.length ? <div className="warehouse-location-preview">{preview.map(code => <span key={code}>{code}</span>)}</div> : '填写仓库编码、库区名称和库位数量后显示预览' }]} />;
                    }}
                  </Form.Item>
                </div>
              ))}
              <Button
                type="dashed"
                block
                icon={<PlusOutlined />}
                onClick={() => {
                  add({ sequenceNo: nextSequence, locationCount: 1, status: 'ACTIVE' });
                  setNextSequence(current => current + 1);
                }}
              >
                增加库区
              </Button>
            </>}
          </Form.List>
        </Form>
      </Modal>
      <Modal title="仓库详情" open={!!detail} footer={null} onCancel={() => setDetail(undefined)} width={720}>
        {detail && <><Descriptions column={{ xs: 1, sm: 2 }} items={[
          { label: '仓库编码', children: detail.warehouseCode }, { label: '仓库名称', children: detail.displayName || detail.name },
          { label: '仓库类型', children: detail.warehouseType === 'RAW' ? '原材料库' : detail.warehouseType === 'FG' ? '成品库' : '不良品库' }, { label: '状态', children: <StatusTag value={detail.status} /> },
          { label: '物料数', children: detail.summary?.itemCount ?? 0 }, { label: '库存数量', children: detail.summary?.onHandQty ?? '0' },
          { label: '低库存', children: detail.summary?.lowStockCount ?? 0 }, { label: '零库存', children: detail.summary?.zeroStockCount ?? 0 },
        ]} /><Table rowKey="id" dataSource={detail.zones || []} pagination={false} columns={[
          { title: '库区编码', dataIndex: 'code' }, { title: '库区名称', dataIndex: 'name' }, { title: '实际位置', dataIndex: 'actualLocation' }, { title: '标准库位', dataIndex: 'locationCount', align: 'right' }, { title: '实际库位', dataIndex: 'locationCountActual', align: 'right' }, { title: '状态', dataIndex: 'status', render: (value: string) => <StatusTag value={value} /> },
        ]} /></>}
      </Modal>
    </PageScaffold>
  );
}
