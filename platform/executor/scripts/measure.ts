// Mixed-load measurement for plan 6.4: executor jobs on the main thread while
// worker threads backfill, checkpoint, back up and query the same database.
// Since 2.4b the same run also drives ASTER margin transfers and ADL incidents on
// several simulated pairs, with the jobs, transfer and ADL passes scheduled apart
// as the entry does; `--aster-latency-ms` delays every simulated ASTER call to
// show that a slow ASTER holds up only its own loops.
// Since 2.5 the readers' history scan runs in id slices (`--scan-chunk-rows`), each its own
// short read (so `readerLongScan` now includes yields between slices), as the frozen storage rules require of every reader of this database; 0 scans
// the whole table under one snapshot, as the runs before 2.5 did. The main thread also runs the
// store's WAL maintenance once a second, as the entry does; `--no-wal-reset` turns it off.
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
/** One ADL incident or one transfer must end within this, or the run counts it unfinished. */
const ASSET_WAIT_LIMIT_MS = 60_000;
const ADL_SYMBOL = 'BTCUSDT';
/** How often the ADL and transfer drivers look at the executor; tighter polling shows up in the event-loop numbers it measures. */
const ASSET_POLL_MS = 50;
/** The simulated ASTER calls `--aster-latency-ms` delays. */
const ASTER_TRANSFER_CALLS = ['subAccounts', 'balance', 'history', 'transfer'] as const;
const ASTER_TRADING_CALLS = ['account', 'positions', 'rule', 'place', 'query', 'cancel', 'adlHistory'] as const;
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
let stop = false, backupMs = null, batches = 0, lastCheckpoint = performance.now(), checkpointsIncomplete = 0, backlogFrames = 0;
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
    if (performance.now() - lastCheckpoint > 2000) {
      const t = performance.now();
      // A passive checkpoint stops at the oldest snapshot a reader still holds: frames past it stay in the WAL.
      const state = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
      checkpoints.push(performance.now() - t); lastCheckpoint = performance.now();
      if (state.checkpointed < state.log) { checkpointsIncomplete++; backlogFrames = Math.max(backlogFrames, state.log - state.checkpointed); }
    }
    if (pendingBackup) { pendingBackup = false; const t = performance.now(); db.exec("VACUUM INTO '" + workerData.backup.replace(/'/g, "''") + "'"); backupMs = performance.now() - t; }
    await sleep(workerData.intervalMs);
  }
  const backlogBytes = backlogFrames * db.prepare('PRAGMA page_size').get().page_size;
  db.close();
  parentPort.postMessage({ waits, holds, checkpoints, backupMs, batches, checkpointsIncomplete, backlogBytes });
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
const lastId = db.prepare('SELECT IFNULL(MAX(id), 0) AS id FROM load_backfill');
const scanSlice = db.prepare("SELECT COUNT(*) AS n FROM load_backfill WHERE id > ? AND id <= ? AND payload LIKE '%y%'");
const quick = [], long = [];
// Each statement is its own read transaction, so its duration is how long one snapshot keeps the WAL from being reset.
let stop = false, round = 0, snapshotMaxMs = 0;
const timed = read => { const t = performance.now(); read(); const ms = performance.now() - t; snapshotMaxMs = Math.max(snapshotMaxMs, ms); return ms; };
parentPort.on('message', message => { if (message === 'stop') stop = true; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  while (!stop) {
    quick.push(timed(() => recent.all()) + timed(() => events.get()));
    if (++round % 40 === 0) {
      const t = performance.now();
      if (workerData.scanChunkRows > 0) {
        const end = lastId.get().id;
        for (let from = 0; from < end && !stop; from += workerData.scanChunkRows) { timed(() => scanSlice.get(from, from + workerData.scanChunkRows)); await new Promise(setImmediate); }
      } else timed(() => scan.get());
      long.push(performance.now() - t);
    }
    await sleep(5);
  }
  db.close();
  parentPort.postMessage({ quick, long, snapshotMaxMs });
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

/** Delays the named async methods by `ms` before they run; everything else passes through. */
function delayed<T extends object>(target: T, ms: number, methods: readonly string[]): T {
  if (ms <= 0) return target;
  return new Proxy(target, {
    get(object, key, receiver) {
      const value = Reflect.get(object, key, receiver);
      if (typeof key !== 'string' || !methods.includes(key) || typeof value !== 'function') return value;
      return async (...args: unknown[]) => { await sleep(ms); return (value as (...input: unknown[]) => unknown).apply(object, args); };
    },
  });
}
/** 40 lowercase hex digits after 0x: a role digit, then the pair number. */
const address = (role: string, index: number) => `0x${role}${index.toString(16).padStart(39, '0')}`;
/** Runs one loop's passes until stopped, keeping each pass's duration. */
function passLoop(pass: () => Promise<void>, spacingMs: number, durations: number[], running: () => boolean): Promise<void> {
  return (async () => {
    while (running()) {
      const t = performance.now();
      await pass();
      durations.push(performance.now() - t);
      await sleep(spacingMs);
    }
  })();
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    jobs: { type: 'string', default: '200' }, 'batch-rows': { type: 'string', default: '500' }, 'row-bytes': { type: 'string', default: '256' },
    'interval-ms': { type: 'string', default: '20' }, readers: { type: 'string', default: '2' }, keep: { type: 'boolean', default: false }, 'no-backfill': { type: 'boolean', default: false },
    pairs: { type: 'string', default: '4' }, 'adl-events': { type: 'string', default: '10' }, transfers: { type: 'string', default: '10' },
    'aster-latency-ms': { type: 'string', default: '0' }, 'loop-spacing-ms': { type: 'string', default: '1000' }, 'scan-chunk-rows': { type: 'string', default: '20000' }, 'no-wal-reset': { type: 'boolean', default: false },
  } });
  const jobs = Number(values.jobs), readers = Number(values.readers);
  const pairs = Number(values.pairs), adlEvents = Number(values['adl-events']), transferCycles = Number(values.transfers);
  const asterLatencyMs = Number(values['aster-latency-ms']), loopSpacingMs = Number(values['loop-spacing-ms']), scanChunkRows = Number(values['scan-chunk-rows']);
  for (const [name, value] of Object.entries({ jobs, readers, pairs, 'adl-events': adlEvents, transfers: transferCycles, 'aster-latency-ms': asterLatencyMs, 'loop-spacing-ms': loopSpacingMs, 'scan-chunk-rows': scanChunkRows })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`--${name} 须为非负整数`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'pa-executor-load-'));
  const file = join(dir, 'executor.sqlite');
  const store = openStore(file);
  store.db.exec('CREATE TABLE IF NOT EXISTS load_backfill (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, payload TEXT NOT NULL)');
  const { binance, bybit, aster, asterTrading } = createSimulatedVenues(Date.now);
  // Settle cooldown shortened from 30 s so one run sees several transfers per pair; every other budget is the default.
  const executor = createExecutor({ store, connectors: [binance, bybit], budgets: { transferSettleCooldownMs: 1_000 },
    transfers: delayed(aster, asterLatencyMs, ASTER_TRANSFER_CALLS), adl: delayed(asterTrading, asterLatencyMs, ASTER_TRADING_CALLS), positions: delayed(asterTrading, asterLatencyMs, ASTER_TRADING_CALLS) });
  if (!executor.acquire()) throw new Error('未取得写入租约');
  for (const binding of SIM_BINDINGS) executor.registerAccount(binding);
  const session = 'measure-session-01';
  // Each pair: its own main account, 500 USD1 on both sides (balanced), 1 BTC long against 1 BTC short.
  const assetPairs = Array.from({ length: pairs }, (_, index) => ({ id: `load-${index + 1}`, mainAccountId: address('1', index), long: address('2', index), short: address('3', index) }));
  for (const pair of assetPairs) {
    aster.openSubAccount(pair.mainAccountId, pair.long, { available: '500' });
    aster.openSubAccount(pair.mainAccountId, pair.short, { available: '500' });
    asterTrading.openAccount(pair.long); asterTrading.openAccount(pair.short);
    asterTrading.setPosition(pair.long, ADL_SYMBOL, 'LONG', '1');
    asterTrading.setPosition(pair.short, ADL_SYMBOL, 'SHORT', '-1');
    executor.registerTransferPair({ ...pair, config: { cooldownMs: 1_000, checkIntervalMs: 1_000 } });
    await executor.setTransferEnabled({ pairId: pair.id, enabled: true, requestId: randomUUID() }, session);
  }
  // The first ADL pass sets the scan start, as the entry's first pass does.
  await executor.tickAdl();
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
  // The entry's WAL maintenance, on the same schedule; `--no-wal-reset` leaves the WAL to automatic checkpoints as before 2.5.
  const walReset = { resets: 0, busy: 0, seenBytes: 0, ms: [] as number[] };
  const walCheck = values['no-wal-reset'] ? null : setInterval(() => {
    walReset.seenBytes = Math.max(walReset.seenBytes, store.walBytes());
    const result = store.maintainWal();
    if (result.action === 'reset') { walReset.resets++; walReset.ms.push(result.ms); }
    else if (result.action === 'busy') { walReset.busy++; walReset.ms.push(result.ms); }
  }, 1_000);

  const backfill = new Worker(BACKFILL, { eval: true, workerData: { file, backup: join(dir, 'backup.sqlite'), batchRows: Number(values['batch-rows']), rowBytes: Number(values['row-bytes']), intervalMs: Number(values['interval-ms']), disabled: values['no-backfill'] } });
  const readerWorkers = Array.from({ length: readers }, () => new Worker(READER, { eval: true, workerData: { file, scanChunkRows } }));
  const result = (worker: Worker) => new Promise<any>((resolve, fail) => { worker.once('message', resolve); worker.once('error', fail); });
  const backfillDone = result(backfill), readersDone = readerWorkers.map(result);

  let running = true;
  const passMs = { jobs: [] as number[], transfers: [] as number[], adl: [] as number[] };
  // Jobs keep the 2 ms spacing of the phase 1 measurement; transfers and ADL use the entry's spacing.
  const loops = [
    passLoop(executor.tickJobs, 2, passMs.jobs, () => running),
    passLoop(executor.tickTransfers, loopSpacingMs, passMs.transfers, () => running),
    passLoop(executor.tickAdl, loopSpacingMs, passMs.adl, () => running),
  ];
  const previewMs: number[] = [], confirmMs: number[] = [], jobMs: number[] = [], statuses: Record<string, number> = {};
  const started = performance.now();
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
  const adl = { detectMs: [] as number[], firstSendMs: [] as number[], closeMs: [] as number[], statuses: {} as Record<string, number>, unfinished: [] as unknown[] };
  /** One ADL on the long side at a time per pair; the executor must buy back the same amount on the short side. */
  async function driveAdl(pair: typeof assetPairs[number]): Promise<void> {
    for (let i = 0; i < adlEvents; i++) {
      const at = Date.now();
      asterTrading.adl(pair.long, ADL_SYMBOL, 'LONG', '0.005');
      let id: string | null = null, status = 'unfinished';
      for (const waitStarted = performance.now(); performance.now() - waitStarted <= ASSET_WAIT_LIMIT_MS; await sleep(ASSET_POLL_MS)) {
        // Only an incident opened after this event counts. The recent list also holds one that opened and closed between two looks.
        id ??= executor.recentAdlIncidents(10).find(item => item.pairId === pair.id && item.createdAt >= at)?.id ?? null;
        if (!id) continue;
        const view = executor.adlIncident(id);
        if (view.closedAt === null) continue;
        status = view.status;
        adl.detectMs.push(view.createdAt - at);
        const sent = view.batches.map(batch => batch.sentAt).filter((value): value is number => value !== null);
        if (sent.length) adl.firstSendMs.push(Math.min(...sent) - at);
        adl.closeMs.push(view.closedAt - at);
        break;
      }
      adl.statuses[status] = (adl.statuses[status] ?? 0) + 1;
      if (status === 'unfinished') {
        const view = id ? executor.adlIncident(id) : null;
        adl.unfinished.push({ pair: pair.id, event: i + 1, incident: view && { status: view.status, reason: view.reason, batches: view.batches.map(batch => batch.state) } });
        return;
      }
    }
  }
  const transfer = { sendMs: [] as number[], settleMs: [] as number[], statuses: {} as Record<string, number> };
  /** Moves 200 USD1 of imbalance onto alternating sides once the pair may transfer again; the executor must move it back. */
  async function driveTransfers(pair: typeof assetPairs[number]): Promise<void> {
    for (let i = 0; i < transferCycles; i++) {
      for (const waitStarted = performance.now(); ; await sleep(ASSET_POLL_MS)) {
        const view = executor.transferPairs().find(item => item.id === pair.id);
        // Not waiting for nextCheckAt: each check moves it on by the loop spacing, so its due moment is easy to miss.
        // The send time therefore includes waiting for the next check, as an imbalance on a live account would.
        if (view && !view.current && Date.now() >= view.cooldownUntil) break;
        if (performance.now() - waitStarted > ASSET_WAIT_LIMIT_MS) { transfer.statuses.unfinished = (transfer.statuses.unfinished ?? 0) + 1; return; }
      }
      const [rich, poor] = i % 2 === 0 ? [pair.long, pair.short] : [pair.short, pair.long];
      const before = new Set(executor.recentTransfers(100).filter(item => item.pairId === pair.id).map(item => item.id));
      const at = Date.now();
      aster.setBalance(rich, { available: '700', equity: '700' }); aster.setBalance(poor, { available: '300', equity: '300' });
      let status = 'unfinished';
      for (const waitStarted = performance.now(); performance.now() - waitStarted <= ASSET_WAIT_LIMIT_MS; await sleep(ASSET_POLL_MS)) {
        const view = executor.recentTransfers(100).find(item => item.pairId === pair.id && !before.has(item.id));
        if (!view || view.settledAt === null) continue;
        status = view.state;
        if (view.sentAt !== null) transfer.sendMs.push(view.sentAt - at);
        transfer.settleMs.push(view.settledAt - at);
        break;
      }
      transfer.statuses[status] = (transfer.statuses[status] ?? 0) + 1;
      if (status === 'unfinished') return;
    }
  }
  try { await Promise.all([drive('CLUSDT', Math.ceil(jobs / 2)), drive('BZUSDT', Math.floor(jobs / 2)), ...assetPairs.flatMap(pair => [driveAdl(pair), driveTransfers(pair)])]); }
  catch (error) {
    // The other drivers would go on waiting out their limits, and workers and timers keep the process alive: clean up and exit now.
    running = false; sampling = false; clearInterval(sampler); clearInterval(heartbeat); if (walCheck) clearInterval(walCheck);
    await Promise.all([backfill, ...readerWorkers].map(worker => worker.terminate()));
    executor.close(); store.close();
    if (!values.keep) rmSync(dir, { recursive: true, force: true });
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  }
  const elapsedMs = performance.now() - started;
  running = false; await Promise.all(loops);
  backfill.postMessage('stop'); for (const worker of readerWorkers) worker.postMessage('stop');
  const [fill, ...reads] = await Promise.all([backfillDone, ...readersDone]);
  await Promise.all([backfill, ...readerWorkers].map(worker => worker.terminate()));
  clearInterval(sampler); clearInterval(heartbeat); if (walCheck) clearInterval(walCheck); loop.disable(); sampling = false;
  const stats = store.stats();
  const waits = stats.waits.slice(baseline.waits.length), holds = stats.holds.slice(baseline.holds.length);
  executor.close(); store.close();

  const measured = {
    executorWriteWait: summary(waits), executorHold: summary(holds), busy: stats.busy,
    preview: summary(previewMs), confirm: summary(confirmMs), jobEndToEnd: summary(jobMs), jobStatuses: statuses,
    passJobs: summary(passMs.jobs), passTransfers: summary(passMs.transfers), passAdl: summary(passMs.adl),
    adlDetect: summary(adl.detectMs), adlFirstSend: summary(adl.firstSendMs), adlClose: summary(adl.closeMs), adlStatuses: adl.statuses, adlUnfinished: adl.unfinished,
    transferSend: summary(transfer.sendMs), transferSettle: summary(transfer.settleMs), transferStatuses: transfer.statuses,
    backfillWait: summary(fill.waits), backfillHold: summary(fill.holds), backfillBatches: fill.batches, checkpoint: summary(fill.checkpoints), checkpointsIncomplete: fill.checkpointsIncomplete, checkpointBacklogMiB: round(fill.backlogBytes / 2 ** 20),
    walReset: { resets: walReset.resets, busy: walReset.busy, seenMiB: round(walReset.seenBytes / 2 ** 20), ...summary(walReset.ms) }, backupMs: fill.backupMs === null ? null : round(fill.backupMs),
    readerQuick: summary(reads.flatMap(r => r.quick)), readerLongScan: summary(reads.flatMap(r => r.long)), readerSnapshotMaxMs: round(Math.max(0, ...reads.map(r => r.snapshotMaxMs))),
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
    load: { jobs, readers, batchRows: Number(values['batch-rows']), rowBytes: Number(values['row-bytes']), intervalMs: Number(values['interval-ms']), backfill: !values['no-backfill'], venues: 'simulated in-process',
      pairs, adlEvents, transferCycles, asterLatencyMs, loopSpacingMs, scanChunkRows, walReset: !values['no-wal-reset'] },
    budgets: BUDGETS, measured, withinSuggestedBudget: checks,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!values.keep) rmSync(dir, { recursive: true, force: true });
  // 3: the simulated workload itself did not complete (a functional failure); 2: only a budget was missed.
  if ((statuses.completed ?? 0) !== jobs || (adl.statuses.completed ?? 0) !== pairs * adlEvents || (transfer.statuses.confirmed ?? 0) !== pairs * transferCycles) process.exitCode = 3;
  else if (Object.values(checks).includes(false)) process.exitCode = 2;
}

main().catch(error => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
