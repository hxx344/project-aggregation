import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createPerpetualService } from '../server/perpetual-service.mjs';

async function until(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail('Socket lifecycle did not settle before the deadline');
    await delay(5);
  }
}

function textFrame(value) {
  const body = Buffer.from(JSON.stringify(value));
  assert.ok(body.length < 126);
  return Buffer.concat([Buffer.from([0x81, body.length]), body]);
}

// A real upgraded TCP peer that deliberately never acknowledges Close frames.
async function stubbornPeer(onOpen = () => {}) {
  const sockets = new Set(), timers = new Set();
  let accepted = 0;
  const server = createServer();
  server.on('upgrade', (request, socket) => {
    accepted++; sockets.add(socket);
    socket.on('error', () => {});
    // A TCP FIN still closes the transport; only the WebSocket Close is ignored.
    socket.on('end', () => socket.end());
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', () => {});
    const key = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\n\r\n`);
    onOpen(socket, timers);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `ws://127.0.0.1:${server.address().port}`, sockets,
    get accepted() { return accepted; },
    async close() {
      for (const timer of timers) clearInterval(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

function collector(url, parse = () => []) {
  const market = { exchange: 'test', symbol: 'BTC', base: 'BTC', quoteCurrency: 'USD' };
  return createPerpetualService({
    exchanges: [{ id: 'test', name: 'Test', type: 'cex' }],
    discover: async () => [market],
    subscriptions: () => [{ url, markets: [market], subscribe: [] }],
    parse, control: () => null,
    retryMs: 10, quoteTimeoutMs: 80, watchdogIntervalMs: 10,
  });
}

test('silent websocket peers cannot retain TCP sockets across reconnects or stop', async t => {
  const peer = await stubbornPeer(), service = collector(peer.url);
  t.after(async () => { await service.stop(); await peer.close(); });
  service.start();
  await until(() => peer.accepted >= 3);
  await until(() => peer.sockets.size === 1);
  assert.equal(service.metrics().connections, 1);
  await service.stop();
  await until(() => peer.sockets.size === 0);
  assert.equal(service.metrics().connections, 0);
  const acceptedAtStop = peer.accepted;
  await delay(100);
  assert.equal(peer.accepted, acceptedAtStop, 'Stopped collectors must not start another retry');
});

test('heartbeats alone cannot keep a websocket with frozen prices alive', async t => {
  let heartbeats = 0, quotes = 0;
  const peer = await stubbornPeer((socket, timers) => {
    socket.write(textFrame({ quote: true }));
    const timer = setInterval(() => { if (!socket.destroyed) socket.write(textFrame({ pong: true })); }, 5);
    timers.add(timer);
    socket.once('close', () => { clearInterval(timer); timers.delete(timer); });
  });
  const service = collector(peer.url, (_exchange, payload, markets, receivedAt) => {
    if (!payload.quote) { heartbeats++; return []; }
    quotes++;
    return [{ ...markets[0], bid: 100, ask: 101, sourceTime: receivedAt }];
  });
  t.after(async () => { await service.stop(); await peer.close(); });
  service.start();
  await until(() => peer.accepted >= 2 && quotes >= 2);
  assert.ok(heartbeats >= 5, 'Application heartbeats continued while price updates were frozen');
  await service.stop();
  await until(() => peer.sockets.size === 0);
});
