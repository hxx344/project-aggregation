// Replays the shared account writer protocol vectors
// (tests/fixtures/account-writer-protocol.json) against the Node writer or a
// Python peer process, so both implementations answer the same catalog.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { accountKey, createAccountWriter } from '../../server/execution/account-writer.mjs';

export const catalogPath = fileURLToPath(new URL('./account-writer-protocol.json', import.meta.url));
export const loadCatalog = () => JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
const pythonCommand = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const PYTHON_NAMES = { accountKey: 'account_key', importUnknown: 'import_unknown', assertOwned: 'assert_owned', releaseBinding: 'release_binding' };
const TIMEOUT_MS = 10_000;

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'account-writer-protocol-'));
const remove = (directory) => fs.rmSync(directory, { recursive: true, force: true });

export function nodeSide(moduleId) {
  const directory = scratch();
  let writer;
  try { writer = createAccountWriter({ databasePath: path.join(directory, 'execution-control.sqlite'), moduleId, runtimeId: crypto.randomUUID() }); } catch (error) { remove(directory); throw error; }
  return {
    async call(method, args) {
      try { return { result: method === 'accountKey' ? accountKey(...args) : writer[method](...args) }; } catch (error) {
        if (typeof error?.code !== 'string') throw error;
        return { code: error.code };
      }
    },
    async close() { try { writer.close(); } finally { remove(directory); } },
  };
}

// JSON.stringify writes -0 as 0; the hash vectors need Python to receive -0.0.
const toPython = (value) => JSON.stringify(value, (_key, item) => Object.is(item, -0) ? '\u0000negative-zero' : item).replaceAll(JSON.stringify('\u0000negative-zero'), '-0.0');
// JSON.parse reads Python's 1.0 as 1; keep a float visible so a field that
// became a float on one side changes the recorded value and type.
const fromPython = (line) => JSON.parse(line, (_key, value, context) => typeof value === 'number' && /[.eE]/.test(context?.source ?? '') ? { $float: context.source } : value);

// One Python process per scenario through tests/account-writer-peer.py; the
// startup and each call have a 10 s limit, after which the peer is killed.
export async function pythonSide(moduleId) {
  const directory = scratch();
  const config = { databasePath: path.join(directory, 'execution-control.sqlite'), moduleId, runtimeId: crypto.randomUUID() };
  const peer = spawn(pythonCommand, [fileURLToPath(new URL('../account-writer-peer.py', import.meta.url)), JSON.stringify(config)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map(); let sequence = 0; let stderr = ''; let broken = null;
  peer.stderr.on('data', (value) => { stderr += value; });
  // A write after the peer died (EPIPE) fails the run like the exit itself.
  peer.stdin.on('error', (error) => breakWith(error));
  const exited = new Promise((resolve) => peer.once('exit', (code, signal) => resolve({ code, signal })));
  // The first failure wins: a timeout, an unreadable line or the exit.
  const breakWith = (error) => { broken ??= error; for (const waiter of pending.values()) waiter.reject(broken); pending.clear(); if (peer.exitCode === null && peer.signalCode === null) peer.kill('SIGKILL'); };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { breakWith(new Error('Python writer peer startup timed out')); reject(broken); }, TIMEOUT_MS);
      createInterface({ input: peer.stdout }).on('line', (line) => {
        let value;
        try { value = fromPython(line); } catch { value = undefined; }
        if (value === null || typeof value !== 'object') { breakWith(new Error(`Python writer peer printed an unreadable line: ${line.slice(0, 200)}`)); clearTimeout(timer); reject(broken); return; }
        if (value.ready) { clearTimeout(timer); resolve(); return; }
        const waiter = pending.get(value.id); pending.delete(value.id); waiter?.resolve(value);
      });
      peer.on('error', (error) => { clearTimeout(timer); breakWith(error); reject(broken); });
      exited.then(({ code, signal }) => { clearTimeout(timer); breakWith(new Error(`Python writer peer exited (code ${code}, signal ${signal}): ${stderr.slice(-2000)}`)); reject(broken); });
    });
  } catch (error) { if (peer.pid !== undefined) await exited; remove(directory); throw error; }
  const call = (method, args) => broken ? Promise.reject(broken) : new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { breakWith(new Error(`Python writer peer timed out: ${method}`)); }, TIMEOUT_MS);
    pending.set(id, { resolve(value) { clearTimeout(timer); resolve(value.code === undefined ? { result: value.result } : { code: value.code }); }, reject(error) { clearTimeout(timer); reject(error); } });
    peer.stdin.write(`${toPython({ id, method: PYTHON_NAMES[method] ?? method, args })}\n`);
  });
  return {
    call,
    async close() {
      try {
        if (!broken) { await call('close', []); peer.stdin.end(); }
      } finally {
        if (peer.exitCode === null && peer.signalCode === null) { peer.stdin.end(); setTimeout(() => peer.kill('SIGKILL'), TIMEOUT_MS).unref(); }
        await exited; remove(directory);
      }
    },
  };
}

