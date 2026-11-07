// Explicit offline stream failure for tests of REST recovery. No socket is
// constructed; WS behaviour is exercised separately with controlled frames.
export function unavailableLighterStream(ErrorClass) {
  const unavailable = async () => { throw new ErrorClass('transport', { detail: 'fixture stream offline' }); };
  return { book: unavailable, order: unavailable, forget() {}, close() {} };
}
