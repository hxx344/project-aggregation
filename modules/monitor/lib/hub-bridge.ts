"use client";

import { useEffect, useState } from 'react';
import { readActivity } from './read-activity.ts';
import { perpetualChartUrl } from './perpetual-chart-state.ts';

import { cleanHubQuery, HUB_QUERY_KEYS, type HubQuery } from '../../../server/hub-navigation.mjs';
export { cleanHubQuery, HUB_QUERY_KEYS };
export type { HubQuery };
export type HubProject = 'monitor' | 'crossex';
const envelope = { channel: 'project-hub', version: 1 } as const;
let targetOrigin = '', connected = false;
export function trustedHubOrigin(location: Pick<Location, 'hostname' | 'protocol' | 'port'>, embedded: boolean) {
  return embedded && /^p-[a-f0-9]{24}\.hub\.localhost$/.test(location.hostname) && ['http:', 'https:'].includes(location.protocol)
    ? location.protocol + '//hub.localhost' + (location.port ? ':' + location.port : '') : null;
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
export function hubChanged() { post({ type: 'changed', scope: 'summary' }); }
export function hubNavigate(projectId: HubProject, query: HubQuery) { const clean = cleanHubQuery(query); if (clean) post({ type: 'navigate', projectId, query: clean }); }
export function observeNetworkActivity(update: () => void, source: Pick<Window, 'addEventListener' | 'removeEventListener'> = window) {
  source.addEventListener('online', update); source.addEventListener('offline', update);
  return () => { source.removeEventListener('online', update); source.removeEventListener('offline', update); };
}
export function useHubBridge(projectId: HubProject) {
  const [state, setState] = useState(() => ({ connected: false, active: typeof window === 'undefined' || (!trustedHubOrigin(window.location, window.parent !== window) && !document.hidden && navigator.onLine), readActive: typeof window === 'undefined' || (!trustedHubOrigin(window.location, window.parent !== window) && navigator.onLine) }));
  useEffect(() => {
    const origin = trustedHubOrigin(window.location, window.parent !== window);
    let hostActive = !origin, visible = true;
    readActivity.configure(Boolean(origin));
    const update = () => setState({ connected, active: hostActive && visible && !document.hidden && navigator.onLine, readActive: readActivity.allowed(document.hidden) && navigator.onLine });
    const message = (event: MessageEvent) => {
      if (!origin || event.source !== window.parent || event.origin !== origin) return;
      const value = event.data;
      if (!value || value.channel !== envelope.channel || value.version !== 1) return;
      if (value.type === 'ready' && value.role === 'host') {
        targetOrigin = origin; connected = true; readActivity.connect(); update();
        post({ type: 'ready', role: 'module', capabilities: ['activity', 'navigate', 'changed'] });
      } else if (connected && value.type === 'activity' && typeof value.active === 'boolean') { hostActive = value.active; readActivity.update(value.active, value.backgroundUpdates); update(); }
      else if (connected && value.type === 'navigate' && value.projectId === projectId) {
        const query = cleanHubQuery(value.query); if (!query) return;
        window.history.replaceState(null, '', hubSelectionUrl(window.location.href, projectId, query)); window.dispatchEvent(new PopStateEvent('popstate'));
      }
    };
    window.addEventListener('message', message); document.addEventListener('visibilitychange', update);
    const stopNetwork = observeNetworkActivity(update);
    const observer = origin && typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting ?? true; update(); }) : null;
    observer?.observe(document.documentElement); update();
    // A ready probe covers hosts whose iframe load event preceded React effects.
    if (origin) window.parent.postMessage({ ...envelope, type: 'ready', role: 'module' }, origin);
    return () => { readActivity.configure(Boolean(origin)); stopNetwork(); observer?.disconnect(); window.removeEventListener('message', message); document.removeEventListener('visibilitychange', update); connected = false; targetOrigin = ''; };
  }, [projectId]);
  return state;
}
