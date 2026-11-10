import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { exportEvidence, EVIDENCE_LIMITS } from '../tools/entropy-lighter-lab/evidence.mjs';
import { createEntropyLighterResearch } from '../server/research/entropy-lighter.mjs';
import { Lab, studyEvaluation } from '../tools/entropy-lighter-lab/core.mjs';
import { createFeedDecoder } from '../tools/entropy-lighter-lab/feeds.mjs';

const session = '11111111-1111-4111-8111-111111111111', at = 1_800_000_000_000;
const query = { session, symbol: 'SNDK', from: at, to: at + 1000 };
function fixture(t, { raw = true, segment = 0, bad = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'entropy-evidence-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'entropy-lighter'); mkdirSync(directory);
  const rows = [
    { type: 'session_start', at, config: { recordRaw: raw, token: 'private-configuration-value' } },
    { type: 'metadata', markets: [{ venue: 'entropy', symbol: 'SNDK', nativeSymbol: 'xyz:SNDK' }] },
    { type: 'raw', venue: 'entropy', receivedAt: at + 1, receivedMono: 1, payload: JSON.stringify({ channel: 'l2Book',
      privateKey: 'secret-raw-field', data: { coin: 'xyz:SNDK', time: at, levels: [[{ px: '1', sz: '2' }], [{ px: '2', sz: '3' }]], token: 'secret-nested-field' } }) },
    { type: 'book', symbol: 'SNDK', venue: 'entropy', receivedAt: at + 1, bids: [[1, 2]], asks: [[2, 3]], apiKey: 'secret-event-field' },
    { type: 'book', symbol: 'ANTH', receivedAt: at + 2 },
    { type: 'paper_fill', symbol: 'SNDK', at: at + 3, price: 2, quantity: 1, fee: 0.01 },
    { type: 'book', symbol: 'SNDK', receivedAt: at + 1000 },
    { type: 'session_end', at: at + 1000 },
  ];
  const file = `events-${at}-${session}-${segment}.jsonl`;
  const body = rows.map(row => JSON.stringify({ ...row, session })).join('\n') + '\n' + (bad ? '{broken}\n' : '');
  writeFileSync(join(directory, file), body);
  return { root, directory, file, body };
}

test('bounded export filters session, symbol and half-open time; exposes raw and normalized source evidence without secrets', async t => {
  const f = fixture(t), before = readdirSync(f.directory);
  const { manifest, jsonl } = await exportEvidence(f.directory, query);
  const rows = jsonl.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 3); assert.equal(manifest.output.rawFrames, 1); assert.equal(manifest.output.normalizedEvents, 2);
  assert.deepEqual(manifest.gaps, []); assert.equal(manifest.collectionStarted, false); assert.equal(manifest.sourceCoverageVerified, false);
  assert.ok(rows.every(row => row.session === session && row.symbol === 'SNDK'));
  assert.equal(rows[0].kind, 'raw_frame'); assert.equal(rows[0].evidenceSource.line, 3);
  assert.equal(rows[0].payload.data.coin, 'xyz:SNDK');
  assert.equal(manifest.sources[0].scannedSha256, createHash('sha256').update(f.body).digest('hex'));
  assert.doesNotMatch(jsonl + JSON.stringify(manifest), /secret-|private-configuration-value|apiKey|privateKey/);
  assert.deepEqual(readdirSync(f.directory), before); assert.equal(readFileSync(join(f.directory, f.file), 'utf8'), f.body);
});

test('missing/cleaned, raw-disabled and bad/partial lines are explicit gaps', async t => {
  const f = fixture(t, { raw: false, segment: 2, bad: true });
  writeFileSync(join(f.directory, f.file), `${f.body}{"unfinished":`);
  const { manifest } = await exportEvidence(f.directory, query);
  for (const gap of ['segments_missing_or_cleaned', 'raw_recording_disabled', 'bad_lines', 'partial_line']) assert.ok(manifest.gaps.includes(gap), gap);
  assert.equal(manifest.scanComplete, false); assert.equal(manifest.sources[0].badLines, 1);
  const absent = await exportEvidence(f.directory, { ...query, session: '22222222-2222-4222-8222-222222222222' });
  assert.ok(absent.manifest.gaps.includes('session_logs_absent_or_cleaned')); assert.equal(absent.jsonl, '');
});

