import { useEffect, useState, type ReactNode } from 'react';
import { Empty, Pagination, Spin, Table as AntTable } from 'antd';

export const MOBILE_BREAKPOINT = 768;
export const isMobileWidth = (width: number) => width < MOBILE_BREAKPOINT;

export function useIsMobile() {
  const query = `(max-width:${MOBILE_BREAKPOINT - 1}px)`;
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);
  return mobile;
}

function fieldValue(record: any, dataIndex: string | string[] | undefined) {
  if (!dataIndex) return undefined;
  return (Array.isArray(dataIndex) ? dataIndex : [dataIndex]).reduce((value, key) => value?.[key], record);
}

function columnLabel(title: ReactNode) {
  return typeof title === 'string' || typeof title === 'number' ? title : '';
}

export function ResponsiveTable({ mobile: mobileOverride, ...props }: any) {
  const detectedMobile = useIsMobile();
  const mobile = mobileOverride ?? detectedMobile;
  const [page, setPage] = useState(1);
  if (!mobile) return <AntTable {...props} />;

  const dataSource = props.dataSource || [];
  const columns = props.columns || [];
  const pagination = props.pagination === false ? false : (typeof props.pagination === 'object' ? props.pagination : {});
  const pageSize = pagination === false ? dataSource.length || 1 : pagination.pageSize || 10;
  const current = pagination === false ? 1 : Math.min(page, Math.max(1, Math.ceil(dataSource.length / pageSize)));
  const rows = pagination === false ? dataSource : dataSource.slice((current - 1) * pageSize, current * pageSize);
  const keyOf = (record: any, index: number) => typeof props.rowKey === 'function' ? props.rowKey(record) : record[props.rowKey || 'key'] || index;

  if (props.loading) return <div className="mobile-list-state"><Spin /></div>;
  if (!dataSource.length) return <div className="mobile-list-state">{props.locale?.emptyText || <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" />}</div>;

  return (
    <div className="mobile-data-view">
      <div className="mobile-record-list">
        {rows.map((record: any, rowIndex: number) => {
          const cells = columns.map((column: any) => {
            const value = fieldValue(record, column.dataIndex);
            return { label: columnLabel(column.title), content: column.render ? column.render(value, record, rowIndex) : value };
          });
          const action = cells.find((cell: any) => cell.label === '操作');
          const status = cells.find((cell: any) => cell.label === '状态' || cell.label === '库存状态' || cell.label === '风险');
          const primary = cells.find((cell: any) => !['操作', '状态', '库存状态', '风险'].includes(cell.label)) || cells[0];
          const details = cells.filter((cell: any) => cell !== primary && cell !== action && cell !== status && cell.content !== undefined && cell.content !== null && cell.content !== '');
          return (
            <article className="mobile-record-card" key={keyOf(record, rowIndex)}>
              <header className="mobile-record-head"><div>{primary?.content}</div>{status?.content ? <div>{status.content}</div> : null}</header>
              {details.length ? <div className="mobile-record-body">{details.map((cell: any, index: number) => <div className="mobile-record-field" key={`${cell.label}-${index}`}><span>{cell.label}</span><div>{cell.content}</div></div>)}</div> : null}
              {action?.content ? <footer className="mobile-record-actions">{action.content}</footer> : null}
            </article>
          );
        })}
      </div>
      {pagination !== false && dataSource.length > pageSize ? <Pagination size="small" current={current} pageSize={pageSize} total={dataSource.length} showSizeChanger={false} onChange={setPage} /> : null}
    </div>
  );
}
