import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applicableNotificationTypes,
  capacityRuleDraft,
  capacityRuleLabel,
  notificationTypes,
  parseCapacityRuleDraft,
} from '../lib/monitoring-notifications.ts';

test('selecting all for a non-strategy symbol cannot submit strategy capacity', () => {
  const selected = applicableNotificationTypes(
    notificationTypes.map((type) => type.key),
    false,
  );
  assert.deepEqual(selected, [
    'new_listing',
    'listing_capacity',
    'trade_summary',
    'position_imbalance',
  ]);
});

test('capacity condition drafts preserve maximum mode and arbitrary integer tiers', () => {
  for (const leverage of [null, 1, 10, 20, 25, 50, 10000]) {
    const rule = {
      listing_capacity_leverage: leverage,
      listing_capacity_threshold: '5000.000000000000000001',
    };
    assert.deepEqual(parseCapacityRuleDraft(capacityRuleDraft(rule)), {
      rule,
      error: null,
    });
  }
  assert.equal(
    capacityRuleLabel({
      listing_capacity_leverage: null,
      listing_capacity_threshold: '0',
    }),
    '最大杠杆 · 公开额度 > 0 USD1',
  );
  assert.equal(
    capacityRuleLabel({
      listing_capacity_leverage: 25,
      listing_capacity_threshold: '5000',
    }),
    '25x · 公开额度 > 5000 USD1',
  );
});

test('threshold parsing preserves decimal precision, zero, and scientific notation', () => {
  for (const threshold of [
    '0',
    '0.000000000000000000001',
    '123456789123456789.123456789123456789',
    '1e100',
    '1e-100',
    '.5',
    '5000.00',
  ]) {
    const result = parseCapacityRuleDraft({
      mode: 'fixed',
      leverage: '20',
      threshold,
    });
    assert.equal(result.error, null, threshold);
    assert.equal(result.rule.listing_capacity_threshold, threshold);
  }
});

test('invalid conditions cannot submit fractional leverage, missing or non-finite amounts', () => {
  for (const leverage of ['', '0', '-1', '1.5', '1e2', '10001', 'NaN']) {
    assert.ok(
      parseCapacityRuleDraft({ mode: 'fixed', leverage, threshold: '0' }).error,
      leverage,
    );
  }
  for (const threshold of [
    '',
    '-1',
    '-0',
    '1_000',
    '１２３',
    'NaN',
    'Infinity',
    '1e101',
    '1e-101',
    '1.01e-99',
    '9'.repeat(129),
    '1,000',
  ]) {
    assert.ok(
      parseCapacityRuleDraft({ mode: 'maximum', leverage: '20', threshold })
        .error,
      threshold,
    );
  }
});

test('strategy symbols and future-symbol defaults retain all five notification types', () => {
  const all = notificationTypes.map((type) => type.key);
  assert.deepEqual(applicableNotificationTypes(all, true), all);
});

test('draft submission preserves empty selection and normalizes duplicates without adding permissions', () => {
  assert.deepEqual(applicableNotificationTypes([], false), []);
  assert.deepEqual(
    applicableNotificationTypes(
      ['trade_summary', 'strategy_capacity', 'trade_summary'],
      false,
    ),
    ['trade_summary'],
  );
});

test('a missing listing prevents a new capacity watch but allows an existing watch to be preserved or cleared', () => {
  const all = notificationTypes.map((type) => type.key);
  assert.equal(
    applicableNotificationTypes(all, true, false).includes('listing_capacity'),
    false,
  );
  assert.equal(
    applicableNotificationTypes(all, true, false, true).includes(
      'listing_capacity',
    ),
    true,
  );
  assert.deepEqual(applicableNotificationTypes([], true, false, true), []);
});
