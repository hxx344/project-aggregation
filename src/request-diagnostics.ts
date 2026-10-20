export interface DiagnosticRequest {
  url: string;
  method: string;
  status: number;
  duration: number;
  timestamp: number;
  size: number | null;
  // The caller aborted the request (for example a superseded refresh); not a network failure.
  cancelled: boolean;
}

// Observe response headers only: reading/cloning bodies would perturb streaming
// requests and turn the diagnostic tool itself into a source of latency.
export function createDiagnosticFetch(original: typeof fetch, record: (log: DiagnosticRequest) => void): typeof fetch {
  return async (...args) => {
    const started = performance.now();
    const input = args[0];
    const url = input instanceof Request ? input.url : String(input);
    const method = args[1]?.method || (input instanceof Request ? input.method : 'GET');
    const emit = (status: number, size: number | null, cancelled = false) => {
      try { record({ url, method, status, size, cancelled, duration: Math.round(performance.now() - started), timestamp: Date.now() }); }
      catch { /* Diagnostic rendering must never change a network result. */ }
    };
    let response: Response;
    try { response = await original(...args); }
    catch (error) { emit(0, null, (error as { name?: unknown } | null)?.name === 'AbortError'); throw error; }
    const length = response.headers.get('content-length');
    const size = length !== null && /^\d+$/.test(length) && Number.isSafeInteger(Number(length)) ? Number(length) : null;
    emit(response.status, size);
    return response;
  };
}
