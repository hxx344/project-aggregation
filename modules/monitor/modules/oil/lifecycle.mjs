/** A mounted panel owns its requests and global listeners. */
export function createLifecycle() {
  const controller = new AbortController();
  const signal = controller.signal;
  return {
    signal,
    on(target, event, handler) { target.addEventListener(event, handler, { signal }); },
    async fetch(input, options = {}) {
      signal.throwIfAborted();
      const response = await globalThis.fetch(input, { ...options, signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal });
      signal.throwIfAborted();
      const json = response.json.bind(response);
      response.json = async () => { const result = await json(); signal.throwIfAborted(); return result; };
      return response;
    },
    dispose() { controller.abort(); },
  };
}
