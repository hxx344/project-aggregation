import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const events = [];
let onLost, lost = false;
const context = vm.createContext({ process: { env: { DATA_DIR: path.join(os.tmpdir(), 'simulated-recovery-entry') }, once() {}, exit(code) { events.push(`exit:${code}`); throw new Error('EXPECTED_EXIT'); } } });
const code = fs.readFileSync(new URL('../../server/index.mjs', import.meta.url), 'utf8');
const index = new vm.SourceTextModule(code, { context, initializeImportMeta(meta) { meta.url = new URL('../../server/index.mjs', import.meta.url).href; } });
let closePromise;
const control = { close() { return closePromise ??= (async () => { events.push('workers-close'); await new Promise(resolve => setTimeout(resolve, 40)); events.push('workers-closed'); })(); } };
const imports = {
  './app.mjs': { createApp: async () => { events.push('app-create'); return { server: { listen() { events.push('listen'); }, once() {} }, close: async () => events.push('app-close') }; } },
  './logger.mjs': { logger: { info() {}, error() {} } },
  'node:path': { default: path }, 'node:url': { fileURLToPath }, 'node:crypto': { randomUUID }, 'node:fs': { mkdirSync() {} },
  './execution/account-writer.mjs': { createAccountWriter: () => ({ close() { events.push('authority-close'); } }) },
  './recovery/startup.mjs': { assertRecoveryStartup() {} },
  './recovery/lifecycle-lock.mjs': { acquireRuntimeLock: async options => { onLost = options.onLost; return { assertHeld() { if (lost) throw new Error('lost'); }, close: async () => events.push('lock-close') }; } },
  './modules/runtime.mjs': { startModules: async options => {
    events.push('workers-starting'); options.onStarting(control);
    queueMicrotask(() => { events.push('lost'); lost = true; onLost(new Error('lost')); });
    await new Promise(resolve => setTimeout(resolve, 20)); events.push('workers-ready'); return control;
  } },
};
await index.link(specifier => {
  const values = imports[specifier]; if (!values) throw new Error('Unexpected import');
  return new vm.SyntheticModule(Object.keys(values), function () { for (const [name, value] of Object.entries(values)) this.setExport(name, value); }, { context });
});
try { await index.evaluate(); throw new Error('Startup continued after lock loss'); }
catch (error) { if (error.message !== 'EXPECTED_EXIT') throw error; }
process.stdout.write(JSON.stringify(events) + '\n');
