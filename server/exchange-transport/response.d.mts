export type ExchangeResponseErrorCode = 'response_limit' | 'invalid_data' | 'aborted';
export class ExchangeResponseError extends Error {
  readonly code: ExchangeResponseErrorCode;
  constructor(code: ExchangeResponseErrorCode);
}
/** An error thrown by reviver propagates unchanged; context.source is the numeric token text (Node >= 24). */
export function readJsonResponse(response: Response, options: {
  maxBytes: number; signal?: AbortSignal; reviver?: (this: unknown, key: string, value: unknown, context?: { source?: string }) => unknown;
}): Promise<unknown>;
