import { BusinessException } from './business.exception';

// Production starts in compatibility mode until the old API has drained.
export function batchInboundEnabled() {
  return process.env.BATCH_INBOUND_ENABLED === 'true';
}

export function requireBatchInbound() {
  if (!batchInboundEnabled()) throw new BusinessException('FEATURE_DISABLED', '批量入库功能尚未启用');
}
