/** Shared geometry for the two lightweight gold/oil SVG charts. */
export function chartDomain(values: (number | null)[], reference?: number) {
  let min = Infinity, max = -Infinity;
  for (const value of values) if (value !== null && Number.isFinite(value)) { min = Math.min(min, value); max = Math.max(max, value); }
  if (reference !== undefined && Number.isFinite(reference)) { min = Math.min(min, reference); max = Math.max(max, reference); }
  if (!Number.isFinite(min)) return { min: -1, max: 1 };
  const padding = max === min ? Math.max(Math.abs(min) * 0.03, 0.000001) : (max - min) * 0.08;
  return { min: min - padding, max: max + padding };
}

/** Nulls start a new subpath; isolated observations still produce a visible round dot. */
export function chartPath<T extends { time: number }>(rows: T[], value: (row: T) => number | null, x: (time: number) => number, y: (value: number) => number) {
  let path = '', connected = false;
  for (const row of rows) {
    const reading = value(row);
    if (reading === null || !Number.isFinite(reading)) { connected = false; continue; }
    const point = `${x(row.time).toFixed(2)},${y(reading).toFixed(2)}`;
    path += connected ? `L${point}` : `M${point}L${point}`;
    connected = true;
  }
  return path;
}
