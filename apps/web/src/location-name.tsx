import { Tooltip, Typography } from 'antd';

/**
 * Read-model shape shared by warehouse, stock-document and inventory APIs.
 * The identifiers remain the source of truth for operations; these fields are
 * deliberately display-only.
 */
export type LocationDisplay = {
  locationDisplayName?: string | null;
  displayName?: string | null;
  locationCode?: string | null;
  code?: string | null;
  locationName?: string | null;
  name?: string | null;
  actualPosition?: string | null;
};

const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';

export function locationDisplayName(location?: LocationDisplay | null) {
  if (!location) return '—';
  return text(location.locationDisplayName) || text(location.displayName) || text(location.locationCode) || text(location.code) || text(location.locationName) || text(location.name) || '—';
}

export function locationActualPosition(location?: LocationDisplay | null) {
  const value = text(location?.actualPosition);
  return value && value !== '未填写' ? value : undefined;
}

type Props = {
  location?: LocationDisplay | null;
  className?: string;
  /** A width is opt-in so compact table cells can truncate without hiding text elsewhere. */
  ellipsis?: boolean;
};

/** Renders the one canonical business label for a warehouse location. */
export function LocationName({ location, className, ellipsis = false }: Props) {
  const name = locationDisplayName(location);
  const actualPosition = locationActualPosition(location);
  const content = <Typography.Text className={className} ellipsis={ellipsis ? { tooltip: false } : false} style={ellipsis ? { display: 'inline-block', maxWidth: '100%', verticalAlign: 'bottom' } : undefined}>{name}</Typography.Text>;
  return actualPosition ? <Tooltip title={`实际位置：${actualPosition}`}>{content}</Tooltip> : content;
}
