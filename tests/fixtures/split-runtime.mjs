import { runProcess } from '../../server/process-entry.mjs';
import { startRuntime } from '../../server/runtime/main.mjs';
import { dataPlaneOptions, fakeModules } from './split-modules.mjs';

// The runtime entry of the two-process tests: the real startRuntime() over the
// fake modules of split-modules.mjs; warnings and errors go to stderr. The
// modules named in FAIL_MAINTENANCE (comma-separated) never take maintenance.
const write = level => (fields, message) => process.stderr.write(`${JSON.stringify({ level, message, err: fields?.err?.message })}\n`);
const logger = { info() {}, debug() {}, warn: write('warn'), error: write('error') };
const failMaintenance = Object.fromEntries((process.env.FAIL_MAINTENANCE || '').split(',').filter(Boolean).map(id => [id, Infinity]));
const { startModules } = fakeModules(process.env.MODULE_SOCKET_DIR, { failMaintenance });
void runProcess({ name: 'runtime', logger, start: options => startRuntime({ ...options, dataDir: process.env.DATA_DIR, logger, startModules, dataPlaneOptions }) });
