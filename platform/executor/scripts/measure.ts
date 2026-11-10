// Mixed-load measurement for plan 6.4: executor jobs on the main thread while
// worker threads backfill, checkpoint, back up and query the same database.
// Results describe this machine only; they are not a target-server baseline.
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir, cpus, totalmem, platform, release } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { Worker } from 'node:worker_threads';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { openStore } from '../src/store.ts';
import { createExecutor } from '../src/executor.ts';
import { SIM_BINDINGS, createSimulatedVenues } from '../src/simulation.ts';

const JOB_WAIT_LIMIT_MS = 30_000;
const BUDGETS = {
  executorWriteWaitP99Ms: 100, executorWriteWaitMaxMs: 1000, executorHoldP99Ms: 50, executorHoldMaxMs: 250,
  confirmP99Ms: 200, eventLoopP99Ms: 50, rssPeakMiB: 256, walPeakMiB: 64,
} as const;

const BACKFILL = `
const { DatabaseSync } = require('node:sqlite');
const { parentPort, workerData } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const db = new DatabaseSync(workerData.file);
db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
const insert = db.prepare('INSERT INTO load_backfill(at, payload) VALUES (?, ?)');
const payload = 'x'.repeat(workerData.rowBytes);
const waits = [], holds = [], checkpoints = [];
let stop = false, backupMs = null, batches = 0, lastCheckpoint = performance.now();
parentPort.on('message', message => { if (message === 'stop') stop = true; if (message === 'backup') pendingBackup = true; });
let pendingBackup = false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  while (workerData.disabled && !stop) await sleep(20);
  while (!stop) {
    const requested = performance.now();
    db.exec('BEGIN IMMEDIATE');
    const acquired = performance.now();
    for (let i = 0; i < workerData.batchRows; i++) insert.run(Date.now(), payload);
    db.exec('COMMIT');
    waits.push(acquired - requested); holds.push(performance.now() - acquired); batches++;
    if (performance.now() - lastCheckpoint > 2000) { const t = performance.now(); db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get(); checkpoints.push(performance.now() - t); lastCheckpoint = performance.now(); }
    if (pendingBackup) { pendingBackup = false; const t = performance.now(); db.exec("VACUUM INTO '" + workerData.backup.replace(/'/g, "''") + "'"); backupMs = performance.now() - t; }
    await sleep(workerData.intervalMs);
  }
  db.close();
  parentPort.postMessage({ waits, holds, checkpoints, backupMs, batches });
})();
`;
const READER = `
const { DatabaseSync } = require('node:sqlite');
const { parentPort, workerData } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const db = new DatabaseSync(workerData.file, { readOnly: true });
db.exec('PRAGMA busy_timeout=5000;');
const recent = db.prepare('SELECT json FROM jobs ORDER BY created_at DESC LIMIT 50');
const events = db.prepare('SELECT COUNT(*) AS n, MAX(seq) AS seq FROM events');
const scan = db.prepare("SELECT COUNT(*) AS n FROM load_backfill WHERE payload LIKE '%y%'");
const quick = [], long = [];
let stop = false, round = 0;
parentPort.on('message', message => { if (message === 'stop') stop = true; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  while (!stop) {
    let t = performance.now(); recent.all(); events.get(); quick.push(performance.now() - t);
    if (++round % 40 === 0) { t = performance.now(); scan.get(); long.push(performance.now() - t); }
    await sleep(5);
  }
  db.close();
  parentPort.postMessage({ quick, long });
})();
`;

