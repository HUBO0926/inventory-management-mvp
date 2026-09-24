import { describe, expect, it } from 'vitest';
import { locationActualPosition, locationDisplayName } from './location-name';

describe('location display helpers', () => {
  it('uses the standard code once even when an auto-generated name is identical', () => {
    expect(locationDisplayName({ locationCode: 'CPK-GA-A-01', locationName: 'CPK-GA-A-01' })).toBe('CPK-GA-A-01');
  });

  it('falls back for legacy read models and hides empty physical positions', () => {
    expect(locationDisplayName({ code: 'RAW-A-01' })).toBe('RAW-A-01');
    expect(locationActualPosition({ actualPosition: '未填写' })).toBeUndefined();
    expect(locationActualPosition({ actualPosition: '厂房一层东侧' })).toBe('厂房一层东侧');
  });
});
