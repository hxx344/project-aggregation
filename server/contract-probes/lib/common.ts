// Shared pieces of the real-venue contract probes (plan stage 2.6a/2.6b). The probes are
// operator-run scripts, not part of the executor: they read by default and send a write only
// with `--live` plus a confirmation phrase that names the venue, the instrument and the size.
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

export class ProbeAbort extends Error {}
/** Raised before a request leaves this process: nothing was sent. */
export class NotSent extends ProbeAbort {}

export type Flags = Record<string, string | boolean | undefined>;

export function readFlags(argv: string[], strings: readonly string[], booleans: readonly string[]): Flags {
  const options: Record<string, { type: 'string' | 'boolean' }> = {};
  for (const name of strings) options[name] = { type: 'string' };
  for (const name of booleans) options[name] = { type: 'boolean' };
  try { return parseArgs({ args: argv, options, allowPositionals: false, strict: true }).values as Flags; }
  catch (error) { throw new ProbeAbort('参数无效：' + (error instanceof Error ? error.message : String(error))); }
}

/** KEY=VALUE lines of an env file; values keep their text apart from one pair of surrounding quotes. */
export function parseEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2]!.trim(), quoted = /^(['"])(.*)\1$/.exec(value);
    values[match[1]!] = quoted ? quoted[2]! : value;
  }
  return values;
}

/** Process environment, with an optional env file filling in names the process does not set. */
export function environment(envFile: string | undefined): Record<string, string> {
  const merged: Record<string, string> = envFile ? parseEnvFile(readFileSync(envFile, 'utf8')) : {};
  for (const [name, value] of Object.entries(process.env)) if (typeof value === 'string' && value) merged[name] = value;
  return merged;
}

/** Positive canonical decimal with at most `digits` fractional digits, or abort. */
export function positiveDecimal(value: string | undefined, name: string, digits: number): string {
  if (typeof value !== 'string' || !new RegExp(`^\\d{1,12}(?:\\.\\d{1,${digits}})?$`).test(value) || Number(value) <= 0) throw new ProbeAbort(`${name} 必须是正的十进制数值`);
  const trimmed = value.replace(/^0+(?=\d)/, '');
  return trimmed.includes('.') ? trimmed.replace(/0+$/, '').replace(/\.$/, '') : trimmed;
}

export function boundedInteger(value: string | undefined, name: string, fallback: number, low: number, high: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!/^\d{1,9}$/.test(value) || parsed < low || parsed > high) throw new ProbeAbort(`${name} 必须是 ${low} 到 ${high} 之间的整数`);
  return parsed;
}

/** Writes are allowed only with `--live` and the exact phrase the read-only run printed. */
export function liveAllowed(flags: Flags, phrase: string): boolean {
  if (flags.live !== true) {
    if (flags.confirm !== undefined) throw new ProbeAbort('--confirm 只能与 --live 一起使用');
    return false;
  }
  if (flags.confirm !== phrase) throw new ProbeAbort(`--live 需要 --confirm ${phrase}（确认短语包含本次的标的与数量，参数变化后须重新确认）`);
  return true;
}

const ADDRESS = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
/** Hex runs of 32 bytes or more: signatures, keys and hashes echoed inside messages. */
const LONG_HEX = /(?:0x)?[0-9a-fA-F]{64,}/g;
const SECRET_KEYS = /^(signature|apiKey|api_key|secret|apiSecret|private_?key|ips|note|userID|uid|parentUid|inviterID|kycLevel|kycRegion|accountId|email|subAccountName)$/i;

const registered: string[] = [];
/** Values that must never reach the console or a report, in whatever text they turn up. */
export function registerSecrets(...values: string[]): void {
  for (const value of values) if (typeof value === 'string' && value.length >= 6) registered.push(value);
}

/** Copy of a value safe to hand back: secrets removed, wallet addresses shortened to first and last four digits. */
export function redact(value: unknown, secrets: readonly string[] = []): unknown {
  const known = [...registered, ...secrets.filter(secret => typeof secret === 'string' && secret.length >= 6)];
  const clean = (text: string): string => {
    let out = text;
    for (const secret of known) out = out.split(secret).join('[已隐去]');
    return out.replace(LONG_HEX, '[已隐去]').replace(ADDRESS, address => address.slice(0, 6) + '…' + address.slice(-4));
  };
  const walk = (node: unknown, depth: number): unknown => {
    if (typeof node === 'string') return clean(node);
    if (node === null || typeof node !== 'object') return node;
    if (depth > 12) return '[嵌套过深]';
    if (Array.isArray(node)) return node.map(item => walk(item, depth + 1));
    return Object.fromEntries(Object.entries(node).map(([key, item]) => [clean(key), SECRET_KEYS.test(key) ? '[已隐去]' : walk(item, depth + 1)]));
  };
  return walk(value, 0);
}

export interface HttpResult {
  status: number;
  /** Local wall-clock milliseconds just before the request left and when its body had been read. */
  sentAt: number;
  receivedAt: number;
  /** The response's HTTP Date header as epoch milliseconds (whole seconds), when present. */
  serverDate: number | null;
  headers: Record<string, string>;
  body: unknown;
  /** True when the body was not JSON; `body` then holds at most 300 characters of it. */
  raw: boolean;
}