const percentile = (values: number[], p: number): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)];
};
const summary = (values: number[]) => ({ count: values.length, p50: round(percentile(values, 50)), p99: round(percentile(values, 99)), max: round(values.length ? Math.max(...values) : 0) });
const round = (value: number) => Math.round(value * 100) / 100;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const sizeOf = (file: string) => existsSync(file) ? statSync(file).size : 0;

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    jobs: { type: 'string', default: '200' }, 'batch-rows': { type: 'string', default: '500' }, 'row-bytes': { type: 'string', default: '256' },
    'interval-ms': { type: 'string', default: '20' }, readers: { type: 'string', default: '2' }, keep: { type: 'boolean', default: false }, 'no-backfill': { type: 'boolean', default: false },
  } });
  const jobs = Number(values.jobs), readers = Number(values.readers);
  const dir = mkdtempSync(join(tmpdir(), 'pa-executor-load-'));
  const file = join(dir, 'executor.sqlite');
  const store = openStore(file);
  store.db.exec('CREATE TABLE IF NOT EXISTS load_backfill (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, payload TEXT NOT NULL)');
  const { binance, bybit } = createSimulatedVenues(Date.now);
  const executor = createExecutor({ store, connectors: [binance, bybit] });
  if (!executor.acquire()) throw new Error('未取得写入租约');
  for (const binding of SIM_BINDINGS) executor.registerAccount(binding);
  const baseline = store.stats();

  // Timer-based delay includes the platform timer granularity (about 15.6 ms on Windows),
  // so the budget uses setImmediate latency, which only grows when the loop is blocked.
  const idle = monitorEventLoopDelay({ resolution: 10 }); idle.enable();
  await sleep(1_000);
  idle.disable();
  const blocked: number[] = [];
  let sampling = true;
  const sampleBlocking = () => { if (!sampling) return; const t = performance.now(); setImmediate(() => { blocked.push(performance.now() - t); setTimeout(sampleBlocking, 5); }); };
  sampleBlocking();
  const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
  let rssPeak = process.memoryUsage().rss, walPeak = 0, dbPeak = 0;
  const sampler = setInterval(() => { rssPeak = Math.max(rssPeak, process.memoryUsage().rss); walPeak = Math.max(walPeak, sizeOf(`${file}-wal`)); dbPeak = Math.max(dbPeak, sizeOf(file)); }, 100);
  const heartbeat = setInterval(() => executor.acquire(), 10_000);

  const backfill = new Worker(BACKFILL, { eval: true, workerData: { file, backup: join(dir, 'backup.sqlite'), batchRows: Number(values['batch-rows']), rowBytes: Number(values['row-bytes']), intervalMs: Number(values['interval-ms']), disabled: values['no-backfill'] } });
  const readerWorkers = Array.from({ length: readers }, () => new Worker(READER, { eval: true, workerData: { file } }));
  const result = (worker: Worker) => new Promise<any>((resolve, fail) => { worker.once('message', resolve); worker.once('error', fail); });
  const backfillDone = result(backfill), readersDone = readerWorkers.map(result);

  let running = true;
  const ticker = (async () => { while (running) { await executor.tick(); await sleep(2); } })();
  const previewMs: number[] = [], confirmMs: number[] = [], jobMs: number[] = [], statuses: Record<string, number> = {};
  const started = performance.now();
  const session = 'measure-session-01';
  async function drive(symbol: 'CLUSDT' | 'BZUSDT', count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      const action = i % 2 === 0 ? 'open' : 'close';
      const intent = { market: 'oil', preset: 'cross-exchange', symbol, action, timeoutMs: 60_000,
        legs: [{ venue: 'binance', side: 'long', quantity: '1', orderType: 'market' }, { venue: 'bybit', side: 'short', quantity: '1', orderType: 'market' }] };
      let t = performance.now();
      const preview = await executor.preview(intent, session);
      previewMs.push(performance.now() - t);
      t = performance.now();
      const accepted = executor.confirm({ previewId: preview.id, requestId: randomUUID(), confirmLive: true }, session);
      confirmMs.push(performance.now() - t);
      // Bounded so a stuck job ends the run with a distinct failure instead of hanging it.
      for (const waitStarted = performance.now(); ;) {
        const view = executor.jobView(accepted.job.id);
        if (['completed', 'failed', 'stopped', 'attention'].includes(view.status)) { statuses[view.status] = (statuses[view.status] ?? 0) + 1; break; }
        if (performance.now() - waitStarted > JOB_WAIT_LIMIT_MS) { statuses['unfinished'] = (statuses['unfinished'] ?? 0) + 1; break; }
        await sleep(2);
      }
      jobMs.push(performance.now() - t);
      if (i === Math.floor(count / 2) && symbol === 'CLUSDT') backfill.postMessage('backup');
    }
  }
  await Promise.all([drive('CLUSDT', Math.ceil(jobs / 2)), drive('BZUSDT', Math.floor(jobs / 2))]);
  const elapsedMs = performance.now() - started;
  running = false; await ticker;
  backfill.postMessage('stop'); for (const worker of readerWorkers) worker.postMessage('stop');
  const [fill, ...reads] = await Promise.all([backfillDone, ...readersDone]);
  await Promise.all([backfill, ...readerWorkers].map(worker => worker.terminate()));
  clearInterval(sampler); clearInterval(heartbeat); loop.disable(); sampling = false;
  const stats = store.stats();
  const waits = stats.waits.slice(baseline.waits.length), holds = stats.holds.slice(baseline.holds.length);
  executor.close(); store.close();

  const measured = {
    executorWriteWait: summary(waits), executorHold: summary(holds), busy: stats.busy,
    preview: summary(previewMs), confirm: summary(confirmMs), jobEndToEnd: summary(jobMs), jobStatuses: statuses,
    backfillWait: summary(fill.waits), backfillHold: summary(fill.holds), backfillBatches: fill.batches, checkpoint: summary(fill.checkpoints), backupMs: fill.backupMs === null ? null : round(fill.backupMs),
    readerQuick: summary(reads.flatMap(r => r.quick)), readerLongScan: summary(reads.flatMap(r => r.long)),
    eventLoopBlocking: summary(blocked),
    timerDelay: { p50: round(loop.percentile(50) / 1e6), p99: round(loop.percentile(99) / 1e6), max: round(loop.max / 1e6) },
    timerDelayIdle: { p50: round(idle.percentile(50) / 1e6), p99: round(idle.percentile(99) / 1e6), max: round(idle.max / 1e6) },
    rssPeakMiB: round(rssPeak / 2 ** 20), walPeakMiB: round(walPeak / 2 ** 20), dbPeakMiB: round(dbPeak / 2 ** 20), elapsedMs: round(elapsedMs),
  };
  const checks = {
    executorWriteWaitP99Ms: measured.executorWriteWait.p99 <= BUDGETS.executorWriteWaitP99Ms,
    executorWriteWaitMaxMs: measured.executorWriteWait.max <= BUDGETS.executorWriteWaitMaxMs,
    executorHoldP99Ms: measured.executorHold.p99 <= BUDGETS.executorHoldP99Ms,
    executorHoldMaxMs: measured.executorHold.max <= BUDGETS.executorHoldMaxMs,
    confirmP99Ms: measured.confirm.p99 <= BUDGETS.confirmP99Ms,
    eventLoopP99Ms: measured.eventLoopBlocking.p99 <= BUDGETS.eventLoopP99Ms,
    rssPeakMiB: measured.rssPeakMiB <= BUDGETS.rssPeakMiB,
    walPeakMiB: measured.walPeakMiB <= BUDGETS.walPeakMiB,
  };
  const report = {
    note: '本机测量，仅作原型证据；不是目标服务器基线，建议预算未经用户确认',
    environment: { platform: platform(), release: release(), cpu: cpus()[0]?.model ?? 'unknown', cpus: cpus().length, memoryGiB: round(totalmem() / 2 ** 30), node: process.version },
    load: { jobs, readers, batchRows: Number(values['batch-rows']), rowBytes: Number(values['row-bytes']), intervalMs: Number(values['interval-ms']), backfill: !values['no-backfill'], venues: 'simulated in-process' },
    budgets: BUDGETS, measured, withinSuggestedBudget: checks,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!values.keep) rmSync(dir, { recursive: true, force: true });
  // 3: the simulated workload itself did not complete (a functional failure); 2: only a budget was missed.
  if ((statuses.completed ?? 0) !== jobs) process.exitCode = 3;
  else if (Object.values(checks).includes(false)) process.exitCode = 2;
}

main().catch(error => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
