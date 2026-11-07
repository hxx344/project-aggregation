import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expected, loadCatalog, nodeSide, pythonSide, runScenario } from './fixtures/account-writer-protocol.mjs';
import { raisedCodes } from './fixtures/raised-codes.mjs';

// Completeness gate for the account writer protocol (docs/evolution-plan.md E7):
// both implementations must match tests/fixtures/account-writer-protocol.json,
// so a code, field, field type or hash changed on one side only, or on both
// sides without the catalog, fails here.
const catalog = loadCatalog();
const read = (relative) => fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
const sides = {
  node: { source: read('../server/execution/account-writer.mjs'), raises: ['fail', 'AccountWriterError'], helpers: ['identifier'] },
  python: { source: read('../server/execution/account_writer.py'), raises: ['_fail', 'AccountWriterError'], helpers: ['_identifier'] },
};
const sorted = (values) => [...new Set(values)].sort();
const quoted = (text) => [...text.matchAll(/["']([^"'\n]*)["']/g)].map((match) => match[1]);
const steps = catalog.scenarios.flatMap((scenario) => scenario.steps.map((step) => ({ scenario: scenario.name, step })));

test('both writers raise exactly the cataloged error codes, each as a literal', () => {
  for (const [side, { source, raises, helpers }] of Object.entries(sides)) {
    const { codes, dynamic } = raisedCodes(source, { raises, helpers });
    assert.deepEqual(dynamic, [], `${side} writer builds an error code at runtime; raise a literal so the catalog can list it`);
    assert.deepEqual(
      { extra: codes.filter((code) => !catalog.errorCodes.includes(code)), missing: catalog.errorCodes.filter((code) => !codes.includes(code)) },
      { extra: [], missing: [] },
      `${side} writer error codes differ from tests/fixtures/account-writer-protocol.json`,
    );
  }
  assert.deepEqual(catalog.errorCodes, sorted(catalog.errorCodes));
});

test('every error code has a vector or a recorded reason for having none', () => {
  const vectored = sorted(steps.map(({ step }) => step.expect.code).filter((code) => code !== undefined));
  const unknown = vectored.filter((code) => !catalog.errorCodes.includes(code));
  assert.deepEqual(unknown, [], 'vectors expect codes missing from errorCodes');
  assert.deepEqual(Object.keys(catalog.notVectored).filter((code) => vectored.includes(code)), [], 'codes both vectored and listed in notVectored');
  assert.deepEqual(sorted([...vectored, ...Object.keys(catalog.notVectored)]), catalog.errorCodes, 'each code needs a vector step or a notVectored reason');
  for (const [code, reason] of Object.entries(catalog.notVectored)) assert.ok(typeof reason === 'string' && reason.length > 0, code);
});

test('both writers declare the cataloged versions, timings, authorities and environments', () => {
  const declarations = {
    node: (name) => new RegExp(`^(?:export )?const ${name} = ([^;]+);`, 'm'),
    python: (name) => new RegExp(`^${name} = (.+)$`, 'm'),
  };
  for (const [side, { source }] of Object.entries(sides)) {
    const value = (name) => declarations[side](name).exec(source)?.[1];
    for (const [name, expectedValue] of Object.entries(catalog.constants)) assert.equal(Number(value(name)?.replaceAll('_', '')), expectedValue, `${side} ${name}`);
    assert.deepEqual(sorted(quoted(value('AUTHORITIES') ?? '')), sorted(catalog.authorities), `${side} authorities`);
    assert.deepEqual(sorted(quoted(value('ENVIRONMENTS') ?? '')), sorted(catalog.environments), `${side} environments`);
    assert.equal(source.match(/INSERT OR IGNORE INTO aw_meta VALUES \('schema','([^']*)'\)/)?.[1], catalog.protocol.registrySchema, `${side} registry schema`);
    assert.ok(source.includes(`${catalog.protocol.accountKeyDomain}\\0`), `${side} account key domain`);
  }
});

test('every vector names a cataloged shape, and every shape is checked', () => {
  const used = new Set();
  const visit = (name) => { used.add(name); const spec = catalog.shapes[name]; for (const item of [spec.each, ...Object.values(spec.items ?? {})].filter(Boolean)) visit(item); };
  for (const { scenario, step } of steps) if (step.shape) {
    assert.ok(Object.hasOwn(catalog.shapes, step.shape), `${scenario}: ${step.shape}`);
    visit(step.shape);
  }
  assert.deepEqual(Object.keys(catalog.shapes).filter((name) => !used.has(name)), [], 'shapes no vector checks');
});

for (const [side, open] of [['Node', nodeSide], ['Python', pythonSide]]) {
  for (const scenario of catalog.scenarios) {
    test(`${side} writer answers the protocol vectors: ${scenario.name}`, async () => {
      const outcomes = await runScenario(open, scenario, catalog.shapes);
      scenario.steps.forEach((step, index) => {
        assert.deepEqual(outcomes[index], expected(step, catalog.shapes), `step ${index} ${step.call}(${JSON.stringify(step.args ?? [])})`);
      });
    });
  }
}
