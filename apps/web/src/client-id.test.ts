import { describe, expect, it, vi } from 'vitest';
import { generateClientId } from './client-id';

describe('generateClientId', () => {
  it('uses crypto.randomUUID when supported', () => {
    const spy = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000000');
    expect(generateClientId()).toBe('00000000-0000-4000-8000-000000000000');
    spy.mockRestore();
  });

  it('falls back to unique temporary ids when randomUUID fails', () => {
    const spy = vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(() => { throw new Error('unsupported'); });
    expect(generateClientId()).not.toBe(generateClientId());
    spy.mockRestore();
  });
});
