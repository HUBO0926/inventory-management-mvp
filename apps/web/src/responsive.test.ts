import { describe, expect, it } from 'vitest';
import { isMobileWidth, MOBILE_BREAKPOINT } from './responsive';

describe('移动端断点', () => {
  it('在 768px 以下启用手机布局', () => {
    expect(isMobileWidth(360)).toBe(true);
    expect(isMobileWidth(767)).toBe(true);
    expect(isMobileWidth(MOBILE_BREAKPOINT)).toBe(false);
    expect(isMobileWidth(1366)).toBe(false);
  });
});
