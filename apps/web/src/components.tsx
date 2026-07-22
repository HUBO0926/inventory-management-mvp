import type { ComponentType, ReactNode } from 'react';
import { Card, Empty, Tag, Typography } from 'antd';
import { statusText } from './domain';

const { Title, Text } = Typography;

export function PageScaffold({
  title,
  subtitle,
  extra,
  children,
  bare = false,
}: {
  title: string;
  subtitle?: string;
  extra?: ReactNode;
  children: ReactNode;
  bare?: boolean;
}) {
  return (
    <main className="page">
      <div className="page-heading">
        <div>
          <Title level={3}>{title}</Title>
          {subtitle && <Text type="secondary">{subtitle}</Text>}
        </div>
        {extra && <div className="page-heading-extra">{extra}</div>}
      </div>
      {bare ? children : <Card className="content-card">{children}</Card>}
    </main>
  );
}

export function StatusTag({ value }: { value: string }) {
  const tone = ['ACTIVE', 'POSTED', 'COMPLETED'].includes(value)
    ? 'success'
    : ['DRAFT', 'RELEASED'].includes(value)
      ? 'processing'
      : ['VOIDED', 'CANCELLED', 'INACTIVE'].includes(value)
        ? 'default'
        : 'warning';
  return <Tag color={tone}>{statusText[value] || value}</Tag>;
}

export function MetricCard({
  label,
  value,
  helper,
  tone = 'primary',
  icon: Icon,
}: {
  label: string;
  value: number;
  helper: string;
  tone?: 'primary' | 'success' | 'warning' | 'danger' | 'purple';
  icon: ComponentType;
}) {
  return (
    <Card className={`metric-card metric-card-${tone}`}>
      <div className="metric-card-head">
        <span>{label}</span>
        <span className="metric-icon"><Icon /></span>
      </div>
      <div className="metric-value">{value}</div>
      <Text type="secondary" className="metric-helper">{helper}</Text>
    </Card>
  );
}

export function SectionCard({
  title,
  subtitle,
  extra,
  children,
  className = '',
}: {
  title: string;
  subtitle?: string;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={`section-card ${className}`}>
      <div className="section-card-head">
        <div>
          <Title level={5}>{title}</Title>
          {subtitle && <Text type="secondary">{subtitle}</Text>}
        </div>
        {extra}
      </div>
      {children}
    </Card>
  );
}

export function ChartEmpty({ description = '暂无可展示的数据' }: { description?: string }) {
  return <Empty className="chart-empty" image={Empty.PRESENTED_IMAGE_SIMPLE} description={description} />;
}
