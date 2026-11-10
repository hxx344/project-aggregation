"use client";

import { useEffect, useState, useSyncExternalStore } from 'react';
import { parseCycleEvidence, type CycleEvidence } from '../../../server/cycle-evidence.mjs';
import { readActivity } from './read-activity.ts';
import { perpetualChartUrl } from './perpetual-chart-state.ts';
import { createHubRequester } from './hub-requester.ts';

import { cleanHubQuery, HUB_QUERY_KEYS, type HubQuery } from '../../../server/hub-navigation.mjs';
export { cleanHubQuery, HUB_QUERY_KEYS };
export type { HubQuery };
export type HubProject = 'monitor' | 'crossex';
const envelope = { channel: 'project-hub', version: 1 } as const;
export const MODULE_CAPABILITIES = ['activity', 'navigate', 'changed', 'positions', 'fills', 'open-trading', 'anthropic-shares'] as const;
let targetOrigin = '', connected = false, hostCapabilities: ReadonlySet<string> = new Set();
const hubListeners = new Set<() => void>();
const positionListeners = new Set<(value: unknown) => void>();
const fillListeners = new Set<(value: unknown) => void>();
const hostReadyListeners = new Set<() => void>();
export function subscribeHubFills(listener: (value: unknown) => void) { fillListeners.add(listener); return () => { fillListeners.delete(listener); }; }
export function subscribeHostReady(listener: () => void) { hostReadyListeners.add(listener); return () => { hostReadyListeners.delete(listener); }; }
let hubSnapshot = '0|';
function notifyHub() { hubSnapshot = `${connected ? 1 : 0}|${[...hostCapabilities].sort().join(',')}`; hubListeners.forEach(listener => listener()); }
export function trustedHubOrigin(location: Pick<Location, 'hostname' | 'protocol' | 'port'>, embedded: boolean) {
  return embedded && /^p-[a-f0-9]{24}\.hub\.localhost$/.test(location.hostname) && ['http:', 'https:'].includes(location.protocol)
    ? location.protocol + '//hub.localhost' + (location.port ? ':' + location.port : '') : null;
}
/** Same envelope and source rule for every host message: the direct parent at the trusted proxy origin. */
export function isHubMessage(event: Pick<MessageEvent, 'source' | 'origin' | 'data'>, origin: string | null, parent: unknown) {
  if (!origin || event.source !== parent || event.origin !== origin) return false;
  const value = event.data;
  return Boolean(value) && typeof value === 'object' && value.channel === envelope.channel && value.version === 1;
}
export function hostCapabilityList(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string' && /^[a-z-]{1,40}$/.test(item)))].slice(0, 32) : [];
}
/** Old hosts never declared positions; modules must stay silent rather than guess. */
export function canUseHostCapability(isConnected: boolean, capabilities: Iterable<string>, capability: 'positions' | 'fills' | 'open-trading' | 'anthropic-shares') {
  return isConnected && new Set(capabilities).has(capability);
}

export function hubSelectionUrl(current: string, projectId: HubProject, query: HubQuery) {
  // A newly selected asset from the host must leave an older chart selection.
  const url = new URL(projectId === 'monitor' ? perpetualChartUrl(current, null) : current);
  for (const key of HUB_QUERY_KEYS) {
    url.searchParams.delete(key);
    if (query[key]) url.searchParams.set(key, query[key]!);
  }
  if (projectId === 'monitor') url.searchParams.set('monitor', 'perpetual');
  return url.href;
}
function post(value: object) { if (connected && targetOrigin) window.parent.postMessage({ ...envelope, ...value }, targetOrigin); }
export const postHubMessage = post;
export function hubChanged() { post({ type: 'changed', scope: 'summary' }); }
export function hubNavigate(projectId: HubProject, query: HubQuery) { const clean = cleanHubQuery(query); if (clean) post({ type: 'navigate', projectId, query: clean }); }

