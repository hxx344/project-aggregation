// Only the supervisor can register a transport. Browser project settings never
// supply pipe names or credentials; virtual origins fail closed when stopped.
const ids = new Set(['monitor', 'asset', 'crossex', 'greeks']);
const transports = new Map();
export const moduleOrigin = id => {
  if (!ids.has(id)) throw new Error('Unknown embedded module');
  return `http://${id}.workspace.internal`;
};
export function registerModuleTransport(id, transport) {
  const origin = moduleOrigin(id);
  if (transports.has(origin)) throw new Error('Module transport already registered');
  if (!transport?.socketPath || typeof transport.secret !== 'string' || transport.secret.length < 32) throw new Error('Invalid module transport');
  const value = Object.freeze({ socketPath: transport.socketPath, secret: transport.secret });
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
