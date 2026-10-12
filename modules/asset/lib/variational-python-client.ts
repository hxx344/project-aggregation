import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { z } from 'zod';
import { hasValidVariationalBalance, validateVariationalCredential, VARIATIONAL_ERRORS } from './variational-shared.ts';
import type { VariationalCredential } from './variational-shared.ts';
import type { VariationalDiagnosticOutcome, VariationalDiagnosticResult } from './variational-diagnostic-types.ts';
import type { Position } from './positions-types.ts';

export type VariationalPythonOperation = 'diagnose-session' | 'diagnose-portfolio' | 'sync-portfolio' | 'sync-positions';
type PythonResult = { result: VariationalDiagnosticResult; balance: number | string | null; positions?: Position[] | null };
const TARGETS = {
  'diagnose-session': { endpoint: 'session', path: '/api/me' },
  'diagnose-portfolio': { endpoint: 'portfolio', path: '/api/portfolio?compute_margin=true' },
  'sync-portfolio': { endpoint: 'portfolio', path: '/api/portfolio?compute_margin=true' },
  'sync-positions': { endpoint: 'portfolio', path: '/api/positions' },
} as const;
const MAX_OUTPUT_BYTES = 8192;
const DEADLINE_MS = 23_000;
const resultSchema = z.object({
  endpoint: z.enum(['session', 'portfolio']), path: z.enum(['/api/me', '/api/portfolio?compute_margin=true', '/api/positions']),
  status: z.number().int().min(100).max(599).nullable(),
  contentType: z.enum(['json', 'html', 'other', 'missing']).nullable(),
  challenge: z.boolean(), elapsedMs: z.number().int().min(0).max(DEADLINE_MS + 1000),
  structureOk: z.boolean().nullable(),
  outcome: z.enum(['ok', 'challenge', 'unauthorized', 'forbidden', 'rate_limited', 'redirect', 'html', 'invalid_data', 'timeout', 'network_error', 'cancelled']),
}).strict();
const syncSchema = resultSchema.extend({
  balance: z.union([z.number().finite(), z.string().max(128)]).refine(hasValidVariationalBalance).nullable(),
}).strict();
const decimalSchema = z.string().max(128).regex(/^-?\d+(?:\.\d+)?$/);
const nullableDecimal = decimalSchema.nullable();
const publicText = z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:/ -]+$/);
const positionSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/), symbol: publicText, instrumentId: publicText,
  side: z.enum(['long', 'short']), quantity: decimalSchema.refine(value => !value.startsWith('-') && /[1-9]/.test(value)), quantityUnit: publicText,
  contractSize: nullableDecimal, entryPrice: nullableDecimal, markPrice: nullableDecimal, notional: nullableDecimal,
  unrealizedPnl: nullableDecimal, leverage: nullableDecimal, liquidationPrice: nullableDecimal,
  priceCurrency: publicText.nullable(), notionalCurrency: publicText.nullable(), pnlCurrency: publicText.nullable(), marginMode: publicText.nullable(),
  sourceUpdatedAt: z.string().datetime().nullable(),
}).strict();
const positionsSchema = resultSchema.extend({ positions: z.array(positionSchema).max(1000).nullable() }).strict();

