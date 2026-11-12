import { createHmac } from 'node:crypto';

// Ondo Perps API-key signing. REST: hex HMAC-SHA256 over timestamp + METHOD +
// requestPath (with ?query) + the exact body text. WebSocket login: the same
// HMAC over time + "ondo_perps_ws_login".
const METHODS = new Set(['GET', 'POST', 'DELETE']);
const WS_LOGIN = 'ondo_perps_ws_login';

function secretOf(credentials) {
  if (typeof credentials?.keyId !== 'string' || !credentials.keyId || typeof credentials.secret !== 'string' || !credentials.secret) throw new TypeError('Invalid Ondo API credentials');
  return credentials.secret;
}
const stamp = value => { if (typeof value !== 'string' || !/^\d{13}$/.test(value)) throw new TypeError('Invalid Ondo timestamp'); return value; };

/** Hex HMAC-SHA256 of one REST request. */
export function ondoSignature(secret, { timestamp, method, requestPath, body = '' }) {
  if (typeof secret !== 'string' || !secret) throw new TypeError('Invalid Ondo API secret');
  if (!METHODS.has(method) || typeof requestPath !== 'string' || !requestPath.startsWith('/v1/') || typeof body !== 'string' || (method !== 'POST' && body)) throw new TypeError('Invalid Ondo request to sign');
  return createHmac('sha256', secret).update(stamp(timestamp) + method + requestPath + body).digest('hex');
}

/** The three ONDO-* headers of one authenticated request. */
export function ondoAuthHeaders(credentials, request) {
  return { 'ONDO-KEY-ID': credentials.keyId, 'ONDO-TIMESTAMP': request.timestamp, 'ONDO-SIGN': ondoSignature(secretOf(credentials), request) };
}

/** The login message of a WebSocket connection. */
export function ondoWsLogin(credentials, time) {
  return { op: 'login', args: { key: credentials.keyId, time: stamp(time), sign: createHmac('sha256', secretOf(credentials)).update(time + WS_LOGIN).digest('hex') } };
}
