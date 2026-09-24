import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Col,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
  message,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Spin,
} from 'antd';
import { DeleteOutlined, EditOutlined, EyeOutlined, PlusOutlined } from '@ant-design/icons';
import type { User } from './App';
import { api } from './api';
import { PageScaffold, StatusTag } from './components';
import { formatQuantity } from './domain';
import { ResponsiveTable as Table } from './responsive';

const itemTypeText: Record<string, string> = {
  MATERIAL: '原材料',
  FINISHED_GOOD: '成品',
};

const can = (user: User, permission: string) =>
  user.role === 'ADMIN' || Boolean(user.permissions?.includes(permission));

export const BOM_OPTION_PAGE_SIZE = 100;

type BomItemRole = 'output' | 'component';

function optionLabel(item: any) {
  return `${item.itemCode} ${item.name}（${itemTypeText[item.itemType]}）`;
}

function useBomItemOptions(role: BomItemRole) {
  const [items, setItems] = useState<any[]>([]);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);
  const keyword = useRef('');

  const load = useCallback(async (nextPage: number, nextKeyword: string, append: boolean) => {
    const currentRequest = ++requestId.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({
        role,
        page: String(nextPage),
        pageSize: String(BOM_OPTION_PAGE_SIZE),
      });
      if (nextKeyword) params.set('keyword', nextKeyword);
      const result = await api(`/boms/item-options?${params}`);
      if (currentRequest !== requestId.current) return;
      setItems((current) => append
        ? [...current, ...result.items.filter((item: any) => !current.some(option => option.id === item.id))]
        : result.items);
      setPage(result.page);
      setTotal(result.total);
    } catch (error: any) {
      if (currentRequest === requestId.current) message.error(error.message);
    } finally {
      if (currentRequest === requestId.current) setLoading(false);
    }
  }, [role]);

  useEffect(() => {
    void load(1, '', false);
    return () => { requestId.current += 1; };
  }, [load]);

  const search = useCallback((value: string) => {
    keyword.current = value.trim();
    void load(1, keyword.current, false);
  }, [load]);

  const loadMore = useCallback(() => {
    if (loading || items.length >= total) return;
    void load(page + 1, keyword.current, true);
  }, [items.length, load, loading, page, total]);

  const ensureSelected = useCallback((item?: any) => {
    if (!item?.id || items.some(option => option.id === item.id)) return;
    setItems(current => current.some(option => option.id === item.id) ? current : [item, ...current]);
  }, [items]);

  return { items, total, loading, search, loadMore, ensureSelected };
}

function pagedSelectProps(source: ReturnType<typeof useBomItemOptions>) {
  return {
    showSearch: true,
    filterOption: false,
    optionFilterProp: 'label',
    options: source.items.map(item => ({ value: item.id, label: optionLabel(item) })),
    loading: source.loading,
    notFoundContent: source.loading ? <Spin size="small" /> : '暂无可选物料',
    dropdownRender: (menu: React.ReactNode) => <>
      {menu}
      <div style={{ padding: '8px 12px', color: '#64748b', borderTop: '1px solid #f0f0f0' }}>
        {source.loading ? '正在加载…' : `已加载 ${source.items.length} / 总计 ${source.total}`}
      </div>
    </>,
    onSearch: source.search,
    onPopupScroll: (event: React.UIEvent<HTMLElement>) => {
      const target = event.currentTarget;
      if (target.scrollTop + target.clientHeight >= target.scrollHeight - 24) source.loadMore();
    },
  };
}