export async function runVariationalPython(c: VariationalCredential, operation: VariationalPythonOperation, signal?: AbortSignal, launch: typeof spawn = spawn): Promise<PythonResult> {
  validateVariationalCredential(c);
  if (!Object.hasOwn(TARGETS, operation)) throw new Error(VARIATIONAL_ERRORS.invalid_data);
  const target = TARGETS[operation];
  const started = performance.now();
  const fallback = (outcome: VariationalDiagnosticOutcome): PythonResult => ({
    result: { ...target, status: null, contentType: null, challenge: false,
      elapsedMs: Math.max(0, Math.round(performance.now() - started)), structureOk: null, outcome },
    balance: null, ...(operation === 'sync-positions' ? { positions: null } : {}),
  });
  return new Promise<PythonResult>(done => {
    if (signal?.aborted) { done(fallback('cancelled')); return; }
    // Credentials only enter stdin; do not inherit application secrets or Python hooks.
    const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? 'production' };
    for (const key of ['PATH', 'SystemRoot', 'WINDIR']) if (process.env[key]) env[key] = process.env[key];
    let child: ReturnType<typeof spawn>;
    try {
      child = launch(process.platform === 'win32' ? 'python' : 'python3', ['-I', '-B', resolve('scripts/variational-diagnostic.py')], {
        shell: false, windowsHide: true, env, stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch (error) {
      done(fallback(error instanceof Error && 'code' in error && error.code === 'ENOENT' ? 'client_unavailable' : 'client_error'));
      return;
    }
    let failure: VariationalDiagnosticOutcome | undefined;
    let bytes = 0;
    const chunks: Buffer[] = [];
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const stop = (outcome: VariationalDiagnosticOutcome) => {
      if (failure || closed) return;
      failure = outcome;
      child.stdin?.destroy();
      hardKill = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 250);
      child.kill('SIGTERM');
    };
    const cancel = () => stop('cancelled');
    const deadline = setTimeout(() => stop('timeout'), DEADLINE_MS);
    signal?.addEventListener('abort', cancel, { once: true });
    child.on('error', (error: NodeJS.ErrnoException) => {
      failure ??= error.code === 'ENOENT' ? 'client_unavailable' : 'client_error';
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (failure) return;
      bytes += chunk.length;
      if (bytes > (operation === 'sync-positions' ? 2_000_000 : MAX_OUTPUT_BYTES)) { stop('client_error'); return; }
      chunks.push(chunk);
    });
    child.stdin?.on('error', () => stop('client_error'));
    child.once('close', code => {
      closed = true;
      clearTimeout(deadline); clearTimeout(hardKill);
      signal?.removeEventListener('abort', cancel);
      if (failure || code !== 0) { done(fallback(failure ?? 'client_error')); return; }
      try {
        const raw: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const syncData = operation === 'sync-portfolio' ? syncSchema.parse(raw) : null;
        const positionsData = operation === 'sync-positions' ? positionsSchema.parse(raw) : null;
        const data = syncData ?? positionsData ?? resultSchema.parse(raw);
        if (data.endpoint !== target.endpoint || data.path !== target.path) throw new Error();
        if (data.outcome === 'ok' && (data.status === null || data.status < 200 || data.status >= 300 || data.contentType !== 'json' || data.challenge || data.structureOk !== true)) throw new Error();
        const balance = syncData?.balance ?? null;
        if (operation === 'sync-portfolio' && (data.outcome === 'ok' ? balance === null : balance !== null)) throw new Error();
        if (positionsData && (data.outcome === 'ok' ? positionsData.positions === null : positionsData.positions !== null)) throw new Error();
        if (positionsData?.positions && new Set(positionsData.positions.map(item => item.id)).size !== positionsData.positions.length) throw new Error();
        // Rebuild each DTO so private balance data can never enter diagnostic results.
        done({ result: { ...target, status: data.status, contentType: data.contentType,
          challenge: data.challenge, elapsedMs: data.elapsedMs, structureOk: data.structureOk, outcome: data.outcome }, balance,
          ...(positionsData ? { positions: positionsData.positions } : {}) });
      } catch { done(fallback('client_error')); }
    });
    if (signal?.aborted) cancel();
    else child.stdin?.end(JSON.stringify({ vrToken: c.vrToken, operation }));
  });
}

export async function readVariationalPythonBalance(c: VariationalCredential, signal?: AbortSignal, launch: typeof spawn = spawn): Promise<number | string> {
  const { result, balance } = await runVariationalPython(c, 'sync-portfolio', signal, launch);
  if (result.outcome !== 'ok') throw new Error(VARIATIONAL_ERRORS[result.outcome]);
  if (balance === null) throw new Error(VARIATIONAL_ERRORS.invalid_data);
  return balance;
}

export async function readVariationalPythonPositions(c: VariationalCredential, signal?: AbortSignal, launch: typeof spawn = spawn): Promise<Position[]> {
  const { result, positions } = await runVariationalPython(c, 'sync-positions', signal, launch);
  if (result.outcome !== 'ok') throw new Error(VARIATIONAL_ERRORS[result.outcome]);
  if (!positions) throw new Error(VARIATIONAL_ERRORS.invalid_data);
  return positions;
}
