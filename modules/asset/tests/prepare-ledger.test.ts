import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareLedger } from '../scripts/prepare-ledger.mjs';

test('A fresh checkout uses example data without replacing personal imports on later runs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'asset-ledger-test-'));
  try {
    const example = join(directory, 'example.json');
    const target = join(directory, 'imported.json');
    writeFileSync(example, '{"sample":true}');
    assert.equal(prepareLedger(target, example), true);
    assert.equal(readFileSync(target, 'utf8'), '{"sample":true}');
    writeFileSync(target, '{"personal":"preserve"}');
    assert.equal(prepareLedger(target, example), false);
    assert.equal(readFileSync(target, 'utf8'), '{"personal":"preserve"}');
  } finally {
    rmSync(directory, { recursive: true });
  }
});
