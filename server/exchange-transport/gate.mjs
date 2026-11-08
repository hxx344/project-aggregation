import { createHash, createHmac } from 'node:crypto';

// Gate APIv4 request signing (docs/evolution-plan.md E2): the one JS
// implementation for Asset and the CrossEx client. The prehash is
// method, path (with the /api/v4 prefix), query, SHA-512 hex of the exact body
// and timestamp (seconds), joined by newlines; the signature is hex HMAC-SHA512.
const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);

/** The KEY, Timestamp and SIGN headers of one authenticated request. */
export function gateAuthHeaders(credentials, { method, path, query = '', body = '', timestamp }) {
  if (typeof credentials?.apiSecret !== 'string' || !credentials.apiSecret) throw new TypeError('Invalid Gate API secret');
  if (!METHODS.has(method) || typeof path !== 'string' || !path.startsWith('/api/v4/') || typeof query !== 'string' || query.startsWith('?')
    || typeof body !== 'string' || typeof timestamp !== 'string' || !/^\d{1,12}$/.test(timestamp)) throw new TypeError('Invalid Gate request to sign');
  const prehash = [method, path, query, createHash('sha512').update(body).digest('hex'), timestamp].join('\n');
  return { KEY: credentials.apiKey, Timestamp: timestamp, SIGN: createHmac('sha512', credentials.apiSecret).update(prehash).digest('hex') };
}