const resolveArgs = (value, saved) => {
  if (typeof value === 'string' && value.startsWith('$')) {
    if (!Object.hasOwn(saved, value.slice(1))) throw new Error(`protocol vector refers to unsaved ${value}`);
    return saved[value.slice(1)];
  }
  if (Array.isArray(value)) return value.map((item) => resolveArgs(item, saved));
  return value;
};

export function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isSafeInteger(value) ? 'integer' : 'number';
  if (typeof value === 'object' && Object.keys(value).length === 1 && Object.hasOwn(value, '$float')) return 'float';
  return typeof value;
}

// Field name -> type of each returned ticket, by shape name. A shape is
// { fields: { name: type }, items?: { field: shape } } for an object, or
// { each: shape } for a list; every item of a list must have the same shape.
// An items entry names the shape of a nested list, or of a nested object.
function shapeOf(value, name, shapes, result = {}) {
  const spec = shapes[name];
  if (!spec) throw new Error(`protocol vector names unknown shape ${name}`);
  if (spec.each) {
    if (!Array.isArray(value)) { result[name] = typeOf(value); return result; }
    for (const item of value) shapeOf(item, spec.each, shapes, result);
    return result;
  }
  const fields = typeOf(value) === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, typeOf(value[key])])) : typeOf(value);
  if (Object.hasOwn(result, name) && JSON.stringify(result[name]) !== JSON.stringify(fields)) result[name] = 'items differ';
  else result[name] = fields;
  for (const [field, item] of Object.entries(spec.items ?? {})) {
    const nested = value?.[field];
    for (const entry of Array.isArray(nested) ? nested : nested == null ? [] : [nested]) shapeOf(entry, item, shapes, result);
  }
  return result;
}

const picked = (result, keys) => keys ? Object.fromEntries(keys.map((key) => [key, result?.[key]])) : result;

/** Runs one scenario and returns, per step, what the catalog records for it. */
export async function runScenario(open, scenario, shapes) {
  const side = await open(scenario.moduleId);
  const outcomes = []; const saved = {};
  try {
    for (const step of scenario.steps) {
      const answer = await side.call(step.call, resolveArgs(step.args ?? [], saved));
      if (answer.code !== undefined) { outcomes.push({ code: answer.code }); continue; }
      if (step.save) saved[step.save] = answer.result;
      const outcome = { value: picked(answer.result, step.pick) };
      if (step.shape) outcome.shape = shapeOf(answer.result, step.shape, shapes);
      outcomes.push(outcome);
    }
  } finally { await side.close(); }
  return outcomes;
}

/** What a step's catalog entry expects, in the form runScenario reports. */
export function expected(step, shapes) {
  if (step.expect.code !== undefined) return { code: step.expect.code };
  const outcome = { value: step.expect.value };
  if (step.shape) {
    outcome.shape = {};
    const visit = (name) => {
      const spec = shapes[name];
      if (spec.each) { visit(spec.each); return; }
      outcome.shape[name] = Object.fromEntries(Object.entries(spec.fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
      for (const item of Object.values(spec.items ?? {})) visit(item);
    };
    visit(step.shape);
  }
  return outcome;
}
