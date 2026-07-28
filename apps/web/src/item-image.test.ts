import { describe, expect, it } from 'vitest';
import { calculateItemImageSize, formatFileSize, validateItemImage } from './item-image';

describe('物料图片压缩规则', () => {
  it('将大图按比例限制在1600像素内且不放大小图', () => {
    expect(calculateItemImageSize(3200, 2400)).toEqual({ width: 1600, height: 1200 });
    expect(calculateItemImageSize(600, 400)).toEqual({ width: 600, height: 400 });
  });

  it('拒绝不支持格式和超过10MB的文件', () => {
    expect(() => validateItemImage({ type: 'text/plain', size: 10 } as File)).toThrow('仅支持');
    expect(() => validateItemImage({ type: 'image/png', size: 10 * 1024 * 1024 + 1 } as File)).toThrow('10MB');
  });

  it('格式化压缩前后大小', () => {
    expect(formatFileSize(426 * 1024)).toBe('426 KB');
    expect(formatFileSize(3.8 * 1024 * 1024)).toBe('3.8 MB');
  });
});
