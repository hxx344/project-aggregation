// Only the supervisor can register a transport. Browser project settings never
// supply pipe names or credentials; virtual origins fail closed when stopped.
const ids = new Set(['monitor', 'asset', 'crossex', 'greeks', 'aster']);
const transports = new Map();
export const moduleOrigin = id => {
  if (!ids.has(id)) throw new Error('Unknown embedded module');
  return `http://${id}.workspace.internal`;
};
// A restarted instance replaces its predecessor only with a larger generation.
// Calls without a generation register as generation 0 and keep the old
// one-registration-per-module behaviour.
export function registerModuleTransport(id, transport, { instanceId = null, generation = 0 } = {}) {
  const origin = moduleOrigin(id);
  if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('Invalid module generation');
  const current = transports.get(origin);
  if (current && generation <= current.generation) throw new Error('Module transport already registered');
  if (!transport?.socketPath || typeof transport.secret !== 'string' || transport.secret.length < 32) throw new Error('Invalid module transport');
  const value = Object.freeze({ socketPath: transport.socketPath, secret: transport.secret, instanceId, generation });
  transports.set(origin, value);
  return () => { if (transports.get(origin) === value) transports.delete(origin); };
}
export function moduleTransport(value) {
  const url = value instanceof URL ? value : new URL(value);
  if (!url.hostname.endsWith('.workspace.internal')) return null;
  const transport = transports.get(url.origin);
  if (!transport || url.username || url.password) throw new Error('Embedded module is unavailable');
  return transport;
}
