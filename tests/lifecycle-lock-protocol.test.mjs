import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { raisedCodes } from './fixtures/raised-codes.mjs';

// Completeness gate for the lifecycle lock line protocol (docs/evolution-plan.md
// E7): a code added to the helper without the wrapper's allowed list would
// surface only as RUNTIME_LOCK_PROTOCOL, so both must match the catalog. These
// are source checks; the lock behavior is tested by tests/lifecycle-lock.test.mjs.
const read = (relative) => fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
const catalog = JSON.parse(read('./fixtures/lifecycle-lock-protocol.json'));
const wrapper = read('../server/recovery/lifecycle-lock.mjs');
const helper = read('../server/recovery/lifecycle_lock.py');
const sorted = (values) => [...new Set(values)].sort();

test('the lifecycle lock helper reports exactly the codes the wrapper accepts', () => {
  const raised = raisedCodes(helper, { raises: ['_fail', 'LifecycleLockError'] });
  assert.deepEqual(raised.dynamic, [], 'helper builds an error code at runtime');
  // main() prints the code of a LifecycleLockError, or this fallback for any other failure.
  const fallback = /code = error\.code if isinstance\(error, LifecycleLockError\) else "([A-Z_]+)"\n\s+print\(json\.dumps\(\{"code": code\}\)/.exec(helper)?.[1];
  assert.ok(fallback, 'helper failure report not found');
  assert.deepEqual(sorted([...raised.codes, fallback]), sorted(catalog.helperCodes), 'helper codes differ from tests/fixtures/lifecycle-lock-protocol.json');
  const allowed = /const allowed = \[([^\]]*)\];\n\s+state\.markLost\(new RuntimeLockError\(allowed\.includes\(message\.code\) \? message\.code : 'RUNTIME_LOCK_PROTOCOL'\)\)/.exec(wrapper)?.[1];
  assert.ok(allowed, 'wrapper allowed helper codes not found');
  assert.deepEqual(sorted([...allowed.matchAll(/'([^']+)'/g)].map((match) => match[1])), sorted(catalog.helperCodes), 'wrapper accepts a different helper code set');
});

test('the lifecycle lock wrapper raises only cataloged codes of its own', () => {
  const raised = raisedCodes(wrapper, { raises: ['fail', 'RuntimeLockError'] });
  // The only codes the wrapper does not spell out: the code an earlier failure
  // already recorded, and a helper code that passed the allowed list checked above.
  assert.deepEqual(raised.dynamic, [
    "RuntimeLockError(code === 0 ? 'RUNTIME_LOCK_LOST' : state.error?.code ?? 'RUNTIME_LOCK_LOST')",
    "RuntimeLockError(allowed.includes(message.code) ? message.code : 'RUNTIME_LOCK_PROTOCOL')",
  ], 'wrapper forwards an error code it does not spell out');
  const own = raised.codes.filter((code) => !catalog.helperCodes.includes(code));
  assert.deepEqual(own, sorted(catalog.wrapperOnlyCodes), 'wrapper codes differ from tests/fixtures/lifecycle-lock-protocol.json');
});

test('the lifecycle lock wrapper and helper agree on the ready message version', () => {
  assert.match(helper, new RegExp(`\\n\\s+print\\(json\\.dumps\\(\\{"ready": True, "schemaVersion": ${catalog.schemaVersion}\\}\\), flush=True\\)`));
  assert.match(wrapper, new RegExp(`if \\(message\\.ready === true && message\\.schemaVersion === ${catalog.schemaVersion} && !state\\.lost\\)`));
});
