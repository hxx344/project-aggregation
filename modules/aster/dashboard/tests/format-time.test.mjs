import assert from 'node:assert/strict';
import { test } from 'node:test';
import { utcDate, utcTime } from '../lib/format-time.ts';
const midnight = Date.parse('2026-09-14T00:00:00Z') / 1000;

test('day assignment and reset labels use UTC at midnight, independent of browser local time', () => {
  assert.equal(utcDate(midnight - 0.001), '2026-09-13');
  assert.equal(utcDate(midnight), '2026-09-14');
  assert.equal(utcTime(midnight), '2026-09-14 00:00:00 UTC');
  assert.equal(
    utcDate(Date.parse('2026-09-14T08:00:00+08:00') / 1000),
    '2026-09-14',
  );
  assert.equal(
    utcDate(Date.parse('2026-09-13T17:00:00-07:00') / 1000),
    '2026-09-14',
  );
  for (const timestamp of [NaN, Infinity, -1, undefined, 9e15]) {
    assert.equal(utcDate(timestamp), null);
    assert.equal(utcTime(timestamp), '时间未知');
  }
});
