/** Geometry helpers for the lightweight hand-drawn SVG charts. */

const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
export const plotValue = (row: object, key: string) => finite((row as Record<string, unknown>)[key]);

const STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 10];
// A fixed domain keeps its edges, so its grid sticks to steps that read as round numbers.
const FIXED_STEPS = [1, 2, 2.5, 5, 10];
function niceStep(span: number, count: number, steps = STEPS) {
  const raw = span / Math.max(1, count - 1);
  const power = 10 ** Math.floor(Math.log10(raw));
  return steps.find(step => step * power >= raw * (1 - 1e-9))! * power;
}
const clean = (value: number) => Number(value.toPrecision(12));

/**
 * Widen a data range to readable tick boundaries and list those ticks with one shared step,
 * so the outermost ticks sit on the plot edges. A flat range gets a small pad and one tick.
 */
export function niceAxis(min: number, max: number, count = 5): { domain: [number, number]; ticks: number[] } {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { domain: [0, 1], ticks: [] };
  if (!(max > min)) { const pad = Math.max(Math.abs(min) * 0.05, 1e-9); return { domain: [min - pad, max + pad], ticks: [min] }; }
  const step = niceStep(max - min, count), first = Math.floor(min / step + 1e-9), last = Math.ceil(max / step - 1e-9);
  return { domain: [clean(first * step), clean(last * step)], ticks: Array.from({ length: last - first + 1 }, (_, index) => clean((first + index) * step)) };
}

/** Keep an explicit domain as given and list the round ticks that fall inside it. */
export function fixedAxis(min: number, max: number, count = 5): { domain: [number, number]; ticks: number[] } {
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) return niceAxis(min, max, count);
  const step = niceStep(max - min, count, FIXED_STEPS), first = Math.ceil(min / step - 1e-9), last = Math.floor(max / step + 1e-9);
  return { domain: [min, max], ticks: Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => clean((first + index) * step)) };
}

type Scale = (value: number) => number;
const point = (x: number, y: number) => `${x.toFixed(1)},${y.toFixed(1)}`;

/** Missing values start a new subpath; an isolated value still draws a zero-length round segment. */
export function linePath(rows: readonly ({ time: number })[], key: string, x: Scale, y: Scale) {
  let path = "", connected = false;
  for (const row of rows) {
    const value = plotValue(row, key);
    if (value === null) { connected = false; continue; }
    const at = point(x(row.time), y(value));
    path += connected ? `L${at}` : `M${at}L${at}`;
    connected = true;
  }
  return path;
}

/** Closed polygons between `upper` and `lower` (a key or a constant baseline) for each unbroken run. */
export function bandPath(rows: readonly ({ time: number })[], upper: string, lower: string | number, x: Scale, y: Scale) {
  let path = "", run: { time: number; high: number; low: number }[] = [];
  const flush = () => {
    if (run.length) {
      const lower: string[] = [];
      for (let index = run.length - 1; index >= 0; index--) lower.push(point(x(run[index].time), y(run[index].low)));
      path += `M${run.map(item => point(x(item.time), y(item.high))).join("L")}L${lower.join("L")}Z`;
    }
    run = [];
  };
  for (const row of rows) {
    const high = plotValue(row, upper), low = typeof lower === "number" ? lower : plotValue(row, lower);
    if (high === null || low === null) flush(); else run.push({ time: row.time, high, low });
  }
  flush();
  return path;
}

/** One zero-length segment per value; a round cap of width 2r draws every dot in a single path. */
export function dotsPath(rows: readonly ({ time: number })[], key: string, x: Scale, y: Scale) {
  let path = "";
  for (const row of rows) {
    const value = plotValue(row, key);
    if (value !== null) { const at = point(x(row.time), y(value)); path += `M${at}L${at}`; }
  }
  return path;
}
