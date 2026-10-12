import { AppError } from './model.mjs';

/** Read exactly one complete public snapshot and always terminate the connection. */
export function publicSnapshot({ source, WebSocketImpl, subscription, accept, timeoutMs = 8000 }) {
  if (!['wss://futures.kraken.com/ws/v1', 'wss://mainnet.zklighter.elliot.ai/stream?readonly=true'].includes(source)) throw new AppError('不支持的公开盘口来源');
  const validSubscription = source.includes('kraken.com')
    ? Object.keys(subscription).length === 3 && subscription.event === 'subscribe' && subscription.feed === 'book' && Array.isArray(subscription.product_ids) && subscription.product_ids.length === 1 && /^PF_[A-Z0-9]{1,30}USD$/.test(subscription.product_ids[0])
    : Object.keys(subscription).length === 2 && subscription.type === 'subscribe' && /^order_book\/\d{1,8}$/.test(subscription.channel);
  if (!validSubscription) throw new AppError('仅允许订阅公开盘口');
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(source, { handshakeTimeout: timeoutMs, maxPayload: 8 * 1024 * 1024, perMessageDeflate: false, followRedirects: false });
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true; clearTimeout(timer); socket.terminate();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new AppError('公开盘口快照连接超时', 502)), timeoutMs);
    socket.on('open', () => { if (!done) socket.send(JSON.stringify(subscription)); });
    socket.on('error', () => finish(new AppError('公开盘口快照连接失败', 502)));
    socket.on('close', () => finish(new AppError('公开盘口快照连接关闭', 502)));
    socket.on('message', raw => {
      if (done) return;
      try {
        if (raw.length > 8 * 1024 * 1024) throw new AppError('公开盘口快照过大', 502);
        const value = JSON.parse(String(raw));
        if (!value || typeof value !== 'object') throw new AppError('公开盘口快照格式无效', 502);
        if (value.type === 'ping') { socket.send('{"type":"pong"}'); return; }
        if (value.event === 'error' || value.event === 'subscribed_failed' || value.type === 'error') throw new AppError('公开盘口订阅失败', 502);
        if (accept(value)) finish(null, value);
      } catch (error) { finish(error instanceof AppError ? error : new AppError('公开盘口快照格式无效', 502)); }
    });
  });
}
