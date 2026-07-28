import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Form,
  Image,
  Input,
  InputNumber,
  message,
  Modal,
  Pagination,
  Popconfirm,
  Row,
  Select,
  Space,
  Spin,
  Tag,
  Upload,
  Typography,
} from 'antd';
import {
  ArrowLeftOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  PictureOutlined,
  PlusOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import type { User } from './App';
import { api, uploadItemImage } from './api';
import { PageScaffold, StatusTag } from './components';
import { formatQuantity } from './domain';
import { compressItemImage, formatFileSize, validateItemImage } from './item-image';
import { ResponsiveTable as Table } from './responsive';

type MaterialType = 'MATERIAL' | 'FINISHED_GOOD';

const typeMeta: Record<MaterialType, { title: string; subtitle: string; createLabel: string; path: string }> = {
  MATERIAL: {
    title: '原材料档案',
    subtitle: '统一管理用于生产组装的各类原材料。',
    createLabel: '新增原材料',
    path: '/materials/raw',
  },
  FINISHED_GOOD: {
    title: '成品档案',
    subtitle: '统一管理生产完成后的成品信息。',
    createLabel: '新增成品',
    path: '/materials/finished',
  },
};

const typeLabel: Record<string, string> = {
  MATERIAL: '原材料',
  RAW_MATERIAL: '原材料',
  FINISHED_GOOD: '成品',
};

const placeholderPhoto = (
  <div className="item-photo-placeholder" aria-label="暂无物料图片">
    <PictureOutlined />
  </div>
);

function ItemPhoto({ src, size = 48, preview = true }: { src?: string; size?: number; preview?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) return <div style={{ width: size, height: size }}>{placeholderPhoto}</div>;
  return (
    <Image
      className="item-photo"
      width={size}
      height={size}
      src={src}
      preview={preview}
      onError={() => setFailed(true)}
    />
  );
}

function can(user: User, permission: string) {
  return user.role === 'ADMIN' || Boolean(user.permissions?.includes(permission));
}

export function MaterialListPage({ type, user }: { type: MaterialType; user: User }) {
  const navigate = useNavigate();
  const meta = typeMeta[type];
  const [data, setData] = useState<any>({ items: [], total: 0 });
  const [categories, setCategories] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState<string>();
  const [categoryId, setCategoryId] = useState<string>();
  const manageable = can(user, 'item.manage');
  const deletable = can(user, 'item.delete');

  const load = async (targetPage = page) => {
    setLoading(true);
    try {
      const query = new URLSearchParams({
        page: String(targetPage),
        pageSize: '20',
        itemType: type,
      });
      if (keyword.trim()) query.set('keyword', keyword.trim());
      if (status) query.set('status', status);
      if (categoryId) query.set('categoryId', categoryId);
      const result = await api(`/items?${query}`);
      setData(result);
    } catch (error: any) {
      message.error(error.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    api(`/item-categories?itemType=${type}&pageSize=100&status=ACTIVE`).then(result => setCategories(result.items)).catch(() => undefined);
  }, [type]);
  useEffect(() => { void load(); }, [page, type]);
  useEffect(() => {
    const refresh = () => void load();
    window.addEventListener('inventory:refresh', refresh);
    return () => window.removeEventListener('inventory:refresh', refresh);
  });

  const applyFilters = () => {
    if (page === 1) void load(1);
    else setPage(1);
  };
  const resetFilters = () => {
    setKeyword('');
    setStatus(undefined);
    setCategoryId(undefined);
    setPage(1);
    queueMicrotask(() => void load(1));
  };
  const toggleStatus = async (record: any) => {
    try {
      await api(`/items/${record.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: record.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }),
      });
      message.success(record.status === 'ACTIVE' ? '物料已停用' : '物料已启用');
      await load();
    } catch (error: any) {
      message.error(error.message);
    }
  };
  const remove = async (record: any) => {
    try {
      await api(`/items/${record.id}/delete`, { method: 'POST' });
      message.success('物料已删除');
      await load();
    } catch (error: any) {
      message.error(error.message);
    }
  };

  const columns: any[] = [
    {
      title: '编码',
      dataIndex: 'itemCode',
      render: (value: string, record: any) => (
        <button className="item-code-link" onClick={() => navigate(`/materials/${record.id}`)}>{value}</button>
      ),
    },
    { title: '图片', dataIndex: 'thumbnailUrl', width: 72, render: (value: string) => <ItemPhoto src={value} /> },
    { title: '名称', dataIndex: 'name' },
    { title: '型号/规格', render: (_: unknown, record: any) => <><div>{record.model || '-'}</div><Typography.Text className="table-subtext">{record.spec || '-'}</Typography.Text></> },
    { title: '分类', dataIndex: 'categoryName', render: (value: string) => value || '未分类' },
    { title: '单位', dataIndex: 'unitName' },
    { title: '当前库存', dataIndex: 'onHandQty', align: 'right', render: formatQuantity },
    { title: '安全库存', dataIndex: 'minimumStock', align: 'right', render: formatQuantity },
    { title: '状态', dataIndex: 'status', render: (value: string) => <StatusTag value={value} /> },
    { title: '创建人', dataIndex: 'createdByName', render: (value: string) => value || '-' },
    { title: '更新时间', dataIndex: 'updatedAt', render: (value: string) => value ? new Date(value).toLocaleString('zh-CN') : '-' },
    {
      title: '操作',
      fixed: 'right',
      width: manageable ? 220 : 80,
      render: (_: unknown, record: any) => (
        <Space wrap>
          <Button type="link" icon={<EyeOutlined />} onClick={() => navigate(`/materials/${record.id}`)}>详情</Button>
          {manageable && <Button type="link" icon={<EditOutlined />} onClick={() => navigate(`/materials/${record.id}/edit`)}>编辑</Button>}
          {manageable && <Popconfirm title={`确认${record.status === 'ACTIVE' ? '停用' : '启用'}该物料？`} onConfirm={() => toggleStatus(record)}>
            <Button type="link">{record.status === 'ACTIVE' ? '停用' : '启用'}</Button>
          </Popconfirm>}
          {deletable && <Popconfirm title="有业务引用时将安全归档并保留历史，确认删除？" onConfirm={() => remove(record)}>
            <Button danger type="link" icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>}
        </Space>
      ),
    },
  ];

  return (
    <PageScaffold
      title={meta.title}
      subtitle={meta.subtitle}
      extra={<Space>
        <Button onClick={() => navigate(`/material-categories?itemType=${type}`)}>{can(user, 'category.manage') ? '管理分类' : '查看分类'}</Button>
        {manageable && <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate(`/materials/new?type=${type}`)}>{meta.createLabel}</Button>}
      </Space>}
    >
      <div className="toolbar material-filter-bar">
        <Space wrap>
          <Input.Search
            allowClear
            value={keyword}
            placeholder="请输入物料编码或名称"
            onChange={event => setKeyword(event.target.value)}
            onSearch={applyFilters}
            style={{ width: 260 }}
          />
          <Select allowClear value={categoryId} placeholder="物料分类" onChange={setCategoryId} style={{ width: 180 }} options={categories.map(row => ({ value: row.id, label: row.name }))} />
          <Select allowClear value={status} placeholder="状态" onChange={setStatus} style={{ width: 130 }} options={[{ value: 'ACTIVE', label: '启用' }, { value: 'INACTIVE', label: '停用' }]} />
        </Space>
        <Space><Button onClick={resetFilters}>重置</Button><Button type="primary" onClick={applyFilters}>查询</Button></Space>
      </div>
      <Table rowKey="id" dataSource={data.items} columns={columns} loading={loading} pagination={false} scroll={{ x: 1500 }} />
      <div className="material-pagination">
        <Pagination current={page} pageSize={20} total={data.total || 0} showSizeChanger={false} onChange={setPage} showTotal={total => `共 ${total} 条`} />
      </div>
    </PageScaffold>
  );
}

function getRequestedType(search: string): MaterialType {
  const value = new URLSearchParams(search).get('type');
  if (value === 'RAW_MATERIAL' || value === 'MATERIAL') return 'MATERIAL';
  if (value === 'SEMI_FINISHED') return 'MATERIAL';
  if (value === 'FINISHED_GOOD') return 'FINISHED_GOOD';
  return 'MATERIAL';
}

export function MaterialFormPage({ user }: { user: User }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { id } = useParams();
  const editing = Boolean(id);
  const requestedType = getRequestedType(location.search);
  const [form] = Form.useForm();
  const [detail, setDetail] = useState<any>();
  const [units, setUnits] = useState<any[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [warehouses, setWarehouses] = useState<any[]>([]);
  const [loading, setLoading] = useState(editing);
  const [saving, setSaving] = useState(false);
  const [compressing, setCompressing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [pendingImage, setPendingImage] = useState<File>();
  const [originalSize, setOriginalSize] = useState<number>();
  const manageable = can(user, 'item.manage');
  const identityManageable = can(user, 'item.identity.manage');

  const pendingPreview = useMemo(() => pendingImage ? URL.createObjectURL(pendingImage) : undefined, [pendingImage]);
  useEffect(() => () => { if (pendingPreview) URL.revokeObjectURL(pendingPreview); }, [pendingPreview]);

  const loadDetail = async () => {
    if (!id) return;
    const item = await api(`/items/${id}`);
    setDetail(item);
    form.setFieldsValue({
      itemCode: item.itemCode,
      name: item.name,
      itemType: item.itemType,
      brand: item.brand,
      model: item.model,
      spec: item.spec,
      categoryId: item.categoryId,
      unitId: item.unitId,
      minimumStock: Number(item.minimumStock),
      defaultWarehouseId: item.defaultWarehouseId,
      enableBatch: item.enableBatch,
      status: item.status,
      remark: item.remark,
    });
    return item;
  };
  const loadCategories = async (itemType: MaterialType) => {
    const result = await api(`/item-categories?itemType=${itemType}&pageSize=100`);
    setCategories(result.items);
  };

  useEffect(() => {
    if (!manageable) {
      navigate(id ? `/materials/${id}` : typeMeta[requestedType].path, { replace: true });
      return;
    }
    setLoading(true);
    void (async () => {
      try {
        const [unitRows, warehouseRows, item] = await Promise.all([
          api('/units?pageSize=100&status=ACTIVE'),
          api('/warehouses'),
          id ? loadDetail() : Promise.resolve(undefined),
        ]);
        setUnits(unitRows.items);
        setWarehouses(warehouseRows.filter((row: any) => row.status === 'ACTIVE'));
        const itemType = (item?.itemType || requestedType) as MaterialType;
        await loadCategories(itemType);
        if (!id) form.setFieldsValue({ itemType: requestedType, minimumStock: 0, status: 'ACTIVE', enableBatch: false });
      } catch (error: any) {
        message.error(error.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  const processImage = async (file: File) => {
    try {
      validateItemImage(file);
      setCompressing(true);
      const compressed = await compressItemImage(file);
      setOriginalSize(file.size);
      setPendingImage(compressed);
      if (id) {
        setUploading(true);
        setUploadProgress(0);
        await uploadItemImage(id, compressed, setUploadProgress);
        message.success(`图片已上传：${formatFileSize(file.size)} → ${formatFileSize(compressed.size)}`);
        setPendingImage(undefined);
        await loadDetail();
      }
    } catch (error: any) {
      message.error(error.message);
    } finally {
      setCompressing(false);
      setUploading(false);
    }
    return Upload.LIST_IGNORE;
  };

  const removeImage = async () => {
    if (!id) {
      setPendingImage(undefined);
      setOriginalSize(undefined);
      return;
    }
    try {
      setUploading(true);
      await api(`/items/${id}/image`, { method: 'DELETE' });
      message.success('图片已删除');
      setPendingImage(undefined);
      await loadDetail();
    } catch (error: any) {
      message.error(error.message);
    } finally {
      setUploading(false);
    }
  };

  const save = async (values: any) => {
    const payload: any = {
      name: values.name,
      brand: values.brand || null,
      model: values.model || null,
      spec: values.spec || null,
      categoryId: values.categoryId || null,
      minimumStock: String(values.minimumStock ?? 0),
      defaultWarehouseId: values.defaultWarehouseId || null,
      enableBatch: Boolean(values.enableBatch),
      status: values.status,
      remark: values.remark || null,
    };
    const allowIdentity = !editing || identityManageable;
    if (allowIdentity) {
      payload.itemCode = values.itemCode;
      payload.itemType = values.itemType;
      payload.unitId = values.unitId;
    }
    const identityChanged = editing && allowIdentity && detail && (
      values.itemCode !== detail.itemCode || values.itemType !== detail.itemType || values.unitId !== detail.unitId
    );
    if (identityChanged) {
      const confirmed = await new Promise<boolean>(resolve => Modal.confirm({
        title: '确认修改物料身份字段？',
        content: '编码、类型或单位会影响后续业务识别；历史单据仍通过物料 ID 保持关联。',
        okText: '确认修改',
        cancelText: '取消',
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      }));
      if (!confirmed) return;
    }

    setSaving(true);
    try {
      const item = await api(editing ? `/items/${id}` : '/items', {
        method: editing ? 'PATCH' : 'POST',
        body: JSON.stringify(payload),
      });
      if (!editing && pendingImage) {
        try {
          setUploading(true);
          await uploadItemImage(item.id, pendingImage, setUploadProgress);
          message.success(`物料与图片已保存${originalSize ? `：${formatFileSize(originalSize)} → ${formatFileSize(pendingImage.size)}` : ''}`);
        } catch (error: any) {
          message.warning(`物料已保存，但图片上传失败：${error.message}`);
          navigate(`/materials/${item.id}/edit`, { replace: true });
          return;
        } finally {
          setUploading(false);
        }
      } else {
        message.success('物料已保存');
      }
      navigate(`/materials/${item.id || id}`);
    } catch (error: any) {
      message.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="page-loading"><Spin size="large" /></div>;
  const imageUrl = pendingPreview || detail?.imageUrl;
  const identityLocked = editing && !identityManageable;
  const currentType = detail?.itemType || requestedType;

  return (
    <PageScaffold
      title={editing ? `编辑${typeLabel[currentType] || '物料'}` : typeMeta[requestedType].createLabel}
      subtitle="维护物料基础信息和用于仓库快速识别的单张主图。"
      extra={<Button icon={<ArrowLeftOutlined />} onClick={() => navigate(editing ? `/materials/${id}` : typeMeta[requestedType].path)}>返回</Button>}
    >
      {identityLocked && <Alert className="document-notice" type="warning" showIcon message="当前角色不能修改编码、类型和单位" description="可以继续编辑名称、分类、规格、安全库存等基础资料。" />}
      {!identityLocked && editing && detail?.typeRestrictions?.length > 0 && <Alert className="document-notice" type="info" showIcon message="物料类型受现有业务角色约束" description={detail.typeRestrictions.join('；')} />}
      <Row gutter={[24, 20]}>
        <Col xs={24} md={8} lg={7}>
          <Card className="item-image-card" title="物料主图">
            <div className="item-image-preview">{imageUrl ? <ItemPhoto src={imageUrl} size={240} /> : placeholderPhoto}</div>
            <Upload accept=".jpg,.jpeg,.png,.webp" maxCount={1} showUploadList={false} beforeUpload={processImage} disabled={compressing || uploading}>
              <Button block icon={<UploadOutlined />} loading={compressing || uploading}>{compressing ? '正在压缩图片…' : uploading ? `正在上传 ${uploadProgress}%` : imageUrl ? '替换图片' : '上传图片'}</Button>
            </Upload>
            <Typography.Text type="secondary" className="item-image-hint">JPG / PNG / WebP，原图最大10MB，自动压缩为 WebP。</Typography.Text>
            {pendingImage && !editing && <Alert type="success" showIcon message={`已压缩：${originalSize ? formatFileSize(originalSize) : ''} → ${formatFileSize(pendingImage.size)}`} />}
            {imageUrl && <Popconfirm title="确认删除当前物料图片？" onConfirm={removeImage}><Button block danger type="text" icon={<DeleteOutlined />} disabled={uploading}>删除图片</Button></Popconfirm>}
          </Card>
        </Col>
        <Col xs={24} md={16} lg={17}>
          <Form form={form} layout="vertical" onFinish={save} requiredMark="optional">
            <Card title="基础信息">
              <Row gutter={16}>
                <Col xs={24} md={12}><Form.Item label="物料编码" name="itemCode" rules={[{ required: true }, { pattern: /^[A-Za-z0-9][A-Za-z0-9-]{0,49}$/, message: '仅允许字母、数字和横线' }]}><Input disabled={identityLocked} onInput={event => { const input = event.currentTarget; input.value = input.value.toUpperCase(); }} /></Form.Item></Col>
                <Col xs={24} md={12}><Form.Item label="物料名称" name="name" rules={[{ required: true }, { min: 2, max: 100 }]}><Input /></Form.Item></Col>
                <Col xs={24} md={12}><Form.Item label="物料类型" name="itemType" rules={[{ required: true }]}><Select disabled={!editing || identityLocked} onChange={(value: MaterialType) => { form.setFieldValue('categoryId', undefined); void loadCategories(value); }} options={(detail?.allowedItemTypes || Object.keys(typeMeta)).map((value: string) => ({ value, label: typeLabel[value] }))} /></Form.Item></Col>
                <Col xs={24} md={12}><Form.Item label="计量单位" name="unitId" rules={[{ required: true }]}><Select disabled={identityLocked} showSearch optionFilterProp="label" options={units.map(row => ({ value: row.id, label: `${row.code} ${row.name}` }))} /></Form.Item></Col>
                <Col xs={24} md={12}><Form.Item
                  label={<Space size={4}>物料分类<Button type="link" size="small" onClick={() => window.open(`/material-categories?itemType=${form.getFieldValue('itemType') || currentType}`, '_blank', 'noopener,noreferrer')}>管理分类</Button></Space>}
                  name="categoryId"
                ><Select
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  options={categories.map(row => ({
                    value: row.id,
                    label: `${row.code} ${row.name}${row.status === 'INACTIVE' ? '（已停用）' : ''}`,
                    disabled: row.status === 'INACTIVE' && row.id !== detail?.categoryId,
                  }))}
                /></Form.Item></Col>
                <Col xs={24} md={12}><Form.Item label="安全库存" name="minimumStock" rules={[{ required: true }]}><InputNumber min={0} precision={4} stringMode style={{ width: '100%' }} /></Form.Item></Col>
                <Col xs={24} md={12}><Form.Item label="品牌" name="brand" rules={[{ max: 100 }]}><Input /></Form.Item></Col>
                <Col xs={24} md={12}><Form.Item label="型号" name="model" rules={[{ max: 100 }]}><Input /></Form.Item></Col>
                <Col xs={24}><Form.Item label="规格" name="spec" rules={[{ max: 500 }]}><Input.TextArea rows={3} showCount maxLength={500} /></Form.Item></Col>
                <Col xs={24} md={12}><Form.Item label="默认仓库" name="defaultWarehouseId"><Select allowClear options={warehouses.map(row => ({ value: row.id, label: `${row.warehouseCode} ${row.name}` }))} /></Form.Item></Col>
                <Col xs={24} md={12}><Form.Item label="状态" name="status" rules={[{ required: true }]}><Select options={[{ value: 'ACTIVE', label: '启用' }, { value: 'INACTIVE', label: '停用' }]} /></Form.Item></Col>
                <Col xs={24}><Form.Item label="备注" name="remark" rules={[{ max: 1000 }]}><Input.TextArea rows={3} showCount maxLength={1000} /></Form.Item></Col>
              </Row>
            </Card>
            <div className="form-actions"><Button onClick={() => navigate(editing ? `/materials/${id}` : typeMeta[requestedType].path)}>取消</Button><Button type="primary" htmlType="submit" loading={saving || uploading}>保存</Button></div>
          </Form>
        </Col>
      </Row>
    </PageScaffold>
  );
}

export function MaterialDetailPage({ user }: { user: User }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<any>();
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    api(`/items/${id}`).then(setDetail).catch((error: any) => message.error(error.message)).finally(() => setLoading(false));
  }, [id]);
  if (loading) return <div className="page-loading"><Spin size="large" /></div>;
  if (!detail) return <PageScaffold title="物料详情"><Alert type="error" showIcon message="物料不存在或已删除" /></PageScaffold>;
  const meta = typeMeta[detail.itemType as MaterialType] || typeMeta.MATERIAL;
  const references = detail.references || {};

  return (
    <PageScaffold
      title={`${detail.itemCode} · ${detail.name}`}
      subtitle={`${typeLabel[detail.itemType] || detail.itemType}详情与业务引用情况。`}
      extra={<Space><Button icon={<ArrowLeftOutlined />} onClick={() => navigate(meta.path)}>返回列表</Button>{can(user, 'item.manage') && <Button type="primary" icon={<EditOutlined />} onClick={() => navigate(`/materials/${id}/edit`)}>编辑</Button>}</Space>}
    >
      <Row gutter={[24, 20]}>
        <Col xs={24} md={8} lg={7}><Card className="item-detail-photo"><ItemPhoto src={detail.imageUrl} size={300} /></Card></Col>
        <Col xs={24} md={16} lg={17}>
          <Descriptions bordered column={{ xs: 1, sm: 2 }} size="middle">
            <Descriptions.Item label="编码">{detail.itemCode}</Descriptions.Item>
            <Descriptions.Item label="状态"><StatusTag value={detail.status} /></Descriptions.Item>
            <Descriptions.Item label="类型">{typeLabel[detail.itemType] || detail.itemType}</Descriptions.Item>
            <Descriptions.Item label="分类">{detail.categoryName || '未分类'}</Descriptions.Item>
            <Descriptions.Item label="单位">{detail.unitName || detail.unit}</Descriptions.Item>
            <Descriptions.Item label="当前库存">{formatQuantity(detail.onHandQty)}</Descriptions.Item>
            <Descriptions.Item label="安全库存">{formatQuantity(detail.minimumStock)}</Descriptions.Item>
            <Descriptions.Item label="品牌">{detail.brand || '-'}</Descriptions.Item>
            <Descriptions.Item label="型号">{detail.model || '-'}</Descriptions.Item>
            <Descriptions.Item label="规格" span={2}>{detail.spec || '-'}</Descriptions.Item>
            <Descriptions.Item label="备注" span={2}>{detail.remark || '-'}</Descriptions.Item>
            <Descriptions.Item label="创建人">{detail.createdByName || '-'}</Descriptions.Item>
            <Descriptions.Item label="更新人">{detail.updatedByName || '-'}</Descriptions.Item>
            <Descriptions.Item label="创建时间">{new Date(detail.createdAt).toLocaleString('zh-CN')}</Descriptions.Item>
            <Descriptions.Item label="更新时间">{new Date(detail.updatedAt).toLocaleString('zh-CN')}</Descriptions.Item>
          </Descriptions>
        </Col>
      </Row>
      <Card title="业务引用" className="item-reference-card">
        <Space wrap>
          <Tag>BOM：{references.boms || 0}</Tag>
          <Tag>库存单据：{references.documents || 0}</Tag>
          <Tag>库存余额：{references.balances || 0}</Tag>
          <Tag>库存流水：{references.transactions || 0}</Tag>
          <Tag>生产任务：{references.productionOrders || 0}</Tag>
          <Tag>任务快照：{references.productionSnapshots || 0}</Tag>
        </Space>
        <Alert
          className="item-reference-alert"
          type="info"
          showIcon
          message={detail.typeRestrictions?.length ? detail.typeRestrictions.join('；') : '授权用户可以修改编码、类型和单位'}
        />
      </Card>
    </PageScaffold>
  );
}
