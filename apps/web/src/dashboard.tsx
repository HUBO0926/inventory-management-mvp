import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Segmented, Space, Tag, Typography, message } from 'antd';
import {
  AlertOutlined,
  AppstoreOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  DatabaseOutlined,
  InboxOutlined,
  ImportOutlined,
  PlusCircleOutlined,
  ReloadOutlined,
  SendOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import { Link } from 'react-router-dom';
import type { User } from './App';
import { api } from './api';
import { EChart } from './chart';
import { ChartEmpty, MetricCard, PageScaffold, SectionCard } from './components';
import { movementDocumentTotal, quickActionsForRole } from './dashboard-model';
import { formatQuantity, statusText } from './domain';
import { ResponsiveTable as Table, useIsMobile } from './responsive';

const { Text } = Typography;
const qty = formatQuantity;
const chartColors = { primary: '#1677ff', success: '#16a34a', warning: '#f59e0b', danger: '#dc2626', purple: '#7c3aed' };

type Cockpit = {
  kpis: {
    materialSkuCount: number;
    finishedGoodSkuCount: number;
    inventoryRiskSkuCount: number;
    activeProductionOrderCount: number;
    todayPostedDocumentCount: number;
  };
  inventoryHealth: any[];
  movementTrend: any[];
  productionStatus: any[];
  riskItems: any[];
  recentTransactions: any[];
};

const roleCopy: Record<User['role'], { title: string; subtitle: string }> = {
  ADMIN: { title: '库存运营驾驶舱', subtitle: '从库存健康、生产进度到近期流动，掌握全局运营状态。' },
  WAREHOUSE: { title: '仓库作业驾驶舱', subtitle: '优先关注库存风险、今日单据和最近库存变化。' },
  PRODUCTION: { title: '生产协同驾驶舱', subtitle: '聚焦生产任务、材料保障和完工进度。' },
};

function QuickActions({ role }: { role: User['role'] }) {
  const iconMap = { inbound: InboxOutlined, finishedInbound: ImportOutlined, outbound: SendOutlined, production: ToolOutlined, inventory: DatabaseOutlined, transactions: ClockCircleOutlined };
  const actions = quickActionsForRole(role);
  return (
    <div className="quick-actions">
      {actions.map(({ to, label, description, icon }) => {
        const Icon = iconMap[icon];
        return (
        <Link className="quick-action" to={to} key={to}>
          <span className="quick-action-icon"><Icon /></span>
          <span><strong>{label}</strong><small>{description}</small></span>
        </Link>
        );
      })}
    </div>
  );
}

export function DashboardPage({ user }: { user: User }) {
  const mobile = useIsMobile();
  const [days, setDays] = useState(14);
  const [data, setData] = useState<Cockpit>();
  const [loading, setLoading] = useState(true);
  const [refreshedAt, setRefreshedAt] = useState<Date>();
  const copy = roleCopy[user.role];

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      setData(await api(`/dashboard/cockpit?days=${days}`));
      setRefreshedAt(new Date());
    } catch (error: any) {
      message.error(error.message || '驾驶舱加载失败');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [days]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const refresh = () => void load(true);
    window.addEventListener('inventory:refresh', refresh);
    const timer = window.setInterval(() => { if (!document.hidden) refresh(); }, 60_000);
    return () => { window.removeEventListener('inventory:refresh', refresh); window.clearInterval(timer); };
  }, [load]);

  const healthOption = useMemo(() => ({
    color: [chartColors.success, chartColors.warning, chartColors.danger],
    tooltip: { trigger: 'axis' as const, axisPointer: { type: 'shadow' as const } },
    legend: { type: mobile ? 'scroll' as const : 'plain' as const, bottom: 0, icon: 'circle', itemWidth: 8, textStyle: { color: '#667085' } },
    grid: { left: mobile ? 12 : 28, right: mobile ? 8 : 18, top: 22, bottom: 46, containLabel: true },
    xAxis: { type: 'category' as const, data: data?.inventoryHealth.map(x => x.warehouseCode) || [], axisTick: { show: false }, axisLine: { lineStyle: { color: '#d9e1ec' } } },
    yAxis: { type: 'value' as const, minInterval: 1, splitLine: { lineStyle: { color: '#edf1f7' } } },
    series: [
      { name: '库存正常', type: 'bar' as const, stack: 'health', barMaxWidth: 46, data: data?.inventoryHealth.map(x => x.healthySkuCount) || [] },
      { name: '低库存', type: 'bar' as const, stack: 'health', data: data?.inventoryHealth.map(x => x.lowSkuCount) || [] },
      { name: '零库存', type: 'bar' as const, stack: 'health', data: data?.inventoryHealth.map(x => x.zeroSkuCount) || [], itemStyle: { borderRadius: [5, 5, 0, 0] } },
    ],
  }), [data, mobile]);

  const movementOption = useMemo(() => ({
    color: [chartColors.primary, '#0f766e', chartColors.purple, chartColors.success, chartColors.danger],
    tooltip: { trigger: 'axis' as const },
    legend: { type: mobile ? 'scroll' as const : 'plain' as const, bottom: 0, icon: 'circle', itemWidth: 8, textStyle: { color: '#667085' } },
    grid: { left: mobile ? 10 : 28, right: mobile ? 8 : 18, top: 22, bottom: 52, containLabel: true },
    xAxis: { type: 'category' as const, boundaryGap: false, data: data?.movementTrend.map(x => x.date.slice(5)) || [], axisLabel: { interval: mobile ? 2 : 0 }, axisTick: { show: false }, axisLine: { lineStyle: { color: '#d9e1ec' } } },
    yAxis: { type: 'value' as const, minInterval: 1, splitLine: { lineStyle: { color: '#edf1f7' } } },
    series: [
      { name: '原料入库', type: 'line' as const, smooth: true, symbol: 'circle', symbolSize: 5, data: data?.movementTrend.map(x => x.inboundDocumentCount) || [], areaStyle: { opacity: 0.06 } },
      { name: '成品入库', type: 'line' as const, smooth: true, symbol: 'circle', symbolSize: 5, data: data?.movementTrend.map(x => x.finishedInboundDocumentCount) || [] },
      { name: '成品出库', type: 'line' as const, smooth: true, symbol: 'circle', symbolSize: 5, data: data?.movementTrend.map(x => x.outboundDocumentCount) || [] },
      { name: '生产业务', type: 'line' as const, smooth: true, symbol: 'circle', symbolSize: 5, data: data?.movementTrend.map(x => x.productionDocumentCount) || [] },
      { name: '冲销', type: 'line' as const, smooth: true, symbol: 'circle', symbolSize: 5, lineStyle: { type: 'dashed' as const }, data: data?.movementTrend.map(x => x.reversalDocumentCount) || [] },
    ],
  }), [data, mobile]);

  const productionOption = useMemo(() => ({
    color: ['#94a3b8', chartColors.primary, chartColors.warning, chartColors.success, '#cbd5e1'],
    tooltip: { trigger: 'item' as const },
    legend: { type: mobile ? 'scroll' as const : 'plain' as const, bottom: 0, icon: 'circle', itemWidth: 8, textStyle: { color: '#667085' } },
    series: [{
      type: 'pie' as const,
      radius: ['50%', '72%'],
      center: ['50%', mobile ? '42%' : '44%'],
      label: { show: false },
      itemStyle: { borderColor: '#fff', borderWidth: 3, borderRadius: 5 },
      data: data?.productionStatus.map(x => ({ name: statusText[x.status] || x.status, value: x.count })) || [],
    }],
  }), [data, mobile]);

  const movementTotal = movementDocumentTotal(data?.movementTrend);
  const productionTotal = data?.productionStatus.reduce((sum, row) => sum + row.count, 0) || 0;

  return (
    <PageScaffold
      title={copy.title}
      subtitle={copy.subtitle}
      bare
      extra={<Space><Text type="secondary">{refreshedAt ? `更新于 ${refreshedAt.toLocaleTimeString('zh-CN', { hour12: false })}` : '正在更新'}</Text><Button icon={<ReloadOutlined />} onClick={() => load()} loading={loading}>刷新</Button></Space>}
    >
      <div className="cockpit">
        {data?.kpis.inventoryRiskSkuCount ? <Alert className="cockpit-alert" type="warning" showIcon message={`当前有 ${data.kpis.inventoryRiskSkuCount} 个物料需要关注`} description="包含零库存及达到最低库存线的物料，请结合生产计划及时处理。" /> : null}
        <div className="metric-grid">
          <MetricCard label="原材料 SKU" value={data?.kpis.materialSkuCount || 0} helper="启用中的原材料" icon={AppstoreOutlined} />
          <MetricCard label="成品 SKU" value={data?.kpis.finishedGoodSkuCount || 0} helper="启用中的成品" tone="purple" icon={CheckCircleOutlined} />
          <MetricCard label="库存风险" value={data?.kpis.inventoryRiskSkuCount || 0} helper="零库存与低库存" tone={data?.kpis.inventoryRiskSkuCount ? 'danger' : 'success'} icon={AlertOutlined} />
          <MetricCard label="进行中任务" value={data?.kpis.activeProductionOrderCount || 0} helper="已发布及生产中" tone="warning" icon={ToolOutlined} />
          <MetricCard label="今日过账" value={data?.kpis.todayPostedDocumentCount || 0} helper="今日库存业务单据" tone="success" icon={PlusCircleOutlined} />
        </div>

        <SectionCard title="快捷操作" subtitle="进入当前角色最常用的业务流程"><QuickActions role={user.role} /></SectionCard>

        <div className="chart-grid chart-grid-primary">
          <SectionCard title="库存流动趋势" subtitle="按业务单据数量统计，不跨单位汇总" extra={<Segmented size="small" value={days} options={[{ label: '7天', value: 7 }, { label: '14天', value: 14 }, { label: '30天', value: 30 }]} onChange={value => setDays(Number(value))} />}>
            {movementTotal ? <EChart option={movementOption} height={mobile ? 250 : 286} /> : <ChartEmpty description="完成入库、领退料、报产或出库后，这里将展示趋势" />}
          </SectionCard>
          <SectionCard title="库存健康度" subtitle="按仓库统计启用物料 SKU 状态">
            <EChart option={healthOption} height={mobile ? 240 : 286} />
          </SectionCard>
        </div>

        <div className="chart-grid chart-grid-secondary">
          <SectionCard title="生产任务状态" subtitle="当前全部生产任务分布">
            {productionTotal ? <EChart option={productionOption} height={mobile ? 230 : 260} /> : <ChartEmpty description="创建生产任务后，这里将展示状态分布" />}
          </SectionCard>
          <SectionCard title="库存风险清单" subtitle="优先处理零库存及低库存物料" extra={<Link to="/inventory">查看全部</Link>}>
            <Table
              rowKey={(row: any) => `${row.warehouseId}-${row.itemId}`}
              size="small"
              pagination={false}
              loading={loading}
              dataSource={data?.riskItems || []}
              scroll={{ x: 520 }}
              columns={[
                { title: '仓库', dataIndex: 'warehouseCode', width: 72 },
                { title: '物料', render: (_, row: any) => <span><strong>{row.itemCode}</strong><small className="table-subtext">{row.itemName}</small></span> },
                { title: '现存', dataIndex: 'onHandQty', align: 'right', render: (value, row: any) => `${qty(value)} ${row.unit}` },
                { title: '最低', dataIndex: 'minimumStock', align: 'right', render: qty },
                { title: '风险', dataIndex: 'riskLevel', align: 'center', render: value => <Tag color={value === 'ZERO' ? 'error' : 'warning'}>{value === 'ZERO' ? '零库存' : '低库存'}</Tag> },
              ]}
              locale={{ emptyText: <ChartEmpty description="当前没有库存风险" /> }}
            />
          </SectionCard>
        </div>

        <SectionCard title="最近库存流水" subtitle="库存变动的最新过账记录" extra={<Link to="/transactions">查看全部流水</Link>}>
          <Table
            rowKey="id"
            pagination={false}
            loading={loading}
            dataSource={data?.recentTransactions || []}
            scroll={{ x: 880 }}
            columns={[
              { title: '过账时间', dataIndex: 'createdAt', width: 168, render: value => new Date(value).toLocaleString() },
              { title: '仓库', dataIndex: 'warehouseCode', width: 72 },
              { title: '物料', render: (_, row: any) => <span><strong>{row.itemCode}</strong><small className="table-subtext">{row.itemName}</small></span> },
              { title: '来源单据', dataIndex: 'documentNo' },
              { title: '业务类型', dataIndex: 'documentType', render: value => statusText[value] || value },
              { title: '变动', dataIndex: 'deltaQty', align: 'right', render: value => <span className={Number(value) >= 0 ? 'positive' : 'negative'}>{Number(value) > 0 ? '+' : ''}{qty(value)}</span> },
              { title: '结余', dataIndex: 'balanceAfter', align: 'right', render: qty },
              { title: '操作人', dataIndex: 'operatorName' },
            ]}
          />
        </SectionCard>
      </div>
    </PageScaffold>
  );
}
