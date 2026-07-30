import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength } from 'class-validator';

export const DECIMAL_PATTERN = /^(?:0|[1-9]\d{0,17})$/;
export const POSITIVE_DECIMAL_PATTERN = /^[1-9]\d{0,17}$/;

export function IsQuantity(allowZero = false) {
  return applyDecorators(
    Transform(({ value }) => value === undefined || value === null ? value : String(value)),
    IsString(),
    Matches(allowZero ? DECIMAL_PATTERN : POSITIVE_DECIMAL_PATTERN, { message: allowZero ? '数量必须是大于等于 0 的整数' : '数量必须是大于 0 的整数' }),
    MaxLength(19),
  );
}

export function parsePage(value: unknown, fallback: number, max?: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return max ? Math.min(parsed, max) : parsed;
}
