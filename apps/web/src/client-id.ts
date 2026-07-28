let sequence = 0;

export function generateClientId(prefix = 'client') {
  const randomUuid = globalThis.crypto?.randomUUID;
  if (typeof randomUuid === 'function') {
    try { return randomUuid.call(globalThis.crypto); } catch { /* compatibility fallback */ }
  }
  sequence = (sequence + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${sequence.toString(36)}`;
}
