import path from 'node:path';
import { runProcess } from '../../server/process-entry.mjs';
import { startApi } from '../../server/api/main.mjs';
import { unavailableUpdateState } from '../../server/updates.mjs';

// The API entry of the two-process tests: the real startApi() without the root
// update helper, on an ephemeral port and without a built frontend unless
// SPLIT_API_PORT and SPLIT_DIST_DIR name them (the split browser fixture).
const write = level => (fields, message) => process.stderr.write(`${JSON.stringify({ level, message, err: fields?.err?.message })}\n`);
const logger = { info() {}, debug() {}, warn: write('warn'), error: write('error') };
void runProcess({ name: 'api', logger, start: options => startApi({ ...options, dataDir: process.env.DATA_DIR, logger, port: Number(process.env.SPLIT_API_PORT || 0), host: '127.0.0.1',
  distDir: process.env.SPLIT_DIST_DIR || path.join(process.env.DATA_DIR, 'dist'), updatesClient: { status: async () => unavailableUpdateState() } }) });
