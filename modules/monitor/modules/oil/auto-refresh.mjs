import { startActivityPolling } from '../../lib/polling.ts';

export const OIL_QUOTE_REFRESH_MS = 10_000;
export const OIL_REFRESH_MS = 60_000;
export const OIL_FUNDING_REFRESH_MS = 300_000;

/** Quote reads serve the visible overview; history belongs to the active detail. */
export function startOilAutoRefresh({ quote, prices, funding, page = document, view = window, active = true, summaryActive = active, onError = console.warn, onQuoteError = onError, onHistoryError = onError, onFundingError = onError }) {
  const controller = new AbortController();
  const network = {
    get onLine() { return view.navigator?.onLine !== false; },
    addEventListener: (type, listener) => view.addEventListener(type, listener),
    removeEventListener: (type, listener) => view.removeEventListener(type, listener),
  };
  const poll = (load, intervalMs, enabled, failure) => startActivityPolling({
    load, intervalMs, active: enabled, immediate: false, page, network,
    onData: () => {}, onError: failure,
  });
  const quotes = quote ? poll(quote, OIL_QUOTE_REFRESH_MS, summaryActive, onQuoteError) : null;
  const history = poll(prices, OIL_REFRESH_MS, active, onHistoryError);
  const fees = poll(funding, OIL_FUNDING_REFRESH_MS, active, onFundingError);
  const refresh = () => Promise.all([quotes?.refresh(), history.refresh(), fees.refresh()]);
  // Activity polling handles visibility/offline cancellation; these restore events
  // also cover an existing online connection and a back-forward cached document.
  view.addEventListener('online', () => { void refresh(); }, { signal: controller.signal });
  view.addEventListener('pageshow', event => { if (event.persisted) void refresh(); }, { signal: controller.signal });
  const stop = () => { controller.abort(); quotes?.stop(); history.stop(); fees.stop(); };
  stop.refresh = refresh;
  stop.refreshQuote = () => quotes?.refresh() ?? Promise.resolve();
  stop.refreshHistory = () => history.refresh();
  stop.refreshFunding = () => fees.refresh();
  stop.setActive = value => { history.setActive(value); fees.setActive(value); };
  stop.setSummaryActive = value => quotes?.setActive(value);
  return stop;
}
