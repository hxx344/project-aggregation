export type OkxCredentials = { apiKey: string; apiSecret: string; passphrase: string };
/** body is the exact JSON text sent; GET requests have none. */
export type OkxSignedRequest = { timestamp: string; method: 'GET' | 'POST'; requestPath: string; body?: string };
export function okxSignature(secret: string, request: OkxSignedRequest): string;
export function okxAuthHeaders(credentials: OkxCredentials, request: OkxSignedRequest): {
  'OK-ACCESS-KEY': string; 'OK-ACCESS-PASSPHRASE': string; 'OK-ACCESS-TIMESTAMP': string; 'OK-ACCESS-SIGN': string;
};
