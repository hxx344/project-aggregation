import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '../..');

// Static discovery verifies that references still name executable test bodies.
// It does not claim that those bodies passed or that every branch is covered.
export function discoverNodeCases(source) {
  const parsed = ts.createSourceFile('cases.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const cases = new Map();
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'test' && ts.isStringLiteral(node.arguments[0])) {
      const body = node.arguments.at(-1);
      if (!body || !ts.isArrowFunction(body) && !ts.isFunctionExpression(body)) return;
      const id = node.arguments[0].text;
      if (cases.has(id)) throw new Error(`duplicate test identifier: ${id}`);
      let peer = false;
      const inspect = child => {
        if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === 'pythonPeer') peer = true;
        ts.forEachChild(child, inspect);
      };
      inspect(body);
      cases.set(id, { languages: peer ? ['node', 'python'] : ['node'], kind: peer ? 'interop' : 'unit' });
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return cases;
}

export function discoverPythonCases(source) {
  const script = 'import ast,json,sys\ntree=ast.parse(sys.stdin.read())\nprint(json.dumps([c.name+"."+f.name for c in tree.body if isinstance(c,ast.ClassDef) for f in c.body if isinstance(f,(ast.FunctionDef,ast.AsyncFunctionDef)) and f.name.startswith("test_")]))';
  const result = spawnSync(process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'), ['-I', '-c', script], {
    input: source, encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024,
  });
  if (result.status !== 0 || result.error) throw new Error('Python test discovery failed');
  const ids = JSON.parse(result.stdout);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate Python test identifier');
  return new Map(ids.map(id => [id, { languages: ['python'], kind: 'unit' }]));
}

export function validateCoverage(catalog, read = file => fs.readFileSync(path.join(root, file), 'utf8')) {
  if (catalog.coverageSchemaVersion !== 1) throw new Error('invalid coverage schema');
  const files = new Map(), summary = [];
  for (const [code, entry] of Object.entries(catalog.regressionCoverage)) {
    if (!Object.hasOwn(catalog.notVectored, code)) throw new Error(`${code}: expected a notVectored code`);
    if (!entry.limitations?.trim() || !Array.isArray(entry.cases)) throw new Error(`${code}: missing coverage limits`);
    if (entry.notApplicableTo === 'shared-vector') {
      if (entry.cases.length) throw new Error(`${code}: inapplicable vector cannot declare cases`);
      summary.push({ code, kind: 'not-applicable-to-shared-vector', languages: [] });
      continue;
    }
    if (entry.notApplicableTo !== undefined || !entry.cases.length) throw new Error(`${code}: missing cases`);
    for (const ref of entry.cases) {
      if (!/^tests\/(?:[A-Za-z0-9_-]+\.test\.mjs|test_[A-Za-z0-9_]+\.py)$/.test(ref.file)) throw new Error(`${code}: invalid test file`);
      if (!files.has(ref.file)) files.set(ref.file, ref.file.endsWith('.py') ? discoverPythonCases(read(ref.file)) : discoverNodeCases(read(ref.file)));
      const found = files.get(ref.file).get(ref.id);
      if (!found) throw new Error(`${code}: missing test ${ref.file} :: ${ref.id}`);
      if (found.kind !== ref.kind || JSON.stringify(found.languages) !== JSON.stringify(ref.languages)) throw new Error(`${code}: incorrect language or coverage kind for ${ref.id}`);
      summary.push({ code, ...found, file: ref.file, id: ref.id });
    }
  }
  return summary;
}
