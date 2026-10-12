// Public collection cadence, inspired by https://perpdexlist.com/about.
// These intervals never replace the exchange's original observation timestamps.
export const STREAM_OBSERVATION_MS = 1_000;
export const MARKET_CATALOG_MS = 300_000;
export const MARKET_METRICS_POLL_MS = 30_000;
export const AUXILIARY_BOOK_POLL_MS = 30_000;

// Continuous pair matching requires source timestamps within five seconds.
// Keep bounded bulk confirmations where a full-universe stream is too costly.
export const BULK_BOOK_CONFIRM_MS = 5_000;
export const LIGHTER_BOOK_CONFIRM_MS = 3_000;
export const RH_LIGHTER_BOOK_CONFIRM_MS = 10_000;
