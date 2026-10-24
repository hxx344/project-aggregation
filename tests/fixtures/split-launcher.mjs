import { fileURLToPath } from 'node:url';
import { launch } from '../../server/launcher.mjs';

// The launcher of the two-process tests, over the fixture entries and with
// short API backoff; each API start is reported to the test over IPC.
const write = level => (fields, message) => process.stderr.write(`${JSON.stringify({ level, message, exitCode: fields?.exitCode, signal: fields?.signal })}\n`);
const logger = { info() {}, debug() {}, warn: write('warn'), error: write('error') };
const launcher = launch({ runtimeEntry: fileURLToPath(new URL('./split-runtime.mjs', import.meta.url)), apiEntry: fileURLToPath(new URL('./split-api.mjs', import.meta.url)),
  logger, apiBackoffMs: [50, 100], apiReadyMs: 20_000, apiStopMs: 5000, onApiReady: info => process.send({ type: 'api-ready', ...info }) });
process.once('SIGTERM', () => { void launcher.stop(0); });
process.exitCode = await launcher.done;
process.disconnect();
