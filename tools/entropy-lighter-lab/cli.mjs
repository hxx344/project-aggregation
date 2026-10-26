#!/usr/bin/env node
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Lab, Recorder, atomicJson, readPreviousReport, validateConfig } from './core.mjs';
import { discover, startFeeds } from './feeds.mjs';

function argumentsFor(argv) {
  const [command = 'help', ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--config', '--data', '--duration'].includes(rest[i]) || rest[i + 1] === undefined || Object.hasOwn(options, rest[i])) throw new Error('Usage: cli.mjs {check|run|report} [--config FILE] [--data DIR] [--duration SECONDS]');
    options[rest[i]] = rest[i + 1];
  }
  const duration = options['--duration'] === undefined ? null : Number(options['--duration']);
  if (duration !== null && (!Number.isFinite(duration) || duration < 1 || duration > 86400)) throw new Error('duration must be 1..86400 seconds');
  return { command, configPath: resolve(options['--config'] || join(dirname(fileURLToPath(import.meta.url)), 'config.example.json')), data: resolve(options['--data'] || '.data-entropy-lighter'), duration };
}

export async function run({ configPath, data, duration }) {
  const source = readFileSync(configPath, 'utf8');
  const config = validateConfig(JSON.parse(source));
  mkdirSync(data, { recursive: true, mode: 0o700 });
  // An exclusive mkdir, with PID ownership verification on recovery, prevents two
  // collectors from writing one data directory or consuming the same paper book.
  const lock = join(data, 'run.lock');
  const claimGuard = join(data, 'run.claim');
  const lockToken = randomUUID();
  const claim = () => { mkdirSync(lock, { mode: 0o700 }); writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token: lockToken }), { mode: 0o600 }); };
  try { mkdirSync(claimGuard, { mode: 0o700 }); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    throw new Error('Another start is claiming the collector lock; if abandoned, stop the service and inspect run.claim');
  }
  try {
    try { claim(); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'));
      if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error('Invalid collector lock; inspect run.lock');
      try { process.kill(owner.pid, 0); throw new Error('Another collector is active in this data directory'); }
      catch (e) { if (e.code !== 'ESRCH') throw e; }
      const stale = `${lock}.stale-${randomUUID()}`;
      renameSync(lock, stale);
      try { claim(); } finally { rmSync(stale, { recursive: true }); }
    }
  } finally {
    rmSync(claimGuard, { recursive: true });
  }
  let cleanupReady = false;
  try {
    const session = randomUUID(), startedAt = new Date().toISOString();
    const abort = new AbortController();
    const previous = readPreviousReport(data);
    const previousUnresolved = previous?.openPaperTasks?.length || Object.values(previous?.paper || {}).some((r) => r.unresolved > 0) || previous?.paperSuspendedReason || (previous?.mode === 'paper' && !previous.stopped);
    const paperSuspendedReason = previousUnresolved ? 'previous_session_has_unresolved_paper_exposure_review_previous_report' : null;
    if (paperSuspendedReason && previous && !existsSync(join(data, 'unresolved-paper.json'))) atomicJson(join(data, 'unresolved-paper.json'), previous);
    const effective = structuredClone(config);
    if (paperSuspendedReason) effective.simulation.enabled = false;
    const recorder = new Recorder(data, config, session);
    let fatal = null, feeds = null, metadata = null, refreshing = false, refreshPromise = null;
    const diagnostics = { counts: {}, last: {}, rttMs: {} };
    const cooldownFile = join(data, 'cooldowns.json');
    const cooldowns = existsSync(cooldownFile) ? JSON.parse(readFileSync(cooldownFile, 'utf8')) : {};
    for (const [key, value] of Object.entries(cooldowns)) if (!['entropy', 'lighter', 'binance'].includes(key) || !Number.isFinite(value) || value < 0) throw new Error('Invalid persisted API cooldown');
    const fail = (error) => { if (!fatal) { fatal = error; abort.abort(); } };
    const safe = (fn) => (...args) => { if (fatal) return; try { fn(...args); } catch (e) { fail(e); } };
    const lab = new Lab(effective, safe((event) => recorder.write(event)));
    const loop = monitorEventLoopDelay({ resolution: 20 }); loop.enable();
    const diagnostic = safe((d) => {
      const key = `${d.venue || 'collector'}:${d.event}`;
      diagnostics.counts[key] = (diagnostics.counts[key] || 0) + 1;
      diagnostics.last[key] = d;
      if (Number.isFinite(d.details?.rttMs)) {
        const samples = diagnostics.rttMs[key] || []; samples.push(d.details.rttMs);
        if (samples.length > 1000) samples.shift(); diagnostics.rttMs[key] = samples;
      }
      if (d.event === 'invalidated') lab.invalidate(d.venue, d.symbol, d.reason || d.details?.reason || d.message);
      if (d.event === 'cooldown') atomicJson(cooldownFile, cooldowns);
      recorder.write({ type: 'diagnostic', ...d });
    });
    const snapshot = () => ({ schema: 1, pid: process.pid, session, mode: effective.simulation.enabled ? 'paper' : 'research', startedAt, heartbeatAt: new Date().toISOString(), region: config.region, configHash: createHash('sha256').update(source).digest('hex'), sessionConfig: structuredClone(effective), paperSuspendedReason, ...lab.report(), metadata, diagnostics, eventLoopDelayMs: { p50: loop.percentile(50) / 1e6, p95: loop.percentile(95) / 1e6, p99: loop.percentile(99) / 1e6 }, stopped: abort.signal.aborted });
    const persist = () => {
      const report = snapshot();
      atomicJson(join(data, 'report.json'), report);
      atomicJson(cooldownFile, cooldowns);
      atomicJson(join(data, 'status.json'), { pid: report.pid, session, mode: report.mode, startedAt, heartbeatAt: report.heartbeatAt, stopped: report.stopped, paperSuspendedReason, books: report.counts.books });
      return report;
    };
    persist();
    recorder.write({ type: 'session_start', at: Date.now(), config, paperSuspendedReason, session });
    const refresh = async () => {
      if (refreshing || abort.signal.aborted) return;
      refreshing = true;
      try {
        if (feeds) { await feeds.stop(); feeds = null; }
        for (const venue of ['entropy', 'lighter', 'binance']) lab.invalidate(venue, undefined, 'metadata_refresh');
        metadata = await discover({ signal: abort.signal, onDiagnostic: diagnostic, cooldowns });
        if (abort.signal.aborted) return;
        lab.setMarkets(metadata.markets);
        recorder.write({ type: 'metadata', ...metadata });
        feeds = startFeeds({ markets: metadata.markets, signal: abort.signal, cooldowns, onDiagnostic: diagnostic, onBook: safe((b) => lab.book(b)), onRaw: config.recordRaw ? safe((r) => recorder.write({ type: 'raw', ...r })) : undefined });
        feeds.done.catch(fail);
        persist();
      } catch (e) {
        if (!abort.signal.aborted) diagnostic({ level: 'error', event: 'discovery_failed', message: 'Metadata unavailable; retry in 60 seconds', at: Date.now() });
      } finally { refreshing = false; }
    };
    const stop = () => abort.abort();
    const managedMessage = (message) => { if (message?.type === 'entropy-lighter-stop') stop(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    process.once('disconnect', stop);
    process.on('message', managedMessage);
    if (process.env.ENTROPY_LAB_MANAGED === '1' && !process.connected) stop();
    const ticker = setInterval(safe(() => { lab.advance(performance.now(), Date.now()); }), 50);
    const writer = setInterval(safe(persist), 5000);
    const launchRefresh = () => { refreshPromise = refresh(); refreshPromise.catch(fail); };
    const refresher = setInterval(() => {
      const missingTradingFeed = !metadata || ['entropy', 'lighter'].some((v) => !metadata.markets.some((m) => m.venue === v && m.status === 'active'));
      if (missingTradingFeed || Date.now() - metadata.discoveredAt >= 900000) launchRefresh();
    }, 60000);
    const deadline = duration === null ? null : setTimeout(stop, duration * 1000);
    cleanupReady = true;
    try {
      launchRefresh();
      if (!abort.signal.aborted) await new Promise((done) => abort.signal.addEventListener('abort', done, { once: true }));
    } finally {
      clearInterval(ticker); clearInterval(writer); clearInterval(refresher); if (deadline) clearTimeout(deadline);
      process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
      process.removeListener('disconnect', stop);
      process.removeListener('message', managedMessage);
      if (refreshPromise) await refreshPromise;
      if (feeds) await feeds.stop();
      loop.disable();
      if (!fatal) {
        const report = persist(); recorder.write({ type: 'session_end', at: Date.now(), report });
        process.stdout.write(`${JSON.stringify({ session, data, books: report.counts.books, mode: report.mode, openPaperTasks: report.openPaperTasks.length, stopped: true })}\n`);
      }
    }
    if (fatal) throw fatal;
  } finally {
    // The directory is exclusively owned by this invocation after claim().
    if (JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).token === lockToken) rmSync(lock, { recursive: true });
  }
  return cleanupReady;
}

async function main() {
  const args = argumentsFor(process.argv.slice(2));
  if (args.command === 'check') {
    validateConfig(JSON.parse(readFileSync(args.configPath, 'utf8')));
    process.stdout.write('Configuration valid; public-data research/paper only.\n');
  } else if (args.command === 'run') await run(args);
  else if (args.command === 'report') {
    const report = readPreviousReport(args.data);
    if (!report) throw new Error('No report.json in data directory');
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (args.command === 'help') process.stdout.write('Usage: node cli.mjs {check|run|report} [--config FILE] [--data DIR] [--duration SECONDS]\n');
  else throw new Error('Unknown command');
}

if (import.meta.main) main().catch((error) => {
  process.stderr.write(`entropy-lighter-lab: ${error.code || error.message}\n`);
  process.exitCode = 1;
});
