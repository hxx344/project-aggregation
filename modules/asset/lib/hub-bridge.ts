export type HubNavigation = { projectId: string; query: Record<string, string> };
type Callbacks = { onActivity: (active: boolean) => void; onNavigate?: (navigation: HubNavigation) => void };
const CHANNEL = 'project-hub';

export function trustedHubOrigin(location: Pick<Location, 'hostname' | 'protocol' | 'port'>, embedded: boolean) {
  if (!embedded || !/^p-[a-f0-9]{24}\.hub\.localhost$/.test(location.hostname) || !['http:', 'https:'].includes(location.protocol)) return null;
  return `${location.protocol}//hub.localhost${location.port ? ':' + location.port : ''}`;
}

export function createHubBridge(callbacks: Callbacks, target: Window = window) {
  const origin = trustedHubOrigin(target.location, target.parent !== target);
  let disposed = false;
  // Proxy frames wait for the host's initial activity decision, even if the
  // iframe loads before the dashboard effect has registered its listener.
  let active = !origin;
  let connected = !origin, backgroundUpdates = !origin;
  const send = (message: Record<string, unknown>) => {
    if (origin && !disposed) target.parent.postMessage({ channel: CHANNEL, version: 1, ...message }, origin);
  };
  const ready = () => send({ type: 'ready', role: 'module', capabilities: ['activity', 'changed', 'navigate'] });
  const receive = (event: MessageEvent) => {
    if (!origin || event.source !== target.parent || event.origin !== origin || !event.data || typeof event.data !== 'object') return;
    const message = event.data;
    if (message.channel !== CHANNEL || message.version !== 1) return;
    if (message.type === 'ready' && message.role === 'host') { connected = true; ready(); }
    else if (connected && message.type === 'activity' && typeof message.active === 'boolean') {
      active = message.active;
      backgroundUpdates = message.backgroundUpdates === true;
      callbacks.onActivity(active);
    } else if (connected && message.type === 'navigate' && typeof message.projectId === 'string' && message.query && typeof message.query === 'object' && !Array.isArray(message.query) && Object.values(message.query).every(value => typeof value === 'string')) {
      callbacks.onNavigate?.({ projectId: message.projectId, query: message.query });
    }
  };
  if (origin) { target.addEventListener('message', receive); ready(); }
  return {
    get active() { return active; },
    get readActive() { return !disposed && connected && (backgroundUpdates || (active && !target.document?.hidden)); },
    changed: () => send({ type: 'changed', scope: 'summary' }),
    dispose() { disposed = true; if (origin) target.removeEventListener('message', receive); },
  };
}
