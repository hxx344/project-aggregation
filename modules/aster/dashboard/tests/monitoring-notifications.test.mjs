import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applicableNotificationTypes,
  notificationTypes,
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
