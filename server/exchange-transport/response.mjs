// Bounded JSON response reading for exchange clients (docs/evolution-plan.md E2).
export class ExchangeResponseError extends Error {
  constructor(code) { super(`Exchange response: ${code}`); this.name = 'ExchangeResponseError'; this.code = code; }
}
const fail = (code) => { throw new ExchangeResponseError(code); };

/**
 * Reads at most maxBytes of the body and parses it as JSON. Fails with code
 * response_limit (declared or actual size above maxBytes), invalid_data (no
 * readable body, or not JSON) or aborted (signal fired). An unfinished body is
 * cancelled, also as soon as the signal fires so a pending read ends. An error
 * thrown by the optional reviver (JSON.parse's) propagates unchanged, so a
 * caller keeps its own code for a field it refuses. Status, redirects and the
 * payload's meaning stay with the caller.
 */
export async function readJsonResponse(response, { maxBytes, signal, reviver } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes must be a positive integer');
  if (reviver !== undefined && typeof reviver !== 'function') throw new TypeError('reviver must be a function');
  const length = response?.headers?.get?.('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    // Refused unread: release the connection instead of leaving the body open.
    try { void response.body?.cancel?.()?.catch?.(() => {}); } catch { /* already locked or gone */ }
    fail('response_limit');
  }
  if (typeof response?.body?.getReader !== 'function') fail('invalid_data');
  const reader = response.body.getReader(), chunks = [];
  let size = 0, finished = false;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
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
    signal?.removeEventListener('abort', cancel);
    if (!finished) cancel();
    reader.releaseLock();
  }
  // TextDecoder drops a leading BOM, as Response.json() does.
  const text = new TextDecoder().decode(Buffer.concat(chunks, size));
  let refusal;
  const revive = reviver && function (key, value, context) {
    try { return reviver.call(this, key, value, context); } catch (error) { refusal = { error }; throw error; }
  };
  try { return JSON.parse(text, revive); } catch {
    if (refusal) throw refusal.error;
    return fail('invalid_data');
  }
}