export type PositionsMarket = 'oil' | 'hynix' | 'anthropic' | 'perpetual';
/** Realized results since the position last opened from zero; signed cash flows in `currency`, `net` null when a part is unknown. */
export type HubPositionCycle = {
  evidence?: CycleEvidence;
  status: 'loading' | 'complete' | 'partial' | 'unavailable'; since: string | null;
  closedQuantity: string | null; closePrice: string | null; realizedPnl: string | null; fees: string | null; funding: string | null; net: string | null;
  currency: string | null; note: string | null; updatedAt: string | null;
};
export type HubPositionItem = {
  key: string; source: string; exchange: string; symbol: string; base: string; side: 'long' | 'short';
  quantity: string; quantityUnit: string; entryPrice: string | null; markPrice: string | null;
  unrealizedPnl: string | null; pnlCurrency: string | null; updatedAt: string | null; stale: boolean;
  /** Stable venue id; older hosts send only the display name in `exchange`. */
  exchangeId?: string;
  /** Absent from older hosts and from venues without fill history. */
  cycle?: HubPositionCycle | null;
};
/** Range fields are absent on older hosts and failed reads. */
type PositionsRange = { truncated: boolean; matchedCount: number; itemLimit: number };
/** Why the host could not read: it was not in the foreground, its read timed out or failed, or the data was malformed. Older hosts omit it. */
export type HubUnavailableReason = 'background' | 'timeout' | 'http' | 'network' | 'malformed';
/** `incomplete` marks unconfirmed sources or a truncated match list. */
export type HubPositionsReply = { requestId: string; market: PositionsMarket; status: 'ok' | 'unavailable' | 'unauthorized'; generatedAt: string | null; incomplete: boolean; sourcesIncomplete?: boolean; items: HubPositionItem[]; timedOut?: boolean;
  reason?: HubUnavailableReason; httpStatus?: number } & Partial<PositionsRange>;
const UNAVAILABLE_REASONS: ReadonlySet<string> = new Set(['background', 'timeout', 'http', 'network', 'malformed']);
const POSITION_MARKETS: ReadonlySet<string> = new Set(['oil', 'hynix', 'anthropic', 'perpetual']);
const REQUEST_ID = /^[A-Za-z0-9-]{1,64}$/, POSITION_BASE = /^[A-Z0-9]{1,20}$/;
// Outlasts the host's own positions read deadline (15 s) so a slow but answered read is not reported as silence.
export const POSITIONS_TIMEOUT_MS = 20_000, POSITIONS_REFRESH_MS = 60_000;
// Longer than the host's 20 s positions cache (which also holds failures) so the follow-up reaches Asset again.
export const POSITIONS_FOLLOW_UP_MS = 25_000;

