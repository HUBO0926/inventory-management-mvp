import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ResponsiveTable } from './responsive';

describe('手机列表卡片', () => {
  it('将表格字段和业务操作转换为卡片', () => {
    const html = renderToStaticMarkup(<ResponsiveTable mobile rowKey="id" pagination={false} dataSource={[{ id: '1', documentNo: 'FI-001', status: 'DRAFT' }]} columns={[
      { title: '单号', dataIndex: 'documentNo' },
      { title: '状态', dataIndex: 'status' },
      { title: '操作', render: () => <button>提交</button> },
    ]} />);
    expect(html).toContain('mobile-record-card');
    expect(html).toContain('FI-001');
    expect(html).toContain('提交');
    expect(html).not.toContain('ant-table');
  });
});
