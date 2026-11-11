import { createHmac } from 'node:crypto';

export interface BybitCredentials { apiKey: string; apiSecret: string }

/** X-BAPI headers: HMAC-SHA256 over timestamp + key + recvWindow + (query | JSON body), as server/exchange-transport/bybit.mjs. */
export function bybitHeaders(credentials: BybitCredentials, timestamp: string, recvWindow: string, payload: string): Record<string, string> {
  return { 'X-BAPI-API-KEY': credentials.apiKey, 'X-BAPI-TIMESTAMP': timestamp, 'X-BAPI-RECV-WINDOW': recvWindow,
    'X-BAPI-SIGN': createHmac('sha256', credentials.apiSecret).update(timestamp + credentials.apiKey + recvWindow + payload).digest('hex') };
}