export function cleanPositionsRequest(market: unknown, symbols: unknown): { market: PositionsMarket; symbols: string[] } | null {
  if (typeof market !== 'string' || !POSITION_MARKETS.has(market) || !Array.isArray(symbols)) return null;
  const clean = [...new Set(symbols.filter((symbol): symbol is string => typeof symbol === 'string' && POSITION_BASE.test(symbol)))].slice(0, 20);
  return clean.length ? { market: market as PositionsMarket, symbols: clean } : null;
}
const text = (value: unknown, max: number) => typeof value === 'string' && value.length <= max ? value : undefined;
const optionalText = (value: unknown, max: number) => value === null ? null : text(value, max);
const CYCLE_STATES: ReadonlySet<string> = new Set(['loading', 'complete', 'partial', 'unavailable']);
function positionCycle(value: unknown): HubPositionCycle | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const cycle = value as Record<string, unknown>;
  const evidence = cycle.evidence === undefined ? undefined : parseCycleEvidence(cycle.evidence);
  if (evidence === null) return undefined;
  const result = {
    status: typeof cycle.status === 'string' && CYCLE_STATES.has(cycle.status) ? cycle.status : undefined, since: optionalText(cycle.since, 40),
    closedQuantity: optionalText(cycle.closedQuantity, 64), closePrice: optionalText(cycle.closePrice, 64), realizedPnl: optionalText(cycle.realizedPnl, 64),
    fees: optionalText(cycle.fees, 64), funding: optionalText(cycle.funding, 64), net: optionalText(cycle.net, 64),
    currency: optionalText(cycle.currency, 20), note: optionalText(cycle.note, 300), updatedAt: optionalText(cycle.updatedAt, 40),
  };
  return Object.values(result).some(field => field === undefined) ? undefined : { ...result, ...(evidence ? { evidence } : {}) } as HubPositionCycle;
}
function positionItem(value: unknown): HubPositionItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const result = {
    key: text(item.key, 200), source: text(item.source, 80), exchange: text(item.exchange, 80), symbol: text(item.symbol, 80),
    base: typeof item.base === 'string' && POSITION_BASE.test(item.base) ? item.base : undefined,
    side: item.side === 'long' || item.side === 'short' ? item.side : undefined,
    quantity: text(item.quantity, 64), quantityUnit: text(item.quantityUnit, 40),
    entryPrice: optionalText(item.entryPrice, 64), markPrice: optionalText(item.markPrice, 64), unrealizedPnl: optionalText(item.unrealizedPnl, 64),
    pnlCurrency: optionalText(item.pnlCurrency, 20), updatedAt: optionalText(item.updatedAt, 40),
    stale: typeof item.stale === 'boolean' ? item.stale : undefined,
  };
  // Copy only the redacted contract fields; anything malformed rejects the whole reply.
  if (Object.values(result).some(field => field === undefined)) return null;
  const cycle = item.cycle === undefined ? undefined : positionCycle(item.cycle);
  if (item.cycle !== undefined && cycle === undefined) return null;
  const extra = { ...(cycle === undefined ? {} : { cycle }) };
  if (item.exchangeId === undefined) return { ...result, ...extra } as HubPositionItem;
  return typeof item.exchangeId === 'string' && /^[a-z0-9-]{1,40}$/.test(item.exchangeId) ? { ...result, exchangeId: item.exchangeId, ...extra } as HubPositionItem : null;
}
export function parsePositionsReply(value: unknown): HubPositionsReply | null {
  if (!value || typeof value !== 'object') return null;
  const reply = value as Record<string, unknown>;
  if (reply.type !== 'positions' || typeof reply.requestId !== 'string' || !REQUEST_ID.test(reply.requestId)) return null;
  if (typeof reply.market !== 'string' || !POSITION_MARKETS.has(reply.market)) return null;
  if (reply.status !== 'ok' && reply.status !== 'unavailable' && reply.status !== 'unauthorized') return null;
  if (reply.generatedAt !== null && (typeof reply.generatedAt !== 'string' || reply.generatedAt.length > 40 || !Number.isFinite(Date.parse(reply.generatedAt)))) return null;
  if (!Array.isArray(reply.items) || reply.items.length > 50) return null;
  const items = reply.items.map(positionItem);
  if (items.some(item => !item)) return null;
  // Older hosts omit the flag; treat that as complete rather than rejecting the reply.
  if (reply.incomplete !== undefined && typeof reply.incomplete !== 'boolean') return null;
  if (reply.sourcesIncomplete !== undefined && typeof reply.sourcesIncomplete !== 'boolean') return null;
  // Diagnostic only: an unknown reason (a newer host) or an inconsistent status is dropped, never the reply.
  const reason = reply.status === 'unavailable' && typeof reply.reason === 'string' && UNAVAILABLE_REASONS.has(reply.reason) ? reply.reason as HubUnavailableReason : undefined;
  const httpStatus = reason === 'http' && typeof reply.httpStatus === 'number' && Number.isInteger(reply.httpStatus) && reply.httpStatus >= 100 && reply.httpStatus <= 599 ? reply.httpStatus : undefined;
  const cause = reason ? { reason, ...(httpStatus !== undefined ? { httpStatus } : {}) } : {};
  let range: Partial<PositionsRange> = {};
  if (reply.truncated !== undefined || reply.matchedCount !== undefined || reply.itemLimit !== undefined) {
    const { truncated, matchedCount, itemLimit } = reply;
    if (typeof truncated !== 'boolean' || typeof matchedCount !== 'number' || !Number.isSafeInteger(matchedCount) || matchedCount < 0
      || typeof itemLimit !== 'number' || !Number.isSafeInteger(itemLimit) || itemLimit < 1 || itemLimit > 50) return null;
    if (items.length !== Math.min(matchedCount, itemLimit) || truncated !== (matchedCount > itemLimit)) return null;
    range = { truncated, matchedCount, itemLimit };
  }
  const ok = reply.status === 'ok';
  // Older hosts do not split the reasons; preserve their existing source warning.
  const sourcesIncomplete = reply.sourcesIncomplete ?? reply.incomplete === true;
  return { requestId: reply.requestId, market: reply.market as PositionsMarket, status: reply.status, generatedAt: reply.generatedAt, incomplete: ok && (reply.incomplete === true || sourcesIncomplete || range.truncated === true), sourcesIncomplete: ok && sourcesIncomplete, items: ok ? items as HubPositionItem[] : [], ...(ok ? range : {}), ...cause };
}
/** Read again sooner than the regular refresh after a failed read, and while Asset summarizes closed trades. */
export function positionsFollowUp(reply: HubPositionsReply) {
  return reply.status === 'unavailable' || reply.status === 'ok' && reply.items.some(item => item.cycle?.status === 'loading');
}
const createRequestId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
/** One requester per consumer: only its most recent request may resolve, and silence becomes unavailable. */
export function createPositionsRequester({ send, onReply, timeoutMs = POSITIONS_TIMEOUT_MS, schedule = setTimeout, cancel = clearTimeout, createId = createRequestId }: {
  send: (message: { type: 'positions-request'; requestId: string; market: PositionsMarket; symbols: string[] }) => void;
  onReply: (reply: HubPositionsReply) => void;
  timeoutMs?: number;
  schedule?: (callback: () => void, ms: number) => unknown;
  cancel?: (timer: never) => void;
  createId?: () => string;
}) {
  const requester = createHubRequester<{ market: PositionsMarket; symbols: string[] }, HubPositionsReply>({
    onReply, timeoutMs, schedule, cancel, createId, parse: parsePositionsReply, market: query => query.market,
    send: (query, requestId) => send({ type: 'positions-request', requestId, ...query }),
    timeout: (query, requestId) => ({ requestId, market: query.market, status: 'unavailable', generatedAt: null, incomplete: false, items: [], timedOut: true }),
  });
  return {
    ...requester,
    request: (market: PositionsMarket, symbols: string[]) => requester.request(cleanPositionsRequest(market, symbols)),
  };
}
export function hubOpenTrading(market: PositionsMarket) {
  if (POSITION_MARKETS.has(market) && canUseHostCapability(connected, hostCapabilities, 'open-trading')) post({ type: 'open-trading', market });
}
function subscribeHub(listener: () => void) { hubListeners.add(listener); return () => { hubListeners.delete(listener); }; }
export type HubAnthropicShares = { outstanding: number; diluted: number };
export type HubAnthropicSharesView = { shares: HubAnthropicShares | null; status: 'standalone' | 'connecting' | 'synced' | 'unavailable' };
const STANDALONE_SHARES: HubAnthropicSharesView = { shares: null, status: 'standalone' };
const CONNECTING_SHARES: HubAnthropicSharesView = { shares: null, status: 'connecting' };
const UNAVAILABLE_SHARES: HubAnthropicSharesView = { shares: null, status: 'unavailable' };
/** Values remain in billions, with the same decimal syntax and bounds as the trading center. */
export function parseHubAnthropicShares(value: unknown): HubAnthropicShares | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { outstanding, diluted } = value as Record<string, unknown>;
  const valid = (entry: unknown): entry is string => typeof entry === 'string' && entry.length <= 24 && /^\d+(?:\.\d{1,18})?$/.test(entry.trim()) && Number(entry) >= 1 && Number(entry) <= 100;
  return valid(outstanding) && valid(diluted) && Number(diluted) >= Number(outstanding) ? { outstanding: Number(outstanding), diluted: Number(diluted) } : null;
}
/** No prior shares survive a missing capability, malformed update, or new bridge session. */
export function createHubAnthropicSharesStore() {
  let snapshot = CONNECTING_SHARES;
  return {
    getSnapshot: () => snapshot,
    reset: () => { snapshot = CONNECTING_SHARES; },
    receive(value: unknown, capabilities: Iterable<string>) {
      const shares = canUseHostCapability(true, capabilities, 'anthropic-shares') ? parseHubAnthropicShares(value) : null;
      if (!shares) snapshot = UNAVAILABLE_SHARES;
      else if (snapshot.status !== 'synced' || snapshot.shares?.outstanding !== shares.outstanding || snapshot.shares?.diluted !== shares.diluted) snapshot = { shares, status: 'synced' };
    },
  };
}
const anthropicShares = createHubAnthropicSharesStore();
/** Standalone defaults are chosen by the panel; embedded views must wait for the trusted host. */
export function useHubAnthropicShares(): HubAnthropicSharesView {
  return useSyncExternalStore(subscribeHub, () => trustedHubOrigin(window.location, window.parent !== window) ? anthropicShares.getSnapshot() : STANDALONE_SHARES, () => STANDALONE_SHARES);
}
/** Host connection and declared capabilities, shared by every consumer of the single bridge. */
export function useHubHost() {
  // Embedding is part of the snapshot so hydration starts from the server's standalone view.
  const snapshot = useSyncExternalStore(subscribeHub, () => `${trustedHubOrigin(window.location, window.parent !== window) ? 1 : 0}|${hubSnapshot}`, () => '0|0|');
  const [embeddedFlag, flag, list] = snapshot.split('|');
  const embedded = embeddedFlag === '1';
  const capabilities = list ? list.split(',') : [];
  return { embedded, connected: flag === '1', positions: canUseHostCapability(flag === '1', capabilities, 'positions'), fills: canUseHostCapability(flag === '1', capabilities, 'fills'), openTrading: canUseHostCapability(flag === '1', capabilities, 'open-trading') };
}
export type HubPositionsView = {
  status: 'standalone' | 'connecting' | 'unsupported' | 'empty' | 'loading' | HubPositionsReply['status'];
  items: HubPositionItem[]; generatedAt: string | null; timedOut: boolean; incomplete: boolean; sourcesIncomplete?: boolean;
  reason?: HubUnavailableReason; httpStatus?: number;
  /** A failed refresh keeps the last good list visible, labelled with its own time. */
  previous: Pick<HubPositionsReply, 'items' | 'generatedAt' | 'incomplete' | 'sourcesIncomplete' | 'truncated' | 'matchedCount' | 'itemLimit'> | null;
} & Partial<PositionsRange>;
type StoredReply = { key: string; reply: HubPositionsReply; previous: HubPositionsView['previous'] };
/** `active` must follow host foreground activity, not background read permission: the host answers background requests without reading. */
export function useHubPositions(market: PositionsMarket, symbols: readonly string[], active: boolean): HubPositionsView {
  const host = useHubHost();
  const symbolKey = cleanPositionsRequest(market, symbols)?.symbols.join(',') ?? '';
  const requestKey = `${market}|${symbolKey}`;
  const mode = !host.embedded ? 'standalone' : !host.connected ? 'connecting' : !host.positions ? 'unsupported' : !symbolKey ? 'empty' : null;
  const [stored, setStored] = useState<StoredReply | null>(null);
  useEffect(() => {
    if (mode || !active) return;
    let followUp: ReturnType<typeof setTimeout> | null = null;
    const requester = createPositionsRequester({
      send: message => post(message),
      onReply: reply => {
        if (followUp) clearTimeout(followUp);
        followUp = positionsFollowUp(reply) ? setTimeout(run, POSITIONS_FOLLOW_UP_MS) : null;
        setStored(current => {
        const sameKey = current?.key === requestKey ? current : null;
        const previous = reply.status === 'ok' ? null : sameKey?.reply.status === 'ok' ? sameKey.reply : sameKey?.previous ?? null;
        return { key: requestKey, reply, previous };
        });
      },
    });
    const listener = (value: unknown) => { requester.receive(value); };
    const reconnected = () => { requester.retry(); };
    positionListeners.add(listener); hostReadyListeners.add(reconnected);
    const run = () => { requester.request(market, symbolKey.split(',')); };
    run();
    const timer = setInterval(run, POSITIONS_REFRESH_MS);
    return () => { clearInterval(timer); if (followUp) clearTimeout(followUp); positionListeners.delete(listener); hostReadyListeners.delete(reconnected); requester.dispose(); };
  }, [mode, active, market, symbolKey, requestKey]);
  if (mode) return { status: mode, items: [], generatedAt: null, timedOut: false, incomplete: false, previous: null };
  const current = stored?.key === requestKey ? stored : null;
  if (!current) return { status: 'loading', items: [], generatedAt: null, timedOut: false, incomplete: false, previous: null };
  return { status: current.reply.status, items: current.reply.items, generatedAt: current.reply.generatedAt, timedOut: Boolean(current.reply.timedOut), reason: current.reply.reason, httpStatus: current.reply.httpStatus, incomplete: current.reply.incomplete, sourcesIncomplete: current.reply.sourcesIncomplete, truncated: current.reply.truncated, matchedCount: current.reply.matchedCount, itemLimit: current.reply.itemLimit, previous: current.previous };
}

