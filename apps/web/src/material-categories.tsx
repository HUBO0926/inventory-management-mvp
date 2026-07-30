import { useEffect, useState } from 'react';
import {
  Button,
  Form,
  Input,
  InputNumber,
  message,
  Modal,
  Pagination,
  Popconfirm,
  Select,
  Space,
  Tabs,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useSearchParams } from 'react-router-dom';
import type { User } from './App';
import { api } from './api';
import { PageScaffold, StatusTag } from './components';
import { ResponsiveTable as Table } from './responsive';
import { formatBeijingTime } from './domain';

type MaterialType = 'MATERIAL' | 'FINISHED_GOOD';

const typeLabels: Record<MaterialType, string> = {
  MATERIAL: '原材料',
  FINISHED_GOOD: '成品',
};
const validType = (value: string | null): MaterialType =>
  value && Object.prototype.hasOwnProperty.call(typeLabels, value) ? value as MaterialType : 'MATERIAL';
const can = (user: User, permission: string) =>
  user.role === 'ADMIN' || Boolean(user.permissions?.includes(permission));

export function MaterialCategoriesPage({ user }: { user: User }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const itemType = validType(searchParams.get('itemType'));
  const [data, setData] = useState<any>({ items: [], total: 0 });
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<any>();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const manageable = can(user, 'category.manage');
  const deletable = can(user, 'category.delete');

  const load = async (targetPage = page) => {
    setLoading(true);
    try {
      const query = new URLSearchParams({
        itemType,
        page: String(targetPage),
        pageSize: '20',
      });
      if (keyword.trim()) query.set('keyword', keyword.trim());
      if (status) query.set('status', status);
      setData(await api(`/item-categories?${query}`));
    } catch (error: any) {
      message.error(error.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [itemType, page]);
  useEffect(() => {
    const refresh = () => void load();
    window.addEventListener('inventory:refresh', refresh);
    return () => window.removeEventListener('inventory:refresh', refresh);
  });

  const switchType = (value: string) => {
    setPage(1);
    setKeyword('');
    setStatus(undefined);
    setSearchParams({ itemType: value });
  };
  const applyFilters = () => page === 1 ? void load(1) : setPage(1);
  const resetFilters = () => {
    setKeyword('');
    setStatus(undefined);
    setPage(1);
    queueMicrotask(() => void load(1));
  };
  const showCreate = () => {
    setEditing(undefined);
    form.resetFields();
    form.setFieldsValue({ itemType, sortOrder: 0 });
    setOpen(true);
  };
  const showEdit = (record: any) => {
    setEditing(record);
    form.setFieldsValue(record);
    setOpen(true);
  };
  const save = async (values: any) => {
    setSaving(true);
    try {
      const body = editing
        ? { code: values.code, name: values.name, sortOrder: values.sortOrder, status: values.status }
        : { code: values.code, name: values.name, itemType, sortOrder: values.sortOrder };
      await api(editing ? `/item-categories/${editing.id}` : '/item-categories', {
        method: editing ? 'PATCH' : 'POST',
        body: JSON.stringify(body),
      });
      message.success('物料分类已保存');
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
      await api(`/item-categories/${record.id}`, { method: 'DELETE' });
      message.success('物料分类已删除');
      if (data.items.length === 1 && page > 1) setPage(page - 1);
      else await load();
    } catch (error: any) {
      message.error(error.message);
    }
  };

  const columns: any[] = [
    { title: '编码', dataIndex: 'code' },
    { title: '名称', dataIndex: 'name' },
    { title: '物料类型', dataIndex: 'itemType', render: (value: MaterialType) => typeLabels[value] || value },
    { title: '引用物料数', dataIndex: 'itemCount', align: 'right' },
    { title: '排序', dataIndex: 'sortOrder', align: 'right' },
    { title: '状态', dataIndex: 'status', render: (value: string) => <StatusTag value={value} /> },
    { title: '更新时间', dataIndex: 'updatedAt', render: formatBeijingTime },
    {
      title: '操作',
      width: manageable ? 180 : 80,
      render: (_: unknown, record: any) => (
        <Space wrap>
          {manageable && <Button type="link" icon={<EditOutlined />} onClick={() => showEdit(record)}>编辑</Button>}
          {deletable && <Popconfirm
            title={record.itemCount ? `删除后 ${record.itemCount} 个关联物料将显示为“未分类”，确认继续？` : '确认删除该物料分类？'}
            onConfirm={() => remove(record)}
          >
            <Button type="link" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>}
          {!manageable && <Button type="link" onClick={() => showEdit(record)}>查看</Button>}
        </Space>
      ),
    },
  ];

  return (
    <PageScaffold
      title="物料分类"
      subtitle="分类按原材料、半成品和成品严格隔离；分类编码、名称、排序和状态均可维护。"
      extra={manageable ? <Button type="primary" icon={<PlusOutlined />} onClick={showCreate}>新增{typeLabels[itemType]}分类</Button> : undefined}
    >
      <Tabs
        activeKey={itemType}
        onChange={switchType}
        items={Object.entries(typeLabels).map(([key, label]) => ({ key, label }))}
      />
      <div className="toolbar material-filter-bar">
        <Space wrap>
          <Input.Search
            allowClear
            value={keyword}
            placeholder="分类编码或名称"
            onChange={event => setKeyword(event.target.value)}
            onSearch={applyFilters}
            style={{ width: 260 }}
          />
          <Select
            allowClear
            value={status}
            placeholder="状态"
            onChange={setStatus}
            style={{ width: 130 }}
            options={[{ value: 'ACTIVE', label: '启用' }, { value: 'INACTIVE', label: '停用' }]}
          />
        </Space>
        <Space><Button onClick={resetFilters}>重置</Button><Button type="primary" onClick={applyFilters}>查询</Button></Space>
      </div>
      <Table rowKey="id" dataSource={data.items} columns={columns} loading={loading} pagination={false} scroll={{ x: 1000 }} />
      <div className="material-pagination">
        <Pagination current={page} pageSize={20} total={data.total || 0} showSizeChanger={false} onChange={setPage} showTotal={total => `共 ${total} 条`} />
      </div>
      <Modal
        title={`${editing ? '编辑' : '新增'}${typeLabels[itemType]}分类`}
        open={open}
        confirmLoading={saving}
        okButtonProps={{ style: manageable ? undefined : { display: 'none' } }}
        cancelText={manageable ? '取消' : '关闭'}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={save}>
          <Form.Item label="分类类型" name="itemType"><Select disabled options={Object.entries(typeLabels).map(([value, label]) => ({ value, label }))} /></Form.Item>
          <Form.Item label="分类编码" name="code" rules={[{ required: !editing }, { pattern: /^[A-Za-z0-9][A-Za-z0-9-]{0,49}$/, message: '仅允许字母、数字和横线' }]}>
            <Input disabled={!manageable} onInput={event => { event.currentTarget.value = event.currentTarget.value.toUpperCase(); }} />
          </Form.Item>
          <Form.Item label="分类名称" name="name" rules={[{ required: true }, { max: 100 }]}>
            <Input disabled={!manageable} />
          </Form.Item>
          <Form.Item label="排序" name="sortOrder" rules={[{ required: true }]}>
            <InputNumber min={0} max={9999} precision={0} style={{ width: '100%' }} disabled={!manageable} />
          </Form.Item>
          {editing && <Form.Item label="状态" name="status">
            <Select
              disabled={!manageable}
              options={[{ value: 'ACTIVE', label: '启用' }, { value: 'INACTIVE', label: '停用' }]}
            />
          </Form.Item>}
        </Form>
      </Modal>
    </PageScaffold>
  );
}
