import WebSocket from 'ws';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getProxyForUrl } from 'proxy-from-env';

const directHttp = new HttpAgent(), directHttps = new HttpsAgent(), proxies = new Map();
function agentFor(url) {
  const target = new URL(url);
  target.protocol = target.protocol === 'wss:' ? 'https:' : 'http:';
  const proxy = getProxyForUrl(target.href);
  if (!proxy) return target.protocol === 'https:' ? directHttps : directHttp;
  if (!proxies.has(proxy)) proxies.set(proxy, new HttpsProxyAgent(proxy));
  return proxies.get(proxy);
}

/** Public feeds need a bounded close path, including peers that never acknowledge Close.
 * Explicit CONNECT agents preserve Upgrade headers and honor HTTP(S)_PROXY/NO_PROXY.
 * Node's global --use-env-proxy HTTP interception can strip WebSocket Upgrade.
 * Compression is disabled to avoid per-connection zlib memory/CPU on small servers.
 */
export class PerpetualWebSocket extends WebSocket {
  constructor(url, { headers } = {}) {
    super(url, { headers, agent: agentFor(url), perMessageDeflate: false, handshakeTimeout: 20_000, maxPayload: 8 * 1024 * 1024 });
  }
}
