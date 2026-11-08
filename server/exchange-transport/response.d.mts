export type ExchangeResponseErrorCode = 'response_limit' | 'invalid_data' | 'aborted';
export class ExchangeResponseError extends Error {
  readonly code: ExchangeResponseErrorCode;
  constructor(code: ExchangeResponseErrorCode);
}
export function readJsonResponse(response: Response, options: { maxBytes: number; signal?: AbortSignal }): Promise<unknown>;
