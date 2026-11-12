export type OndoCredentials = { keyId: string; secret: string };
/** body is the exact JSON text sent; only POST requests have one. timestamp is Unix milliseconds. */
export type OndoSignedRequest = { timestamp: string; method: 'GET' | 'POST' | 'DELETE'; requestPath: string; body?: string };
export function ondoSignature(secret: string, request: OndoSignedRequest): string;
export function ondoAuthHeaders(credentials: OndoCredentials, request: OndoSignedRequest): { 'ONDO-KEY-ID': string; 'ONDO-TIMESTAMP': string; 'ONDO-SIGN': string };
export function ondoWsLogin(credentials: OndoCredentials, time: string): { op: 'login'; args: { key: string; time: string; sign: string } };
