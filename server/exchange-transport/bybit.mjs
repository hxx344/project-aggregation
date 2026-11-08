import { createHmac } from 'node:crypto';

// Bybit v5 request signing (docs/evolution-plan.md E2): the one JS
// implementation for Asset and the Hub read and execution clients. The
// prehash is timestamp + apiKey + recvWindow + payload, where payload is the
// encoded query of a GET or the exact JSON body of a POST.
const DIGITS = /^\d{1,20}$/;

/** The four X-BAPI-* headers of one authenticated request. */
export function bybitAuthHeaders(credentials, { timestamp, recvWindow, payload = '' }) {
  if (typeof credentials?.apiSecret !== 'string' || !credentials.apiSecret || typeof credentials.apiKey !== 'string') throw new TypeError('Invalid Bybit API credentials');
  if (typeof timestamp !== 'string' || !DIGITS.test(timestamp) || typeof recvWindow !== 'string' || !DIGITS.test(recvWindow) || typeof payload !== 'string') throw new TypeError('Invalid Bybit request to sign');
  return {
    'X-BAPI-API-KEY': credentials.apiKey,
    'X-BAPI-TIMESTAMP': timestamp,
    'X-BAPI-RECV-WINDOW': recvWindow,
    'X-BAPI-SIGN': createHmac('sha256', credentials.apiSecret).update(timestamp + credentials.apiKey + recvWindow + payload).digest('hex'),
  };
}
