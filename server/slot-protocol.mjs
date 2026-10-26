import { chmodSync, lstatSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

// The contract between the stable entry and the API slots (design doc
// api-dual-slot 3.2–3.4). It sits outside server/api, so it is part of the
// runtime component key: an API-only update cannot change it, and the entry,
// which an API-only update does not restart, always speaks the same version.
export const SLOT_PROTOCOL = 1;
export const SLOTS = ['a', 'b'];

// probe.sock: the installer's checks, in both modes; http.sock: the entry's
// traffic, only while serving; ctl.sock: identity and promotion. Traffic never
// reaches the control socket.
export const slotSockets = dir => ({ probe: path.join(dir, 'probe.sock'), http: path.join(dir, 'http.sock'), ctl: path.join(dir, 'ctl.sock') });

// The units' runtime directories under one root (/run): each slot's sockets,
// and the entry's own control socket.
export const slotDirectory = (root, slot) => path.join(root, `project-aggregation-api-${slot}`);
export const entrySockets = dir => ({ ctl: path.join(dir, 'ctl.sock') });

// PROXY protocol v1 (haproxy): one line before the connection's own bytes.
// 107 bytes, CRLF included, is the specification's maximum line length.
export const PROXY_HEADER_MAX = 107;
export const PROXY_HEADER_TIMEOUT_MS = 2000;
const PROXY_LINE = /^PROXY (TCP4|TCP6) (\S+) (\S+) (\d{1,5}) (\d{1,5})$/;

export function encodeProxyHeader({ remoteAddress, remotePort, localAddress, localPort }) {
  const family = net.isIPv4(remoteAddress) && net.isIPv4(localAddress) ? 'TCP4' : 'TCP6';
  const header = `PROXY ${family} ${remoteAddress} ${localAddress} ${remotePort} ${localPort}\r\n`;
  if (!parseProxyLine(header.slice(0, -2))) throw new TypeError('无法编码连接地址');
  return header;
}

export function parseProxyLine(line) {
  const match = PROXY_LINE.exec(line);
  if (!match) return null;
  const [, family, source, destination, sourcePort, destinationPort] = match;
  const valid = family === 'TCP4' ? net.isIPv4 : net.isIPv6;
  const ports = [Number(sourcePort), Number(destinationPort)];
  if (!valid(source) || !valid(destination) || ports.some(port => port > 65535)) return null;
  return { remoteAddress: source, localAddress: destination, remotePort: ports[0], localPort: ports[1] };
}

// The addresses a PROXY header gave each private connection.
const proxied = new WeakMap();
export const clientAddress = req => proxied.get(req.socket)?.remoteAddress ?? req.socket?.remoteAddress;
export const localPortOf = req => proxied.get(req.socket)?.localPort ?? req.socket?.localPort;

// Makes an HTTP server read the PROXY line of every connection before parsing
// HTTP; a connection without a valid line within timeoutMs is destroyed.
// After the line, the rest of the chunk goes back to the socket and the
// socket is resumed for the HTTP parser.
export function acceptProxyHeader(server, { timeoutMs = PROXY_HEADER_TIMEOUT_MS, onReject = () => {} } = {}) {
  const [connection] = server.listeners('connection');
  if (typeof connection !== 'function') throw new Error('HTTP server has no connection listener');
  server.removeListener('connection', connection);
  server.on('connection', socket => {
    let buffered = Buffer.alloc(0);
    const reject = reason => { cleanup(); onReject(reason); socket.destroy(); };
    const timer = setTimeout(() => reject('timeout'), timeoutMs);
    const onData = chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf('\r\n');
      if (end < 0) { if (buffered.length >= PROXY_HEADER_MAX) reject('too-long'); return; }
      if (end + 2 > PROXY_HEADER_MAX) { reject('too-long'); return; }
      const addresses = parseProxyLine(buffered.subarray(0, end).toString('latin1'));
      if (!addresses) { reject('malformed'); return; }
      cleanup(); socket.pause();
      proxied.set(socket, addresses);
      const rest = buffered.subarray(end + 2);
      if (rest.length) socket.unshift(rest);
      connection.call(server, socket);
      socket.resume();
    };
    const onClose = () => cleanup();
    function cleanup() { clearTimeout(timer); socket.removeListener('data', onData); socket.removeListener('close', onClose); }
    socket.on('data', onData); socket.once('close', onClose); socket.on('error', () => {});
  });
}

// `.api-slot`, written by the installer as root: which slot serves, from which
// release directory. Missing or invalid means no slot is recorded; a record
// this process cannot read is an error, not a reason to start as a candidate.
export function readSlotRecord(file) {
  let text, value;
  try { text = readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || !SLOTS.includes(value.slot) || typeof value.release !== 'string' || !path.isAbsolute(value.release)) return null;
  return { slot: value.slot, release: value.release };
}

// A slot serves only when the record names it and its own release directory.
export function recordNames(record, { slot, release }) {
  if (!record || record.slot !== slot) return false;
  try { return realpathSync(record.release) === release; } catch { return false; }
}

// A slot's or the entry's socket directory is its unit's RuntimeDirectory:
// this user's and closed to everyone else, which keeps the sockets private.
export function assertPrivateDirectory(dir) {
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error(`私有 socket 目录须为本用户所有且权限为 0700：${dir}`);
}
// Removes a socket a killed process left; one that still answers is in use,
// and anything that is not a socket stays and makes listen() fail.
export async function removeStale(file) {
  try { if (!lstatSync(file).isSocket()) return; } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const live = await new Promise(resolve => {
    const socket = net.connect(file);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', error => resolve(error.code === 'ENOENT' ? null : error.code !== 'ECONNREFUSED'));
  });
  if (live) throw Object.assign(new Error(`私有 socket 正被另一个进程使用：${file}`), { code: 'EADDRINUSE' });
  if (live === false) try { unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
export async function listenPrivate(server, file) {
  await removeStale(file);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(file, () => { server.off('error', reject); resolve(); }); });
  chmodSync(file, 0o600);
}

// One JSON request on a control socket (a slot's or the entry's), which
// carries no PROXY line. Rejects on a connection error, a timeout or a reply
// that is not JSON; the reply's status is the caller's to judge.
export function controlRequest(file, method, route, { body, timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ socketPath: file, method, path: route, agent: false, timeout: timeoutMs, headers: encoded ? { 'Content-Type': 'application/json' } : {} }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }); } catch { reject(new Error(`控制接口的应答不是 JSON：${file}`)); } });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error(`控制接口超时：${file}`), { code: 'ETIMEDOUT' })));
    req.on('error', reject); req.end(encoded);
  });
}
