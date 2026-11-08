export type BybitCredentials = { apiKey: string; apiSecret: string };
/** payload is the encoded query of a GET or the exact JSON body of a POST. */
export function bybitAuthHeaders(credentials: BybitCredentials, request: { timestamp: string; recvWindow: string; payload?: string }): {
  'X-BAPI-API-KEY': string; 'X-BAPI-TIMESTAMP': string; 'X-BAPI-RECV-WINDOW': string; 'X-BAPI-SIGN': string;
};
