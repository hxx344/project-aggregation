import { randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import path from 'node:path';
import { moduleIds } from '../modules/catalog.mjs';
import { tradingModules } from '../modules/updates.mjs';

// Internal API between the API process and the runtime process (design doc 5.2).
export const PROTOCOL_VERSION = 1;
export const SUPPORTED_PROTOCOLS = Object.freeze([PROTOCOL_VERSION]);
export const RUNTIME_KEY_HEADER = 'x-workspace-runtime-key';
// Total wall-clock budgets per call, including discovery and the one read retry.
export const BUDGETS = Object.freeze({ read: 5000, maintenance: 15_000, prepareStop: 70_000 });
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 16 * 1024;
// A longer UDS path would be truncated and bind somewhere else.
export const MAX_SOCKET_PATH_BYTES = 100;
const MAX_DISCOVERY_BYTES = 4096;
const DISCOVERY = 'runtime.json';
const windows = process.platform === 'win32';

export const UNAVAILABLE = '运行时不可用';
// origin 'runtime' is a decision the runtime returned; 'transport' means it could not be reached or answered invalidly.
export class RuntimeError extends Error {
  constructor(status, message, { origin = 'runtime', uncertain = false } = {}) { super(publicMessage(message)); this.status = status; this.origin = origin; this.uncertain = uncertain; }
}
// Messages that cross the protocol: control characters become spaces and the length is bounded, so both clients see the same text.
export const MAX_MESSAGE_LENGTH = 400;
// Truncate before trimming so that applying it twice (server, then client) changes nothing.
export const publicMessage = message => (typeof message === 'string' ? message.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, MAX_MESSAGE_LENGTH).trim() : '') || UNAVAILABLE;
export const unavailable = (uncertain = false) => new RuntimeError(503, UNAVAILABLE, { origin: 'transport', uncertain });
const invalid = () => unavailable();

export function equalSecret(value, expected) {
  const input = Buffer.from(typeof value === 'string' ? value : '');
  const secret = Buffer.from(expected);
  return input.length === secret.length && timingSafeEqual(input, secret);
}
export const createSecret = () => randomBytes(32).toString('base64url');

export function runtimeDir(dataDir, env = process.env) {
  return path.resolve(env.WORKBENCH_RUNTIME_DIR || path.join(dataDir, 'run'));
}
// The directory holds the secret and the socket: owned by this uid, no group or other access, never a symlink.
// Both sides check it; an existing directory with wider access is refused rather than changed.
export function checkRuntimeDir(dir) {
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`运行目录不是普通目录：${dir}`);
  if (!windows) {
    if (stat.uid !== process.getuid()) throw new Error(`运行目录属主不是当前用户：${dir}`);
    if (stat.mode & 0o077) throw new Error(`运行目录不能对组或其他用户开放，请设为 0700：${dir}`);
  }
  return dir;
}
export function ensureRuntimeDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return checkRuntimeDir(dir);
}
export function socketPathFor(dir, instanceId) {
  if (windows) return `\\\\.\\pipe\\workbench-runtime-${instanceId}`;
  const socketPath = path.join(dir, `runtime-${instanceId}.sock`);
  // A truncated UDS path would bind somewhere else; refuse instead.
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) throw new Error(`运行时 socket 路径超过 ${MAX_SOCKET_PATH_BYTES} 字节：${socketPath}，请缩短 DATA_DIR 或设置较短的 WORKBENCH_RUNTIME_DIR（服务单元固定使用 /run/project-aggregation）`);
  return socketPath;
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const time = value => text(value, 40) && !Number.isNaN(Date.parse(value));
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const secretText = value => typeof value === 'string' && /^[A-Za-z0-9_-]{32,256}$/.test(value);

