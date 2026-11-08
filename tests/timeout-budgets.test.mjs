import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The timeout budget table (docs/timeout-budgets.md). Every registered value is
// read back from where it takes effect: source constants and defaults, the
// Python bridge, and the units the installer actually generates. Changing a
// budget without the table, or changing both so a relation breaks, fails here.
const root = fileURLToPath(new URL('..', import.meta.url));
const table = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/timeout-budgets.json'), 'utf8'));
const byId = new Map(table.budgets.map(budget => [budget.id, budget]));
const sources = new Map();
const read = file => { if (!sources.has(file)) sources.set(file, fs.readFileSync(path.join(root, file), 'utf8')); return sources.get(file); };

function renderUnits() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'timeout-budgets-'));
  try {
    // install.sh writes every unit of both layouts; the values do not depend on the layout.
    execFileSync('bash', ['-c', [
      'AGG_INSTALL_SOURCE_ONLY=1 source deploy/install.sh',
      'SERVICE=agg API_SERVICE=agg-api ENTRY_SERVICE=agg-entry SERVICE_USER=agg APP_DIR=/opt/agg DATA_PATH=/var/lib/agg ENV_FILE=/etc/agg.env',
      'NODE_BIN=/usr/bin/node GREEKS_PYTHON_PATH=/usr/bin/python3 ASTER_PYTHON_PATH=/usr/bin/python3 systemd_version=255 slot_layout=dual work_dir="$1"',
      'write_unit',
    ].join('\n'), 'render', directory], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
    return new Map(fs.readdirSync(directory).map(name => [name, fs.readFileSync(path.join(directory, name), 'utf8')]));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
const units = renderUnits();

const resolved = new Map();
function value(id, trail = []) {
  if (resolved.has(id)) return resolved.get(id);
  const budget = byId.get(id);
  assert.ok(budget, `unknown budget ${id}`);
  assert.ok(!trail.includes(id), `budget cycle ${[...trail, id].join(' -> ')}`);
  const { source = {} } = budget;
  let actual;
  if (source.unit) {
    const text = units.get(source.unit);
    assert.ok(text, `installer did not generate ${source.unit}`);
    const lines = text.split('\n').filter(line => line.startsWith(source.key + '='));
    assert.equal(lines.length, 1, `${source.unit} sets ${source.key} once`);
    assert.match(lines[0], /^\w+=\d+$/, `${source.unit} ${source.key} is whole seconds`);
    actual = Number(lines[0].split('=')[1]) * 1000;
  }
  if (source.file) {
    const text = read(source.file);
    if (source.absent) assert.doesNotMatch(text, new RegExp(source.absent), `${id}: ${source.file} must not set ${source.absent}`);
    if (source.pattern) {
      const matches = [...text.matchAll(new RegExp(source.pattern, 'g'))];
      assert.equal(matches.length, 1, `${id}: pattern matches ${source.file} exactly once`);
      // A copy left in a comment must not stand in for the code that moved.
      const line = text.slice(text.lastIndexOf('\n', matches[0].index) + 1).trimStart();
      // Trailing comments are not detected (docs/timeout-budgets.md section 6).
      assert.doesNotMatch(line, source.file.endsWith('.py') ? /^#/ : /^(\/\/|\/\*|\* |\*\/)/, `${id}: pattern matches a comment in ${source.file}`);
      const captured = matches[0][source.group ?? 1];
      if (captured !== undefined) actual = Number(captured.replaceAll('_', '')) * (source.scale ?? 1);
    }
  }
  // A default only takes effect while the production caller does not pass its own value.
  for (const override of budget.overrides ?? []) {
    let text = read(override.file);
    if (override.after) {
      const start = text.indexOf(override.after);
      assert.ok(start >= 0 && text.indexOf(override.after, start + 1) < 0, `${id}: ${override.file} has one ${override.after}`);
      const end = text.indexOf(override.until, start);
      assert.ok(end >= 0, `${id}: ${override.file} ends ${override.after} with ${JSON.stringify(override.until)}`);
      text = text.slice(start, end + override.until.length);
    }
    assert.doesNotMatch(text, new RegExp(override.absent), `${id}: ${override.file} overrides the default`);
  }
  if (budget.sameAs) { assert.equal(actual, undefined, `${id}: sameAs budgets capture no number`); actual = value(budget.sameAs, [...trail, id]); }
  if (budget.sum) { assert.equal(actual, undefined, `${id}: sum budgets capture no number`); actual = budget.sum.reduce((total, part) => total + value(part, [...trail, id]), 0); }
  assert.ok(Number.isFinite(actual), `${id}: no value read from its source`);
  resolved.set(id, actual);
  return actual;
}

test('every registered budget equals the value read from where it takes effect', () => {
  assert.equal(table.schema, 1);
  assert.equal(byId.size, table.budgets.length, 'budget ids are unique');
  for (const budget of table.budgets) {
    assert.ok(Number.isInteger(budget.ms) && budget.ms > 0, `${budget.id}: ms`);
    assert.ok([budget.source?.file, budget.source?.unit, budget.sum].filter(Boolean).length === 1, `${budget.id}: exactly one kind of source`);
    assert.equal(value(budget.id), budget.ms, `${budget.id}: source value differs from the table`);
  }
});

test('generated units leave the stop timeout to TimeoutStopSec alone', () => {
  // docs/timeout-budgets.md relies on these: no ExecStop, default control-group
  // KillMode (SIGTERM to every process at once), no TimeoutSec= overriding the stop limit.
  for (const [name, text] of units) {
    assert.doesNotMatch(text, /^(ExecStop|ExecStopPost|KillMode|KillSignal|FinalKillSignal|SendSIGKILL|TimeoutSec|TimeoutAbortSec|TimeoutStopFailureMode)=/m, name);
  }
});

test('nested and sequential budgets keep their margins; registered conflicts still fail', () => {
  const ids = new Set();
  for (const relation of table.relations) {
    assert.ok(!ids.has(relation.id), `relation ${relation.id} is unique`); ids.add(relation.id);
    assert.ok(Number.isInteger(relation.minMarginMs) && relation.minMarginMs >= 0, relation.id);
    const spare = value(relation.outer) - relation.inner.reduce((total, id) => total + value(id), 0) - relation.minMarginMs;
    if (relation.status === 'holds') assert.ok(spare >= 0, `${relation.id}: ${relation.outer} lacks ${-spare} ms over ${relation.inner.join(' + ')} + ${relation.minMarginMs} ms margin`);
    else {
      assert.equal(relation.status, 'conflict', relation.id);
      assert.match(relation.conflict ?? '', /^C\d+$/, `${relation.id}: names its conflict`);
      // Fixed conflicts must be turned into holds so the margin stays checked.
      assert.ok(spare < 0, `${relation.id}: conflict ${relation.conflict} now holds; mark it holds`);
    }
  }
});

test('the document lists every budget and relation with the registered value', () => {
  const doc = read('docs/timeout-budgets.md');
  const rows = [...doc.matchAll(/^\| `([a-z0-9.-]+)` \| ([^|]+) \|([^|]*)\|/gm)].map(match => [match[1], match[2].trim(), match[3].trim()]);
  const listed = new Map(rows.map(([id, cell]) => [id, cell])), formulas = new Map(rows.map(([id, , formula]) => [id, formula]));
  assert.equal(listed.size, rows.length, 'each id is listed once');
  for (const budget of table.budgets) {
    assert.ok(listed.has(budget.id), `docs list budget ${budget.id}`);
    assert.equal(listed.get(budget.id), `${budget.ms / 1000} s`, `docs value of ${budget.id}`);
  }
  for (const relation of table.relations) {
    assert.ok(listed.has(relation.id), `docs list relation ${relation.id}`);
    assert.equal(listed.get(relation.id), relation.status === 'holds' ? '成立' : `冲突 ${relation.conflict}`, `docs status of ${relation.id}`);
    const formula = ['`' + relation.outer + '` ⊇ ' + relation.inner.map(id => '`' + id + '`').join(' + '), `${relation.minMarginMs / 1000} s`].join(' + ');
    assert.equal(formulas.get(relation.id), formula, `docs formula of ${relation.id}`);
    if (relation.conflict) assert.match(doc, new RegExp(`^\\| ${relation.conflict} \\|`, 'm'), `docs describe ${relation.conflict}`);
  }
  assert.equal(listed.size, table.budgets.length + table.relations.length, 'docs list nothing unregistered');
});
