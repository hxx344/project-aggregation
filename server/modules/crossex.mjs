import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAccountWriter } from '../execution/account-writer.mjs';

export async function createModule({ root, dataDir, secret, environment = {}, transports = {} }) {
  if (typeof secret !== 'string' || secret.length < 12) throw new Error('CrossEx workspace secret is required');
  const load = file => import(pathToFileURL(resolve(root, file)).href);
  const [{ createApp }, { createPublicClients }] = await Promise.all([load('server/app.mjs'), load('server/clients.mjs')]);
  if (!transports.monitor) throw new Error('Embedded CrossEx requires the Monitor private transport');
  const clients = createPublicClients({ monitorTransport: transports.monitor });
  const expected = Buffer.from(secret);
  const managed = environment.WORKSPACE_MANAGED === '1';
  if (managed && (!environment.WORKSPACE_WRITER_DB || !environment.WORKSPACE_RUNTIME_ID)) throw new Error('Missing shared account protection');
  const accountWriter = managed ? createAccountWriter({ databasePath: environment.WORKSPACE_WRITER_DB, runtimeId: environment.WORKSPACE_RUNTIME_ID, moduleId: 'crossex' }) : null;
  let app;
  try { app = createApp({ dataDir: resolve(dataDir), distDir: resolve(root, 'dist'),
    initialWorkspaceMaintenance: environment.WORKSPACE_MAINTENANCE === '1',
    // The Hub forwards the public Host and validates Origin before proxying writes.
    // Old standalone PUBLIC_ORIGIN values do not describe the embedded endpoint.
    publicOrigin: environment.WORKSPACE_PUBLIC_ORIGIN || '',
    authorizeRequest(request) {
      const supplied = Buffer.from(request.headers['x-workspace-key'] ?? '');
      return supplied.length === expected.length && timingSafeEqual(supplied, expected);
    },
    marketOptions: { feedReader: clients.loadFeed },
    ...(accountWriter ? { liveOptions: { accountWriter } } : {}),
  }); } catch (error) { accountWriter?.close(); throw error; }
  const close = app.close.bind(app);
  return { ...app, writerProtectionVersion: accountWriter ? 1 : null, async close() { await close(); accountWriter?.close(); } };
}