export function validateDiscovery(value, dir) {
  if (!object(value) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.protocol) || value.protocol < 1 || !uuid(value.instanceId)
    || !Number.isSafeInteger(value.pid) || value.pid < 1 || !secretText(value.secret) || !time(value.startedAt)
    || value.release !== null && !text(value.release, 80)) throw new Error('Invalid runtime discovery record');
  // The socket must be the one derived from this directory and instance, never a path the file chooses.
  if (value.socketPath !== socketPathFor(dir, value.instanceId)) throw new Error('Invalid runtime discovery record');
  return { schemaVersion: 1, protocol: value.protocol, instanceId: value.instanceId, pid: value.pid, socketPath: value.socketPath, secret: value.secret, startedAt: value.startedAt, release: value.release };
}
export function writeDiscovery(dir, record) {
  const value = validateDiscovery(record, dir);
  const target = path.join(dir, DISCOVERY), temporary = path.join(dir, `.${DISCOVERY}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temporary, target); } catch (error) { rmSync(temporary, { force: true }); throw error; }
}
export function readDiscovery(dir) {
  try { checkRuntimeDir(dir); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const target = path.join(dir, DISCOVERY);
  let fd;
  // O_NONBLOCK: a FIFO planted in place of the file must not block the event loop before fstat rejects it.
  try { fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_DISCOVERY_BYTES) throw new Error('Invalid runtime discovery file');
    if (!windows && (stat.uid !== process.getuid() || stat.mode & 0o077)) throw new Error('Invalid runtime discovery file');
    // lstat after open: O_NOFOLLOW is unavailable on Windows.
    if (lstatSync(target).isSymbolicLink()) throw new Error('Invalid runtime discovery file');
    return validateDiscovery(JSON.parse(readFileSync(fd, 'utf8')), dir);
  } finally { closeSync(fd); }
}
// Leftovers of instances that exited without cleaning up: temporary discovery
// files and their sockets. Only the holder of `.runtime.lock` may call it, so
// no other instance can be using them.
export function removeStaleRuntimeFiles(dir, instanceId) {
  for (const name of readdirSync(dir)) {
    if (/^\.runtime\.json\.[0-9a-f]+\.tmp$/.test(name)) rmSync(path.join(dir, name), { force: true });
    else if (!windows && /^runtime-[0-9a-f-]+\.sock$/.test(name) && name !== `runtime-${instanceId}.sock`) rmSync(path.join(dir, name), { force: true });
  }
}
// Removes the file only while it still names this instance, so a stopping runtime never deletes its successor's record.
// Between the read and the removal no successor can rename its own record in: it needs `.runtime.lock`, which is released after this.
export function removeDiscovery(dir, instanceId) {
  let current = null;
  try { current = readDiscovery(dir); } catch { return; }
  if (current?.instanceId === instanceId) rmSync(path.join(dir, DISCOVERY), { force: true });
}

const STATES = new Set(['starting', 'ready', 'backoff', 'draining', 'fault', 'stopping', 'stopped']);
const EXITS = new Set(['exit', 'signal', 'startup']);
const FAULTS = new Set(['process-tree', 'failures']);
const nullable = (value, check) => value === null || check(value);
const knownIds = (value, ids) => Array.isArray(value) && value.length <= ids.length && new Set(value).size === value.length && value.every(id => ids.includes(id));

function moduleRow(row) {
  if (!object(row) || !moduleIds.includes(row.moduleId) || !STATES.has(row.state) || !count(row.generation) || !count(row.restartCount) || !count(row.consecutiveFailures)
    || !nullable(row.lastExitAt, time) || !nullable(row.lastExitKind, value => EXITS.has(value)) || !nullable(row.readyAt, time) || !nullable(row.nextAttemptAt, time)
    || !nullable(row.waitingFor, value => knownIds(value, moduleIds) && value.length > 0) || !nullable(row.faultReason, value => FAULTS.has(value))) throw invalid();
  return { moduleId: row.moduleId, state: row.state, generation: row.generation, restartCount: row.restartCount, consecutiveFailures: row.consecutiveFailures,
    lastExitAt: row.lastExitAt, lastExitKind: row.lastExitKind, readyAt: row.readyAt, nextAttemptAt: row.nextAttemptAt,
    waitingFor: row.waitingFor && [...row.waitingFor], faultReason: row.faultReason };
}
// Each validator returns a fresh copy limited to the contract fields; both client implementations use them.
export function validateStatus(value, protocols = SUPPORTED_PROTOCOLS) {
  if (!object(value) || value.schemaVersion !== 1 || !protocols.includes(value.protocol) || !uuid(value.instanceId) || typeof value.ready !== 'boolean'
    || typeof value.modulesEnabled !== 'boolean' || !knownIds(value.degraded, moduleIds) || !Array.isArray(value.modules) || value.modules.length > moduleIds.length
    || !value.modulesEnabled && value.modules.length) throw invalid();
  const modules = value.modules.map(moduleRow);
  if (new Set(modules.map(row => row.moduleId)).size !== modules.length) throw invalid();
  return { schemaVersion: 1, protocol: value.protocol, instanceId: value.instanceId, ready: value.ready, degraded: [...value.degraded], modulesEnabled: value.modulesEnabled, modules };
}
export function validateTransport(value, id) {
  if (!object(value) || value.moduleId !== id || !text(value.socketPath, 260) || !secretText(value.secret) || !nullable(value.instanceId, item => text(item, 80)) || !count(value.generation)) throw invalid();
  return { moduleId: id, socketPath: value.socketPath, secret: value.secret, instanceId: value.instanceId, generation: value.generation };
}
export function validateMaintenanceIds(ids) {
  if (!knownIds(ids, tradingModules) || !ids.length) throw new RuntimeError(400, '维护同步的模块列表无效');
  return [...ids];
}
// `generation` is the module instance the sync started with; a runtime that does not report it gives null.
export function validateSync(value, ids) {
  if (!object(value) || typeof value.active !== 'boolean' || !Array.isArray(value.modules) || value.modules.length !== ids.length
    || value.modules.some((row, index) => !object(row) || row.id !== ids[index] || typeof row.confirmed !== 'boolean' || row.generation !== undefined && !nullable(row.generation, count))) throw invalid();
  return { active: value.active, modules: value.modules.map(row => ({ id: row.id, confirmed: row.confirmed, generation: row.generation ?? null })) };
}
export function validatePrepareStop(value) {
  if (!object(value) || value.ready !== true) throw invalid();
  return { ready: true };
}
export function validateRestart(value, id) {
  if (!object(value) || value.accepted !== true || value.moduleId !== id) throw invalid();
  return { accepted: true, moduleId: id };
}
export const validateModuleId = id => {
  if (!moduleIds.includes(id)) throw new RuntimeError(404, '模块不存在');
  return id;
};
// Error statuses and messages the runtime may return; anything else is reported as unavailable.
const ERROR_STATUSES = new Set([400, 404, 405, 409, 503]);
export function runtimeErrorFrom(status, body) {
  const message = object(body) && object(body.error) && text(body.error.message, MAX_MESSAGE_LENGTH) ? body.error.message : null;
  if (!ERROR_STATUSES.has(status) || !message) return invalid();
  return new RuntimeError(status, message);
}
