import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function createModule({ root, dataDir, secret, environment = {} }) {
  if (typeof secret !== 'string' || secret.length < 12) throw new Error('Monitor workspace secret is required');
  root = resolve(root);
  const load = file => import(pathToFileURL(resolve(root, file)).href);
  const [{ createMonitorServices }, { createAuthorization, createHandler }, { createPageHandler }] = await Promise.all([
    load('server/monitor-services.mjs'), load('server/http.mjs'), load('server/page-handler.mjs'),
  ]);
  // Only the Linux supervisor may declare that its flock is already held.
  // Windows retains the source application's exclusive per-store file locks.
  const externallyLocked = process.platform === 'linux' && environment.MONITOR_EXTERNAL_LOCK === '1';
  if (process.platform === 'linux' && !externallyLocked) throw new Error('Monitor worker must be launched under the data directory flock');
  const services = await createMonitorServices(resolve(dataDir), { externallyLocked, env: { ...process.env, ...environment } });
  const username = 'workspace', password = secret;
  let pages, server, closing;
  const stopServices = async () => {
    const results = await Promise.allSettled([...services.values()].map(service => service.stop()));
    results.push(...await Promise.allSettled([services.notifications.stop(), services.market.stop()]));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  };
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      const drained = server?.listening ? new Promise((accept, reject) => server.close(error => error ? reject(error) : accept())) : Promise.resolve();
      for (const service of services.values()) service.closeStreams?.();
      await pages?.close();
      await drained;
      await stopServices();
    })();
    return closing;
  }
  try {
    pages = await createPageHandler({ services, root, development: false, authorize: createAuthorization({ username, password }) });
    const handler = createHandler({ services, username, password, pageHandler: pages.handle });
    const expected = Buffer.from(secret);
    const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    server = createServer((request, response) => {
      const supplied = Buffer.from(request.headers['x-workspace-key'] ?? '');
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        response.writeHead(401, { 'Cache-Control': 'no-store' }); response.end(); return;
      }
      request.headers.authorization = authorization;
      return handler(request, response);
    });
    server.requestTimeout = 30_000;
    services.market.start();
    for (const service of services.values()) await service.start();
    return { server, close };
  } catch (error) {
    await close();
    throw error;
  }
}
