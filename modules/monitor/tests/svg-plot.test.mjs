import test from "node:test";
import assert from "node:assert/strict";
import { bandPath, dotsPath, fixedAxis, linePath, niceAxis } from "../lib/svg-plot.ts";

const x = time => time, y = value => -value;

test("niceAxis widens to tick boundaries with the step chosen for the data span", () => {
  assert.deepEqual(niceAxis(-10, 25), { domain: [-10, 30], ticks: [-10, 0, 10, 20, 30] });
  assert.deepEqual(niceAxis(-3, 3), { domain: [-3, 3], ticks: [-3, -1.5, 0, 1.5, 3] });
  // The widened span must not pick a coarser step than the data span did.
  assert.deepEqual(niceAxis(-3, 6), { domain: [-5, 7.5], ticks: [-5, -2.5, 0, 2.5, 5, 7.5] });
  assert.deepEqual(niceAxis(101.3, 118.9), { domain: [100, 120], ticks: [100, 105, 110, 115, 120] });
  assert.deepEqual(niceAxis(-0.00001, 0.00003).ticks, [-0.00001, 0, 0.00001, 0.00002, 0.00003]);
  const flat = niceAxis(50, 50);
  assert.ok(flat.domain[0] < 50 && flat.domain[1] > 50);
  assert.deepEqual(flat.ticks, [50]);
  assert.deepEqual(niceAxis(Infinity, -Infinity), { domain: [0, 1], ticks: [] });
});

test("fixedAxis keeps an explicit domain and puts round ticks inside it", () => {
  assert.deepEqual(fixedAxis(-5, 10), { domain: [-5, 10], ticks: [-5, 0, 5, 10] });
  assert.deepEqual(fixedAxis(-10, 25), { domain: [-10, 25], ticks: [-10, 0, 10, 20] });
  assert.deepEqual(fixedAxis(-3, 4), { domain: [-3, 4], ticks: [-2, 0, 2, 4] });
  assert.deepEqual(fixedAxis(0, 5), { domain: [0, 5], ticks: [0, 2, 4] });
  assert.deepEqual(fixedAxis(2, 2), niceAxis(2, 2));
});

test("linePath breaks at missing values and keeps isolated points visible", () => {
  const rows = [{ time: 0, v: 1 }, { time: 1, v: 2 }, { time: 2, v: null }, { time: 3, v: 4 }, { time: 4 }];
  assert.equal(linePath(rows, "v", x, y), "M0.0,-1.0L0.0,-1.0L1.0,-2.0M3.0,-4.0L3.0,-4.0");
});

test("bandPath closes one polygon per unbroken run, against a key or a constant", () => {
  const rows = [{ time: 0, hi: 2, lo: 1 }, { time: 1, hi: 3, lo: 1 }, { time: 2, hi: null, lo: 0 }, { time: 3, hi: 5, lo: 4 }];
  assert.equal(bandPath(rows, "hi", "lo", x, y), "M0.0,-2.0L1.0,-3.0L1.0,-1.0L0.0,-1.0ZM3.0,-5.0L3.0,-4.0Z");
  assert.equal(bandPath(rows.slice(0, 2), "hi", 0, x, y), "M0.0,-2.0L1.0,-3.0L1.0,0.0L0.0,0.0Z");
});

test("dotsPath draws a dot per present value", () => {
  assert.equal(dotsPath([{ time: 0, v: 1 }, { time: 1, v: null }, { time: 2, v: 3 }], "v", x, y), "M0.0,-1.0L0.0,-1.0M2.0,-3.0L2.0,-3.0");
});
