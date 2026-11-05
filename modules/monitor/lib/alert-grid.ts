import { newRuleId, type MonitorAlertAdapter, type MonitorAlertDraft, type MonitorAlertRule } from "./monitor-alerts.ts";

export type AlertGrid = { metric: string; from: number; to: number; step: number; direction: MonitorAlertRule["direction"]; cooldownMinutes: number; hysteresis: number };

export const directionLabels: Record<MonitorAlertRule["direction"], string> = { above: "向上", below: "向下", both: "双向" };

// Digits after the point in the shortest decimal form, including exponent notation such as 1e-9.
function decimalPlaces(value: number) {
  const [mantissa, exponent = "0"] = Math.abs(value).toString().split("e");
  return Math.max(0, (mantissa.split(".")[1]?.length ?? 0) - Number(exponent));
}

const ZERO = BigInt(0);

// Exact integer value × 10^places of a number's shortest decimal form; places must cover its decimals.
function scaled(value: number, places: number) {
  const [mantissa, exponent = "0"] = Math.abs(value).toString().split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  const digits = BigInt(whole + fraction) * BigInt(10) ** BigInt(places + Number(exponent) - fraction.length);
  return value < 0 ? -digits : digits;
}

function unscaled(value: bigint, places: number) {
  const digits = (value < ZERO ? -value : value).toString().padStart(places + 1, "0"), point = digits.length - places;
  return Number(`${value < ZERO ? "-" : ""}${digits.slice(0, point)}.${digits.slice(point) || "0"}`);
}

/** Evenly spaced levels from `from` to `to` inclusive, computed in exact decimal arithmetic so 0.1 or 1e-9 steps never drift. */
export function gridThresholds(from: number, to: number, step: number, limit: number): number[] {
  if (![from, to, step].every(Number.isFinite)) throw new Error("请填写有效的下限、上限和步长。");
  if (step <= 0) throw new Error("步长须大于 0。");
  if (to < from) throw new Error("上限不能小于下限。");
  const places = Math.max(decimalPlaces(from), decimalPlaces(to), decimalPlaces(step));
  if (places > 20) throw new Error("下限、上限或步长的小数位过多，最多支持 20 位小数。");
  const start = scaled(from, places), increment = scaled(step, places), count = (scaled(to, places) - start) / increment + BigInt(1);
  if (count > BigInt(Math.max(0, limit))) throw new Error(`按此范围和步长会生成 ${count} 档，超过剩余可用的 ${Math.max(0, limit)} 档；请增大步长或缩小范围。`);
  const levels = Array.from({ length: Number(count) }, (_, index) => unscaled(start + BigInt(index) * increment, places));
  // A level that a number cannot hold exactly would be saved rounded, so a later restore could not recover this step.
  if (!levels.every((level, index) => decimalPlaces(level) <= places && scaled(level, places) === start + BigInt(index) * increment)) throw new Error("阈值的有效数字过多，无法精确保存；请减少小数位。");
  return levels;
}

// Only an inferred step that regenerates exactly the stored thresholds keeps rule IDs and alert state on the next generation.
function sameLevels(levels: number[], step: number) {
  try {
    const generated = gridThresholds(levels[0], levels[levels.length - 1], step, levels.length);
    return generated.length === levels.length && generated.every((level, index) => level === levels[index]);
  } catch {
    return false;
  }
}

const otherRules = (draft: MonitorAlertDraft, metric: string) => draft.rules.filter(rule => rule.metric !== metric);

export function gridPreview(draft: MonitorAlertDraft, grid: AlertGrid, adapter: MonitorAlertAdapter) {
  return gridThresholds(grid.from, grid.to, grid.step, adapter.maxRules - otherRules(draft, grid.metric).length);
}

/** Reuse evenly spaced tiers already in the draft (a single tier keeps its own level); otherwise start from the monitor's default range. */
export function gridDefaults(draft: MonitorAlertDraft, adapter: MonitorAlertAdapter): AlertGrid {
  const template = adapter.newRule(draft);
  const same = draft.rules.filter(rule => rule.metric === template.metric && Number.isFinite(rule.threshold));
  const levels = [...new Set(same.map(rule => rule.threshold))].sort((left, right) => left - right);
  const places = Math.max(0, ...levels.map(decimalPlaces));
  const step = levels.length === 1 ? adapter.grid.step : levels.length > 1 && places <= 20 ? unscaled(scaled(levels[1], places) - scaled(levels[0], places), places) : 0;
  if (step > 0 && sameLevels(levels, step)) {
    const directions = new Set(same.map(rule => rule.direction));
    return { metric: template.metric, from: levels[0], to: levels[levels.length - 1], step, direction: directions.size === 1 ? same[0].direction : "both", cooldownMinutes: same[0].cooldownMinutes, hysteresis: same[0].hysteresis };
  }
  return { metric: template.metric, ...adapter.grid, direction: "both", cooldownMinutes: template.cooldownMinutes, hysteresis: template.hysteresis };
}

/**
 * Replace the tiers of the chosen metric with one tier per level; tiers of other metrics stay.
 * A level that already has a tier with the same direction keeps its ID, so the server keeps its alert state.
 */
export function applyAlertGrid(draft: MonitorAlertDraft, grid: AlertGrid, adapter: MonitorAlertAdapter): MonitorAlertDraft {
  const metric = adapter.metrics.find(item => item.id === grid.metric);
  if (!metric) throw new Error("请选择监控指标。");
  if (!Number.isFinite(grid.cooldownMinutes) || grid.cooldownMinutes < 0 || grid.cooldownMinutes > adapter.cooldownMax) throw new Error(`冷却须为 0–${adapter.cooldownMax} 分钟。`);
  if (!Number.isFinite(grid.hysteresis) || grid.hysteresis < 0 || grid.hysteresis > adapter.hysteresisMax) throw new Error(`回差须为 0–${adapter.hysteresisMax} ${metric.hysteresisUnit}。`);
  const levels = gridPreview(draft, grid, adapter);
  const outside = levels.find(level => level < metric.min || level > metric.max);
  if (outside !== undefined) throw new Error(`阈值 ${outside} 超出${metric.label}允许的 ${metric.min} 至 ${metric.max}。`);
  const existing = new Map(draft.rules.filter(rule => rule.metric === grid.metric && rule.direction === grid.direction).map(rule => [rule.threshold, rule.id]));
  const unit = metric.unit === "%" ? "%" : ` ${metric.unit}`;
  const rules = levels.map(threshold => ({ id: existing.get(threshold) ?? newRuleId(), name: `${directionLabels[grid.direction]} ${threshold}${unit}`, metric: grid.metric, direction: grid.direction, threshold, cooldownMinutes: grid.cooldownMinutes, hysteresis: grid.hysteresis, enabled: true }));
  return { ...draft, rules: [...otherRules(draft, grid.metric), ...rules] };
}
