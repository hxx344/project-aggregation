import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

// "serve" lets startup finish instead of losing the lock, to observe the started workbench.
const serving = process.argv[2] === 'serve';
const events = [];
let onLost, lost = false, onModuleReady;
const context = vm.createContext({ process: { env: { DATA_DIR: path.join(os.tmpdir(), 'simulated-recovery-entry') }, once() {}, exit(code) { events.push(`exit:${code}`); throw new Error('EXPECTED_EXIT'); } } });
const code = fs.readFileSync(new URL('../../server/index.mjs', import.meta.url), 'utf8');
const index = new vm.SourceTextModule(code, { context, initializeImportMeta(meta) { meta.url = new URL('../../server/index.mjs', import.meta.url).href; } });
let closePromise;
const control = { markStarted() { events.push('mark-started'); }, close() { return closePromise ??= (async () => { events.push('workers-close'); await new Promise(resolve => setTimeout(resolve, 40)); events.push('workers-closed'); })(); } };
const imports = {
  './app.mjs': { createApp: async options => { events.push('app-create'); if (options.moduleRuntime === control) events.push('runtime-passed');
    return { server: { listen(_port, _host, listening) { events.push('listen'); setTimeout(() => { events.push('listening'); listening(); }, 5); }, once() {} }, resynchronizeModules: id => { events.push(`resync:${id}`); }, close: async () => events.push('app-close') }; } },
  './logger.mjs': { logger: { info() {}, warn(_, message) { events.push(`warn:${message}`); }, error(_, message) { events.push(`error:${message}`); } } },
  'node:path': { default: path }, 'node:url': { fileURLToPath }, 'node:crypto': { randomUUID }, 'node:fs': { mkdirSync() {} },
  './execution/account-writer.mjs': { createAccountWriter: () => ({ close() { events.push('authority-close'); } }) },
  './recovery/startup.mjs': { assertRecoveryStartup() {} },
  './control/schema.mjs': { logWriteWaits: () => () => {} },
  './recovery/lifecycle-lock.mjs': { acquireRuntimeLock: async options => { onLost = options.onLost; return { assertHeld() { if (lost) throw new Error('lost'); }, close: async () => events.push('lock-close') }; } },
  './modules/runtime.mjs': { startModules: async options => {
    events.push('workers-starting'); options.onStarting(control); onModuleReady = options.onModuleReady;
    if (!serving) queueMicrotask(() => { events.push('lost'); lost = true; onLost(new Error('lost')); });
    await new Promise(resolve => setTimeout(resolve, 20)); events.push('workers-ready'); return control;
  } },
};
await index.link(specifier => {
  const values = imports[specifier]; if (!values) throw new Error('Unexpected import');
  return new vm.SyntheticModule(Object.keys(values), function () { for (const [name, value] of Object.entries(values)) this.setExport(name, value); }, { context });
});
if (serving) {
  await index.evaluate();
  await new Promise(resolve => setTimeout(resolve, 30));
  onModuleReady({ id: 'greeks', generation: 2 });
} else {
  try { await index.evaluate(); throw new Error('Startup continued after lock loss'); }
  catch (error) { if (error.message !== 'EXPECTED_EXIT') throw error; }
}
process.stdout.write(JSON.stringify(events) + '\n');