test('scan/output records, bytes, directory entries and elapsed time are bounded independently', async t => {
  const f = fixture(t);
  for (const [limits, reason] of [
    [{ outputRecords: 1 }, 'output_record_limit'], [{ outputBytes: 10 }, 'output_byte_limit'],
    [{ scanRecords: 2 }, 'scan_record_limit'], [{ scanBytes: 20 }, 'scan_byte_limit'], [{ lineBytes: 10 }, 'oversize_line'],
  ]) {
    const result = await exportEvidence(f.directory, query, { limits });
    assert.ok(result.manifest.gaps.includes(reason), reason);
    assert.ok(result.manifest.scan.bytes <= (limits.scanBytes ?? EVIDENCE_LIMITS.scanBytes));
    assert.ok(result.manifest.output.records <= (limits.outputRecords ?? EVIDENCE_LIMITS.outputRecords));
    assert.ok(result.manifest.output.bytes <= (limits.outputBytes ?? EVIDENCE_LIMITS.outputBytes));
  }
  writeFileSync(join(f.directory, 'unrelated.json'), '{}');
  const bounded = await exportEvidence(f.directory, query, { limits: { directoryEntries: 1 } });
  assert.ok(bounded.manifest.gaps.includes('directory_entry_limit'));
  let now = 0;
  const timed = await exportEvidence(f.directory, query, { limits: { scanMs: 3 }, clock: () => now++ });
  assert.ok(timed.manifest.gaps.includes('scan_time_limit'));
  await assert.rejects(() => exportEvidence(f.directory, { ...query, to: at + 86_400_001 }), RangeError);
  await assert.rejects(() => exportEvidence(f.directory, { ...query, session: '../report' }), RangeError);
});