export function observeNetworkActivity(update: () => void, source: Pick<Window, 'addEventListener' | 'removeEventListener'> = window) {
  source.addEventListener('online', update); source.addEventListener('offline', update);
  return () => { source.removeEventListener('online', update); source.removeEventListener('offline', update); };
}
export function useHubBridge(projectId: HubProject) {
  // The server cannot see the host, so its HTML assumes a readable page while an embedded client starts inactive
  // to keep reads off until the host replies. Render branches on these flags must hydrate from the server value.
  const [state, setState] = useState(() => ({ connected: false, active: typeof window === 'undefined' || (!trustedHubOrigin(window.location, window.parent !== window) && !document.hidden && navigator.onLine), readActive: typeof window === 'undefined' || (!trustedHubOrigin(window.location, window.parent !== window) && navigator.onLine) }));
  useEffect(() => {
    const origin = trustedHubOrigin(window.location, window.parent !== window);
    let hostActive = !origin, visible = true;
    readActivity.configure(Boolean(origin));
    anthropicShares.reset(); notifyHub();
    const update = () => setState({ connected, active: hostActive && visible && !document.hidden && navigator.onLine, readActive: readActivity.allowed(document.hidden) && navigator.onLine });
    const message = (event: MessageEvent) => {
      if (!isHubMessage(event, origin, window.parent)) return;
      const value = event.data;
      if (value.type === 'ready' && value.role === 'host') {
        targetOrigin = origin!; connected = true; hostCapabilities = new Set(hostCapabilityList(value.capabilities));
        anthropicShares.receive(value.anthropicShares, hostCapabilities); readActivity.connect(); update(); notifyHub();
        post({ type: 'ready', role: 'module', capabilities: [...MODULE_CAPABILITIES] });
        // Sent after our ready so the host has re-accepted this document before the repeated request arrives.
        hostReadyListeners.forEach(listener => listener());
      } else if (connected && value.type === 'activity' && typeof value.active === 'boolean') { hostActive = value.active; anthropicShares.receive(value.anthropicShares, hostCapabilities); readActivity.update(value.active, value.backgroundUpdates); update(); notifyHub(); }
      else if (connected && value.type === 'navigate' && value.projectId === projectId) {
        const query = cleanHubQuery(value.query); if (!query) return;
        window.history.replaceState(null, '', hubSelectionUrl(window.location.href, projectId, query)); window.dispatchEvent(new PopStateEvent('popstate'));
      } else if (connected && value.type === 'positions' && hostCapabilities.has('positions')) positionListeners.forEach(listener => listener(value));
      else if (connected && value.type === 'fills' && hostCapabilities.has('fills')) fillListeners.forEach(listener => listener(value));
    };
    window.addEventListener('message', message); document.addEventListener('visibilitychange', update);
    const stopNetwork = observeNetworkActivity(update);
    const observer = origin && typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting ?? true; update(); }) : null;
    observer?.observe(document.documentElement); update();
    // A ready probe covers hosts whose iframe load event preceded React effects.
    if (origin) window.parent.postMessage({ ...envelope, type: 'ready', role: 'module' }, origin);
    return () => { readActivity.configure(Boolean(origin)); stopNetwork(); observer?.disconnect(); window.removeEventListener('message', message); document.removeEventListener('visibilitychange', update); connected = false; targetOrigin = ''; hostCapabilities = new Set(); anthropicShares.reset(); notifyHub(); };
  }, [projectId]);
  return state;
}
