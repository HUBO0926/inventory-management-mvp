const numberValue = (value: unknown) => Number(value || 0);

export const limitRecentRecords = <T,>(rows: T[]) => rows.slice(0, 8);

export const topMaterialsByUnit = (rows: Array<{ unit?: string; quantity?: unknown }>, unit?: string) => rows
  .filter(row => !unit || row.unit === unit)
  .sort((left, right) => numberValue(right.quantity) - numberValue(left.quantity))
  .slice(0, 10);

export const mapCanvasHeight = (rows: Array<{ y?: unknown; height?: unknown }>, fullscreen = false) => {
  const bottom = rows.reduce((max, row) => Math.max(max, numberValue(row.y) + numberValue(row.height)), 0);
  return Math.max(fullscreen ? 620 : 220, Math.min(fullscreen ? 920 : 520, bottom + 24));
};
