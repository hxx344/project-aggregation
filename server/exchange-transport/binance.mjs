import { createHmac } from 'node:crypto';

// Binance signed request query (docs/evolution-plan.md E2): the one JS
// implementation for Asset and the Hub read and execution clients. The
// signature is the hex HMAC-SHA256 of the exact encoded query sent, timestamp
// and recvWindow included, appended as its last parameter.
const DIGITS = /^\d{1,20}$/;

/**
 * parameters are copied; timestamp and recvWindow replace any given values.
 * Returns the query to send (without '?') and the API key header.
 */
export function binanceSignedQuery(credentials, parameters, { timestamp, recvWindow }) {
  if (typeof credentials?.apiSecret !== 'string' || !credentials.apiSecret) throw new TypeError('Invalid Binance API secret');
  if (typeof timestamp !== 'string' || !DIGITS.test(timestamp) || typeof recvWindow !== 'string' || !DIGITS.test(recvWindow)) throw new TypeError('Invalid Binance request to sign');
  const params = new URLSearchParams(parameters);
  params.set('timestamp', timestamp); params.set('recvWindow', recvWindow);
  const query = params.toString();
  return {
    query: query + '&signature=' + createHmac('sha256', credentials.apiSecret).update(query).digest('hex'),
    headers: { 'X-MBX-APIKEY': credentials.apiKey },
  };
}
