import type { User } from './App';

export type QuickAction = { to: string; label: string; description: string; icon: 'inbound' | 'finishedInbound' | 'outbound' | 'production' | 'inventory' | 'transactions' };

export function quickActionsForRole(role: User['role']): QuickAction[] {
  if (role === 'WAREHOUSE') return [
    { to: '/inbound', label: '原材料入库', description: '创建并提交入库单', icon: 'inbound' },
    { to: '/finished-inbound', label: '成品入库', description: '登记非生产来源成品', icon: 'finishedInbound' },
    { to: '/outbound', label: '成品出库', description: '创建并提交出库单', icon: 'outbound' },
    { to: '/inventory', label: '查看库存', description: '查询当前可用库存', icon: 'inventory' },
  ];
  if (role === 'PRODUCTION') return [
    { to: '/production', label: '生产任务', description: '创建、发布与报产', icon: 'production' },
    { to: '/inventory', label: '材料库存', description: '检查原材料可用量', icon: 'inventory' },
    { to: '/transactions', label: '库存流水', description: '追溯领退料记录', icon: 'transactions' },
  ];
  return [
    { to: '/inbound', label: '原材料入库', description: '登记到货并增加库存', icon: 'inbound' },
    { to: '/finished-inbound', label: '成品入库', description: '登记非生产来源成品', icon: 'finishedInbound' },
    { to: '/production', label: '生产任务', description: '跟进领料与完工', icon: 'production' },
    { to: '/outbound', label: '成品出库', description: '安排成品发出', icon: 'outbound' },
  ];
}

export function movementDocumentTotal(rows: any[] = []) {
  return rows.reduce((sum, row) => sum
    + Number(row.inboundDocumentCount || 0)
    + Number(row.finishedInboundDocumentCount || 0)
    + Number(row.outboundDocumentCount || 0)
    + Number(row.productionDocumentCount || 0)
    + Number(row.reversalDocumentCount || 0), 0);
}
