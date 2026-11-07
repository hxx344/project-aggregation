// Deliberately offline: existing REST-path tests must not construct live sockets.
// Dedicated stream tests exercise protocol frames and lifecycle with fake IO.
export function unavailableBinanceStreams(ErrorClass = Error) {
  const unavailable = async () => { throw Object.assign(new ErrorClass('transport', { detail: 'fixture stream offline' }), { code: 'transport' }); };
  return { book: unavailable, ready: unavailable, order: unavailable, orderGeneration() { return null; }, seedOrder() { return false; }, invalidateOrder() {},
    subscribePositions() { return () => {}; }, forget() {}, close() {} };
}
