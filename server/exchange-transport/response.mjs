// Bounded JSON response reading for exchange clients (docs/evolution-plan.md E2).
export class ExchangeResponseError extends Error {
  constructor(code) { super(`Exchange response: ${code}`); this.name = 'ExchangeResponseError'; this.code = code; }
}
const fail = (code) => { throw new ExchangeResponseError(code); };

/**
 * Reads at most maxBytes of the body and parses it as JSON. Fails with code
 * response_limit (declared or actual size above maxBytes), invalid_data (no
 * readable body, or not JSON) or aborted (signal fired). An unfinished body is
 * cancelled. Status, redirects and the payload's meaning stay with the caller.
 */
export async function readJsonResponse(response, { maxBytes, signal } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes must be a positive integer');
  const length = response?.headers?.get?.('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) fail('response_limit');
  if (typeof response?.body?.getReader !== 'function') fail('invalid_data');
  const reader = response.body.getReader(), chunks = [];
  let size = 0, finished = false;
  try {
    for (;;) {
      if (signal?.aborted) fail('aborted');
      const chunk = await reader.read();
      if (signal?.aborted) fail('aborted');
      if (chunk.done) { finished = true; break; }
      size += chunk.value.byteLength;
      if (size > maxBytes) fail('response_limit');
      chunks.push(Buffer.from(chunk.value));
    }
  } finally {
    if (!finished) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  // TextDecoder drops a leading BOM, as Response.json() does.
  try { return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks, size))); } catch { return fail('invalid_data'); }
}
