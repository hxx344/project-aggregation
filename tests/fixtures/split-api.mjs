import path from 'node:path';
import { runProcess } from '../../server/process-entry.mjs';
import { startApi } from '../../server/api/main.mjs';
import { unavailableUpdateState } from '../../server/updates.mjs';

// The API entry of the two-process tests: the real startApi() on an ephemeral
// port, without the root update helper or a built frontend.
const write = level => (fields, message) => process.stderr.write(`${JSON.stringify({ level, message, err: fields?.err?.message })}\n`);
const logger = { info() {}, debug() {}, warn: write('warn'), error: write('error') };
void runProcess({ name: 'api', logger, start: options => startApi({ ...options, dataDir: process.env.DATA_DIR, logger, port: 0, host: '127.0.0.1',
  distDir: path.join(process.env.DATA_DIR, 'dist'), updatesClient: { status: async () => unavailableUpdateState() } }) });