export class HttpFailure extends Error {
  readonly dispatched: boolean;
  constructor(message: string, dispatched: boolean) { super(message); this.dispatched = dispatched; }
}

const KEPT_HEADERS = /^(date|retry-after|x-mbx-used-weight.*|x-bapi-limit.*|x-ratelimit.*|ret_code|traceid|timenow)$/i;

/**
 * One HTTP exchange: fixed timeout, no retry, no redirect. A failure after dispatch throws
 * `HttpFailure` with `dispatched: true`, which a caller must treat as "outcome unknown" for a write.
 */
export async function exchange(url: string, init: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string }, timeoutMs: number): Promise<HttpResult> {
  checkInterrupt();
  waitSeam();
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  const sentAt = Date.now();
  try {
    const response = await fetch(url, { ...init, redirect: 'error', cache: 'no-store', signal: controller.signal });
    const content = await response.text(), receivedAt = Date.now();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => { if (KEPT_HEADERS.test(name)) headers[name.toLowerCase()] = value; });
    const date = Date.parse(response.headers.get('date') ?? '');
    let body: unknown, raw = false;
    try { body = JSON.parse(content); } catch { body = content.slice(0, 300); raw = true; }
    return { status: response.status, sentAt, receivedAt, serverDate: Number.isFinite(date) ? date : null, headers, body, raw };
  } catch (error) {
    throw new HttpFailure(controller.signal.aborted ? `请求超过 ${timeoutMs} ms 未完成` : '网络请求失败：' + (error instanceof Error ? error.message : String(error)), true);
  } finally { clearTimeout(timer); }
}

let interrupted = false, honorInterrupt = true;
/**
 * First Ctrl-C or SIGTERM: the run stops at its next request or wait and goes through its normal
 * wind-down (which still talks to the venue); a second one ends the process at once.
 */
export function watchSignals(): void {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
    if (interrupted) { process.stderr.write('再次收到中断信号，立即退出；请在交易所核对残留\n'); process.exit(2); }
    interrupted = true;
    process.stderr.write('收到中断信号：停止后续步骤并收尾，再按一次立即退出\n');
  });
}
/** Wind-down code calls this so its own requests are not refused by the pending interrupt. */
export function ignoreInterrupt(): void { honorInterrupt = false; }
function checkInterrupt(): void { if (interrupted && honorInterrupt) throw new NotSent('收到中断信号'); }

const WAIT_SEAM = Symbol.for('project-aggregation.contract-probes.wait-seam');
type Pause = (ms: number) => Promise<void>;
/**
 * Test seam. The offline stand-in (platform/executor/test/contract-stub.ts, preloaded with `node --import`) replaces
 * fetch and registers here that fetch with a pause that advances its own clock, so waits, deadlines and timestamps
 * keep their real lengths without taking wall-clock time. The probes read no flag or environment variable to enable
 * it: only preloaded code can register, and the workbench starts the probes with NODE_OPTIONS cleared. A registration whose fetch is not the one in use would put
 * shortened waits in front of a real venue, so the run stops before its next request.
 */
function waitSeam(): Pause | null {
  const seam = (globalThis as unknown as Record<symbol, unknown>)[WAIT_SEAM];
  if (seam === undefined) return null;
  const { fetch: paired, pause } = (seam ?? {}) as { fetch?: unknown; pause?: unknown };
  if (paired !== globalThis.fetch || typeof pause !== 'function') throw new NotSent('检测到测试用的等待替换，但请求不会发往测试替身：拒绝运行');
  return pause as Pause;
}

export async function sleep(ms: number): Promise<void> {
  const pause: Pause = waitSeam() ?? (chunk => new Promise(resolve => setTimeout(resolve, chunk)));
  for (let rest = ms; rest > 0; rest -= 200) { checkInterrupt(); await pause(Math.min(rest, 200)); }
  checkInterrupt();
}

export interface Report {
  probe: string;
  startedAt: string;
  mode: 'read-only' | 'live';
  parameters: Record<string, unknown>;
  steps: { name: string; at: string; detail: unknown }[];
  findings: Record<string, unknown>;
  writes: { name: string; at: string; outcome: string }[];
  outcome: string;
}

export function createReport(probe: string, mode: Report['mode'], parameters: Record<string, unknown>): Report {
  return { probe, startedAt: new Date().toISOString(), mode, parameters, steps: [], findings: {}, writes: [], outcome: 'incomplete' };
}

export function step(report: Report, name: string, detail: unknown): void {
  report.steps.push({ name, at: new Date().toISOString(), detail });
  process.stdout.write(`[${new Date().toISOString()}] ${name}\n`);
}

/** Creates the report file owner-only before anything is sent, so a bad path cannot lose a live run's evidence. */
export function reserveReport(path: string): void {
  try { closeSync(openSync(path, 'wx', 0o600)); }
  catch (error) { throw new ProbeAbort(`无法创建报告文件 ${path}（已存在或目录不可写）：${error instanceof Error ? error.message : String(error)}`); }
}

/** Writes the redacted report into the reserved file and returns its path. */
export function saveReport(report: Report, path: string): string {
  writeFileSync(path, JSON.stringify(redact(report), null, 2) + '\n');
  return path;
}

/** Console text with registered secrets, long hex runs and full addresses removed. */
export const safeText = (value: unknown): string => String(redact(value instanceof Error ? value.message : String(value)));
