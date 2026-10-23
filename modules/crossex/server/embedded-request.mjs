import { request } from 'node:http';
import { Readable } from 'node:stream';

export const MONITOR_ORIGIN = 'http://monitor.workspace.internal';

function validTransport(transport) {
  const { socketPath, secret } = transport ?? {};
  if (typeof socketPath !== 'string' || !socketPath || typeof secret !== 'string' || secret.length < 12) throw new Error('Monitor private transport is required');
  return { socketPath, secret };
}

/**
 * A local pipe transport: never resolve an internal name through TCP/DNS.
 * A function is read on every request so a restarted Monitor is followed;
 * while it returns nothing, reads fail like any other unavailable source.
 */
export function createEmbeddedRequest(transport) {
  const current = typeof transport === 'function' ? () => validTransport(transport()) : (fixed => () => fixed)(validTransport(transport));
  return async (input, init = {}) => {
    const url = new URL(input);
    if (url.origin !== MONITOR_ORIGIN || url.username || url.password || url.hash || (init.method ?? 'GET') !== 'GET') throw new Error('Unsupported private Monitor request');
    const { socketPath, secret } = current();
    return new Promise((accept, reject) => {
      const pending = request({ socketPath, method: 'GET', path: url.pathname + url.search, signal: init.signal,
        headers: { Accept: 'application/json', Host: url.host, 'x-workspace-key': secret } }, response => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        }
        // The existing client bounds bytes, deadlines and acceptable status codes.
        accept(new Response(Readable.toWeb(response), { status: response.statusCode, headers }));
      });
      pending.once('error', reject);
      pending.end();
    });
  };
}
