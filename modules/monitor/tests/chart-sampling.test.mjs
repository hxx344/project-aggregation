import assert from "node:assert/strict";
import test from "node:test";
import { sampleChartPoints } from "../lib/chart-sampling.ts";

const HOUR = 3_600_000;
const gap = time => ({ time, value: null, sma: null });

function history(count) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    if (i === 5_000 || i === 12_345) rows.push(gap(i * HOUR - HOUR / 2));
    rows.push({ time: i * HOUR, value: Math.sin(i / 37) + (i === 777 ? 9 : i === 15_432 ? -9 : 0), sma: i < 168 ? null : Math.cos(i / 500) });
  }
  return rows;
}

test("short, keyless or bucketless inputs are returned unchanged", () => {
  const rows = history(1_200);
  assert.equal(sampleChartPoints(rows, ["value"]), rows);
  assert.equal(sampleChartPoints(history(5_000), []).length, 5_000);
  assert.equal(sampleChartPoints(history(5_000), ["value"], 0).length, 5_000);
  assert.deepEqual(sampleChartPoints([], ["value"]), []);
});

test("long inputs keep spikes, endpoints, gap breaks and warmup edges within the budget", () => {
  const rows = history(20_000), before = structuredClone(rows);
  const sampled = sampleChartPoints(rows, ["value", "sma"]);
  assert.deepEqual(rows, before);
  // 300 buckets × (two endpoints + min/max of two series), plus both edges of each break.
  assert.ok(sampled.length <= 300 * 6 + 3 * 4, `sampled ${sampled.length}`);
  assert.ok(sampled.length >= 600);
  const indices = sampled.map(row => rows.indexOf(row));
  assert.ok(indices.every((index, i) => index >= 0 && (!i || index > indices[i - 1])), "ordered subset of the input");
  const kept = new Set(sampled);
  for (const index of [0, rows.length - 1]) assert.ok(kept.has(rows[index]));
  for (const spike of [777, 15_432]) assert.ok(kept.has(rows.find(row => row.time === spike * HOUR)), `spike ${spike}`);
  rows.forEach((row, index) => {
    if (row.value !== null) return;
    assert.ok(kept.has(rows[index - 1]) && kept.has(row) && kept.has(rows[index + 1]), `gap at ${index}`);
  });
  const warm = rows.findIndex(row => row.sma !== null);
  assert.ok(kept.has(rows[warm - 1]) && kept.has(rows[warm]));
  for (const key of ["value", "sma"]) {
    const values = rows.map(row => row[key]).filter(value => value !== null);
    assert.equal(Math.max(...sampled.map(row => row[key] ?? -Infinity)), Math.max(...values));
    assert.equal(Math.min(...sampled.map(row => row[key] ?? Infinity)), Math.min(...values));
  }
});

test("non-finite values count as absent so their edges stay visible", () => {
  const rows = Array.from({ length: 3_000 }, (_, i) => ({ time: i, value: i === 1_500 ? Number.NaN : i % 10 }));
  const sampled = new Set(sampleChartPoints(rows, ["value"]));
  for (const index of [1_499, 1_500, 1_501]) assert.ok(sampled.has(rows[index]), `index ${index}`);
});
