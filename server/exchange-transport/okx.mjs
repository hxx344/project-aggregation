import { createHmac } from 'node:crypto';

// OKX v5 request signing (docs/evolution-plan.md E2): the one JS implementation
// for Asset now and the Hub clients when they migrate. The prehash is
// timestamp + method + requestPath (including ?query) + the exact body text.
const METHODS = new Set(['GET', 'POST']);

function checked({ timestamp, method, requestPath, body = '' }) {
  if (typeof timestamp !== 'string' || !timestamp || !METHODS.has(method) || typeof requestPath !== 'string' || !requestPath.startsWith('/api/v5/')
    || typeof body !== 'string' || (method === 'GET' && body)) throw new TypeError('Invalid OKX request to sign');
  return timestamp + method + requestPath + body;
}

/** Base64 HMAC-SHA256 of the prehash with the API secret. */
export function okxSignature(secret, request) {
  if (typeof secret !== 'string' || !secret) throw new TypeError('Invalid OKX API secret');
  return createHmac('sha256', secret).update(checked(request)).digest('base64');
}

/** The four OK-ACCESS-* headers of one authenticated request. */
export function okxAuthHeaders(credentials, request) {
  return {
    'OK-ACCESS-KEY': credentials.apiKey,
    'OK-ACCESS-PASSPHRASE': credentials.passphrase,
    'OK-ACCESS-TIMESTAMP': request.timestamp,
    'OK-ACCESS-SIGN': okxSignature(credentials.apiSecret, request),
  };
}
