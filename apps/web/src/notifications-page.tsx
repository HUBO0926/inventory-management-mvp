import { useEffect, useState } from 'react';
import { Button, Card, List, Space, Tag, Typography, message } from 'antd';
import { useNavigate } from 'react-router-dom';
import { api } from './api';

export function NotificationsPage() {
  const [items, setItems] = useState<any[]>([]);
  const navigate = useNavigate();
  const load = () => api('/notifications?pageSize=100').then(setItems).catch((e: any) => message.error(e.message));
  useEffect(() => { void load(); }, []);
  const read = async (item: any) => {
    try { await api(`/notifications/${item.id}/read`, { method: 'POST' }); if (item.businessId) navigate(`/approvals/${item.businessId}`); await load(); }
    catch (e: any) { message.error(e.message); }
  };
  return <Card title="消息中心" extra={<Button onClick={() => api('/notifications/read-all', { method: 'POST' }).then(load)}>全部已读</Button>}>
    <List dataSource={items} locale={{ emptyText: '暂无消息' }} renderItem={item => <List.Item actions={[!item.isRead && <Button type="link" onClick={() => read(item)}>查看</Button>]}>
      <List.Item.Meta title={<Space>{item.title}{!item.isRead && <Tag color="blue">未读</Tag>}</Space>} description={<><Typography.Text>{item.content}</Typography.Text><br /><Typography.Text type="secondary">{new Date(item.createdAt).toLocaleString('zh-CN')}</Typography.Text></>} />
    </List.Item>} />
  </Card>;
}