export function BomsPage({ user }: { user: User }) {
  const [data, setData] = useState<any>({ items: [] });
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [detail, setDetail] = useState<any>();
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const selectedOutput = Form.useWatch('finishedGoodId', form);
  const outputItems = useBomItemOptions('output');
  const componentItems = useBomItemOptions('component');
  const manageable = can(user, 'bom.manage');
  const deletable = can(user, 'bom.delete');

  const load = async () => {
    try {
      const boms = await api('/boms?pageSize=100');
      setData(boms);
    } catch (error: any) {
      message.error(error.message);
    }
  };
  useEffect(() => { void load(); }, []);

  const componentOptions = useMemo(() => componentItems.items
    .filter(item => item.id !== selectedOutput)
    .map(item => ({
      value: item.id,
      label: optionLabel(item),
    })), [componentItems.items, selectedOutput]);

  const create = () => {
    setEditingId(undefined);
    form.resetFields();
    form.setFieldsValue({ version: 'V1', status: 'ACTIVE', lines: [{}] });
    setOpen(true);
  };
  const edit = async (record: any) => {
    try {
      const row = await api(`/boms/${record.id}`);
      setEditingId(record.id);
      form.setFieldsValue(row);
      outputItems.ensureSelected({ id: row.finishedGoodId, itemCode: row.finishedGoodCode, name: row.finishedGoodName, itemType: row.outputItemType });
      row.lines?.forEach((line: any) => componentItems.ensureSelected({ id: line.materialId, itemCode: line.itemCode, name: line.name, itemType: line.itemType }));
      setOpen(true);
    } catch (error: any) {
      message.error(error.message);
    }
  };
  const view = async (record: any) => {
    try {
      setDetail(await api(`/boms/${record.id}`));
    } catch (error: any) {
      message.error(error.message);
    }
  };
  const save = async (values: any) => {
    setSaving(true);
    try {
      const payload = {
        ...values,
        lines: values.lines.map((line: any) => ({
          materialId: line.materialId,
          qtyPer: String(line.qtyPer),
          remark: line.remark?.trim() || undefined,
        })),
      };
      await api(editingId ? `/boms/${editingId}` : '/boms', {
        method: editingId ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      });
      message.success(editingId ? 'BOM 已更新' : 'BOM 已创建');
      setOpen(false);
      await load();
    } catch (error: any) {
      message.error(error.message);
    } finally {
      setSaving(false);
    }
  };
  const copy = (record: any) => {
    let model = `${record.version}-COPY`;
    Modal.confirm({
      title: '复制 BOM',
      content: <Input defaultValue={model} onChange={event => { model = event.target.value; }} placeholder="新型号" />,
      okText: '复制',
      onOk: async () => {
        if (!model.trim()) throw new Error('请输入新型号');
        await api(`/boms/${record.id}/copy`, {
          method: 'POST',
          body: JSON.stringify({ version: model.trim(), status: 'INACTIVE' }),
        });
        message.success('BOM 已复制为停用型号');
        await load();
      },
    });
  };
  const toggleStatus = async (record: any) => {
    try {
      await api(`/boms/${record.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: record.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }),
      });
      message.success('BOM 状态已更新');
      await load();
    } catch (error: any) {
      message.error(error.message);
    }
  };
  const remove = async (record: any) => {
    try {
      await api(`/boms/${record.id}`, { method: 'DELETE' });
      message.success('BOM 已删除，历史生产任务快照不受影响');
      await load();
    } catch (error: any) {
      message.error(error.message);
    }
  };

  const columns: any[] = [
    {
      title: '产出成品',
      render: (_: unknown, record: any) => (
        <span>{record.finishedGoodCode} {record.finishedGoodName}<small className="table-subtext">{itemTypeText[record.outputItemType]}</small></span>
      ),
    },
    { title: '型号', dataIndex: 'version' },
    { title: '明细数', dataIndex: 'lineCount', align: 'right' },
    { title: '状态', dataIndex: 'status', render: (value: string) => <StatusTag value={value} /> },
    { title: '备注', dataIndex: 'notes', render: (value: string) => value || '-' },
    {
      title: '操作',
      width: 300,
      render: (_: unknown, record: any) => (
        <Space wrap>
          <Button type="link" icon={<EyeOutlined />} onClick={() => view(record)}>详情</Button>
          {manageable && <Button type="link" icon={<EditOutlined />} onClick={() => edit(record)}>编辑</Button>}
          {manageable && <Button type="link" onClick={() => copy(record)}>复制</Button>}
          {manageable && <Popconfirm title={`确认${record.status === 'ACTIVE' ? '停用' : '启用'}该 BOM？`} onConfirm={() => toggleStatus(record)}>
            <Button type="link">{record.status === 'ACTIVE' ? '停用' : '启用'}</Button>
          </Popconfirm>}
          {deletable && <Popconfirm title="删除后不影响已生成的生产任务，确认继续？" onConfirm={() => remove(record)}>
            <Button type="link" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>}
        </Space>
      ),
    },
  ];

  return (
    <PageScaffold
      title="BOM 档案"
      subtitle="产出成品可选择启用成品，组成物料可选择启用原材料。"
      extra={manageable ? <Button type="primary" icon={<PlusOutlined />} onClick={create}>新增 BOM</Button> : undefined}
    >
      <Table rowKey="id" dataSource={data.items} columns={columns} pagination={false} scroll={{ x: 1100 }} />
      <Modal
        width={760}
        title={editingId ? '编辑 BOM' : '新增 BOM'}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={saving}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={save}>
          <Form.Item label="产出成品" name="finishedGoodId" rules={[{ required: true, message: '请选择产出成品' }]}>
            <Select {...pagedSelectProps(outputItems)} />
          </Form.Item>
          <Row gutter={12}>
            <Col xs={24} sm={12}><Form.Item label="型号" name="version" rules={[{ required: true, message: '请输入型号' }]}><Input maxLength={30} /></Form.Item></Col>
            <Col xs={24} sm={12}><Form.Item label="状态" name="status" rules={[{ required: true }]}><Select options={[{ value: 'ACTIVE', label: '启用' }, { value: 'INACTIVE', label: '停用' }]} /></Form.Item></Col>
          </Row>
          <Form.List name="lines">
            {(fields, { add, remove: removeLine }) => <>
              {fields.map(field => (
                <Row gutter={8} key={field.key} align="middle">
                  <Col xs={24} sm={12}><Form.Item {...field} label="组成物料" name={[field.name, 'materialId']} rules={[{ required: true }]}>
                    <Select
                      {...pagedSelectProps(componentItems)}
                      options={componentOptions}
                    />
                  </Form.Item></Col>
                  <Col xs={12} sm={4}><Form.Item {...field} label="单件用量" name={[field.name, 'qtyPer']} rules={[{ required: true }]}>
                    <InputNumber min={1} precision={0} stringMode style={{ width: '100%' }} />
                  </Form.Item></Col>
                  <Col xs={20} sm={6}><Form.Item {...field} label="备注" name={[field.name, 'remark']}><Input maxLength={200} placeholder="可选" /></Form.Item></Col>
                  <Col xs={4} sm={2}><Button danger type="text" icon={<DeleteOutlined />} aria-label="删除 BOM 明细" onClick={() => removeLine(field.name)} /></Col>
                </Row>
              ))}
              <Button type="dashed" block icon={<PlusOutlined />} onClick={() => add()}>增加组成物料</Button>
            </>}
          </Form.List>
          <Form.Item label="备注" name="notes" style={{ marginTop: 16 }}><Input.TextArea maxLength={500} rows={3} /></Form.Item>
        </Form>
      </Modal>
      <Drawer title="BOM 详情" width={680} open={Boolean(detail)} onClose={() => setDetail(undefined)}>
        {detail && <>
          <Descriptions bordered column={1} items={[
            { label: '产出成品', children: `${detail.finishedGoodCode} ${detail.finishedGoodName}` },
            { label: '物料类型', children: itemTypeText[detail.outputItemType] },
            { label: '型号', children: detail.version },
            { label: '状态', children: <StatusTag value={detail.status} /> },
            { label: '备注', children: detail.notes || '-' },
          ]} />
          <Table
            rowKey="materialId"
            pagination={false}
            dataSource={detail.lines}
            columns={[
              { title: '组成物料', render: (_: unknown, row: any) => `${row.itemCode} ${row.name}` },
              { title: '类型', dataIndex: 'itemType', render: (value: string) => itemTypeText[value] },
              { title: '单件用量', dataIndex: 'qtyPer', align: 'right', render: formatQuantity },
              { title: '单位', dataIndex: 'unit' },
              { title: '备注', dataIndex: 'remark', render: (value: string) => value || '-' },
            ]}
          />
        </>}
      </Drawer>
    </PageScaffold>
  );
}