test('service and actual CLI export read existing files without starting or changing the collector', async t => {
  const f = fixture(t); let starts = 0;
  const service = createEntropyLighterResearch({ dataDir: f.root, launch: () => { starts++; throw new Error('unexpected worker'); } });
  const result = await service.exportEvidence(query);
  assert.equal(result.manifest.output.records, 3); assert.equal(starts, 0);
  await assert.rejects(() => service.exportEvidence({ ...query, symbol: 'BTC' }), error => error.status === 400);
  const target = join(f.root, 'bundle');
  const invocation = spawnSync(process.execPath, [resolve('tools/entropy-lighter-lab/cli.mjs'), 'export', '--data', f.directory,
    '--session', session, '--symbol', 'SNDK', '--from', String(at), '--to', String(at + 1000), '--out', target], { encoding: 'utf8' });
  assert.equal(invocation.status, 0, invocation.stderr);
  assert.equal(JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8')).output.records, 3);
  assert.equal(readFileSync(join(target, 'events.jsonl'), 'utf8'), result.jsonl);
  assert.deepEqual(readdirSync(f.directory), [f.file]);
  await service.close();
});

test('production study and paper events retain outcomes, leg states, fee assumptions and source-clock errors', async t => {
  const f = fixture(t), events = [];
  const config = JSON.parse(readFileSync(new URL('../tools/entropy-lighter-lab/config.example.json', import.meta.url), 'utf8'));
  Object.assign(config.simulation, { enabled: true, verifiedSymbols: ['SNDK'], entropyTakerFeeBps: 5, lighterTakerFeeBps: 2,
    holdMs: 100, fillWaitMs: 200, slippageBpsPerFill: 0, fundingReserveBpsPerRoundTrip: 1,
    latencyScenarios: [{ name: 'test', entropyMs: 200, lighterMs: 450 }] });
  config.privateKey = 'private-configuration-value';
  const emit = event => events.push(structuredClone(event));
  const createLab = () => {
    const lab = new Lab(config, emit);
    lab.setMarkets(['entropy', 'lighter'].map(venue => ({ venue, symbol: 'SNDK', nativeSymbol: 'SNDK', quote: 'USDC',
      sizeDecimals: 4, status: 'active', multiplier: 1, minBaseAmount: 0.0001, minQuoteAmount: 10,
      fee: { status: 'available', takerFeeBps: venue === 'entropy' ? 5 : 2, fetchedAt: at, expiresAt: at + 10_000,
        revision: `${venue}-fixture`, scope: 'public_default_tier_no_builder', accountTier: 'default',
        sourceUrls: ['https://api.hyperliquid.xyz/info'], assumptions: ['public_default_tier'], apiKey: 'secret-fee-field' } })), 0, at);
    return lab;
  };
  const book = (venue, mono, bid, ask, overrides = {}) => ({ venue, symbol: 'SNDK', nativeSymbol: 'SNDK', quote: 'USDC',
    receivedMono: mono, receivedAt: at + mono, sourceAt: at + mono, sequence: String(mono), bids: [[bid, 100]], asks: [[ask, 100]], ...overrides });
  const lab = createLab();
  const probe = { key: 'probe', symbol: 'SNDK', metric: lab.studyMetric('SNDK', 'entropy', 'lighter', config.simulation.latencyScenarios[0]), signalAt: at };
  const evaluation = studyEvaluation({ buy: { venue: 'entropy', price: 100, cash: 100, quantity: 1 },
    sell: { venue: 'lighter', price: 102, cash: 102, quantity: 1 }, config, at: at + 1, feeSnapshot: lab.feeSnapshot('SNDK', 1, at + 1) });
  lab.endStudy(probe, evaluation, null, 1); lab.endStudy(probe, null, 'timeout', 2);
  lab.book(book('entropy', 0, 99, 100)); lab.book(book('lighter', 0, 110, 111));
  lab.book(book('entropy', 201, 99, 100)); lab.book(book('lighter', 451, 110, 111)); lab.advance(551, at + 551);
  lab.book(book('entropy', 752, 105, 106)); lab.book(book('lighter', 1002, 104, 105));
  const unresolved = createLab();
  unresolved.book(book('entropy', 0, 99, 100)); unresolved.book(book('lighter', 0, 110, 111));
  unresolved.book(book('entropy', 201, 99, 100)); unresolved.advance(652, at + 652); unresolved.advance(1053, at + 1053);
  const uncertain = createLab();
  uncertain.book(book('entropy', 0, 99, 100)); uncertain.book(book('lighter', 0, 110, 111, { sourceAt: at + 1000 }));
  const written = [{ type: 'session_start', at, config }, ...events.map(row => ({ recordedAt: at + 5, ...row })), { type: 'session_end', at: at + 2000 }];
  writeFileSync(join(f.directory, f.file), written.map(row => JSON.stringify({ ...row, session })).join('\n') + '\n');
  const result = await exportEvidence(f.directory, { ...query, to: at + 2000 });
  const exported = result.jsonl.trim().split('\n').map(JSON.parse);
  assert.deepEqual(result.manifest.gaps, []);
  const studies = exported.filter(row => row.type === 'delay_study').slice(0, 2);
  assert.equal(studies[0].evaluation.surplusBeforeRebateBps, evaluation.surplusBeforeRebateBps);
  assert.deepEqual(studies[0].evaluation.costs, evaluation.costs);
  assert.deepEqual(studies[0].evaluation.rebates, evaluation.rebates);
  assert.equal(studies[0].evaluation.feeSnapshot.entropy.takerFeeBps, 5);
  assert.equal(studies[0].evaluation.feeSnapshot.rebateBasis, 'total_entropy_fees');
  assert.equal(studies[0].signalAt, at); assert.equal(studies[0].failure, null);
  assert.equal(studies[1].evaluation, null); assert.equal(studies[1].failure, 'timeout');
  const signal = exported.find(row => row.type === 'paper_signal');
  assert.equal(signal.legs.length, 2); assert.ok(signal.legs.every(leg => leg.state === 'pending'));
  assert.equal(signal.costConfig.simulation.entropyTakerFeeBps, 5);
  assert.equal(signal.costConfig.simulation.fundingReserveBpsPerRoundTrip, 1);
  const outcomes = exported.filter(row => row.type === 'paper_result');
  assert.equal(outcomes.length, 2);
  const success = outcomes.find(row => !row.failed), pending = outcomes.find(row => row.unresolved);
  assert.equal(success.unresolved, false); assert.ok(success.legs.every(leg => leg.state === 'closed'));
  assert.equal(success.netBeforeRebate, success.grossPnl - success.fees - success.costReserve);
  assert.equal(success.rebateScenarios[1].contingentRebate, success.entropyFees * 1.1);
  assert.equal(pending.failed, true); assert.equal(pending.netBeforeRebate, null);
  assert.deepEqual(pending.legs.map(leg => leg.state), ['unresolved', 'rejected']);
  assert.ok(exported.some(row => row.type === 'spread' && row.sourceTimeErrors.some(item => item.error)));
  assert.doesNotMatch(result.jsonl, /private-configuration-value|secret-fee-field|apiKey|privateKey/);
});

test('production public raw frames and normalized books report actual projection truncation', async t => {
  const f = fixture(t), frames = [], books = [];
  const markets = [{ venue: 'entropy', symbol: 'SNDK', nativeSymbol: 'xyz:SNDK', quote: 'USDC' }];
  const decoder = createFeedDecoder({ markets, onRaw: row => frames.push({ type: 'raw', ...row }), onBook: row => books.push({ type: 'book', ...row }) });
  decoder.handle('entropy', JSON.stringify({ channel: 'l2Book', data: { coin: 'xyz:SNDK', time: at + 1,
    levels: [Array.from({ length: 2001 }, (_, index) => ({ px: String(3000 - index), sz: '1' })), [{ px: '3001', sz: '1' }]] } }),
  { receivedAt: at + 1, receivedMono: 1 });
  assert.equal(frames.length, 1); assert.equal(books.length, 1);
  const rows = [{ type: 'session_start', at, config: { recordRaw: true } }, { type: 'metadata', markets }, ...frames, ...books, { type: 'session_end', at: at + 1000 }];
  writeFileSync(join(f.directory, f.file), rows.map(row => JSON.stringify({ ...row, session })).join('\n') + '\n');
  const result = await exportEvidence(f.directory, query), exported = result.jsonl.trim().split('\n').map(JSON.parse);
  assert.equal(exported[0].payload.data.levels[0].length, 2000); assert.equal(exported[1].bids.length, 2000);
  assert.ok(result.manifest.gaps.includes('projection_array_item_limit'));
  assert.equal(result.manifest.scanComplete, false);
});
