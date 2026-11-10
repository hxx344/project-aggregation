// Bounded offline reads only. This module has no feed, worker or simulation dependency.
import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const EVIDENCE_LIMITS = Object.freeze({ windowMs: 86_400_000, directoryEntries: 4096, files: 32,
  scanBytes: 32 * 1024 * 1024, scanRecords: 100_000, outputBytes: 4 * 1024 * 1024, outputRecords: 10_000,
  lineBytes: 4 * 1024 * 1024, scanMs: 3000 });
const SESSION = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const FILE = /^events-(\d{13})-([a-f0-9-]{36})-(\d+)\.jsonl$/;
// Event shapes follow Lab/BinanceScalper emission contracts. A name permitted in one
// context does not authorize the same name elsewhere (notably costConfig and raw).
const fields = (names, nested = {}) => ({ ...Object.fromEntries(names.split(/\s+/).filter(Boolean).map(name => [name, true])), ...nested });
const SCENARIO = fields('name entropyMs lighterMs');
const VENUES = fields('entropy lighter binance');
const REBATE = fields('ratio contingentRebate net contingentRebateCash surplusCash');
const FEE_FACT = fields('status takerFeeBps baseTakerBps growthMultiplier deployerFeeScale scope accountTier fetchedAt expiresAt revision reason',
  { sourceUrls: [true], assumptions: [true] });
const FEE = fields('mode symbol status revision fetchedAt expiresAt rebateBasis', {
  entropy: FEE_FACT, lighter: FEE_FACT, takerBps: { ...VENUES, $scalar: true }, rebateRatios: [true],
});
const FILL = fields('side quantity price cash fee receivedAt receivedMono sourceAt sequence venue at mono sourceTimeUncertain', { feeSnapshot: FEE });
const RULES = fields('nativeSymbol quote sizeDecimals multiplier minBaseAmount minQuoteAmount');
const LEG = fields('venue side due state lastFillFailure', { entry: FILL, exit: FILL, fill: FILL, rules: RULES });
const COSTS = fields('notionalPerLeg entropyTakerFeeBps lighterTakerFeeBps minEntryEdgeBps slippageBpsPerFill fundingReserveBpsPerRoundTrip holdMs fillWaitMs cooldownMs', { rebateRatios: [true] });
const EVALUATION = fields('at quantity buyPrice sellPrice buyNotional sellNotional grossCash grossBps surplusBeforeRebateCash surplusBeforeRebateBps entropyRoundTripFeesCash gatePassed sourceTimeUncertain', {
  costs: fields('feesRoundTripCash exitSlippageReserveCash fundingReserveCash totalReserveCash'), rebates: [REBATE], feeSnapshot: FEE,
});
const COMMON = fields('type symbol at mono recordedAt');
const EVENT_FIELDS = {
  book: fields('venue nativeSymbol quote priceUnit settlement receivedAt receivedMono sourceAt sequence sourceClockDeltaMs sourceTimeError sourceClockUncertain', { bids: [[true]], asks: [[true]] }),
  spread: fields('entropyMid lighterMid midBasisBps takerEdgeBps edgeBps buy sell observation settlementEquivalence', { sourceTimeErrors: [fields('venue error')] }),
  invalidated: fields('venue reason'),
  fee_epoch: { feeSnapshot: FEE },
  leader_markout: fields('venue lagMs binanceMoveBps followerMoveBps observedLagMs method'),
  delay_study: fields('buy sell signalAt failure assumption', { scenario: SCENARIO, evaluation: EVALUATION }),
  paper_signal: fields('key quantity signalAt signalMono edgeBps phase failed assumption', { scenario: SCENARIO, legs: [LEG], feeSnapshot: FEE, costConfig: { simulation: COSTS } }),
  paper_fill: { ...fields('key venue phase'), ...FILL },
  paper_unresolved: fields('key venue reason lastFillFailure', { entry: FILL }),
  paper_rejected: fields('key venue phase reason'),
  paper_result: fields('key scenario failed unresolved grossPnl fees entropyFees costReserve netBeforeRebate durationMs', { turnover: VENUES, rebateScenarios: [REBATE], legs: [LEG], feeSnapshot: FEE }),
};
const ARMED = fields('at upper lower referenceAt sourceAt sequence receivedAt receivedMono');
const SCALP = fields('scenario id venue direction triggerPrice entryDueAt exitDueAt assumedOrder ocoOtherSideCancelled reason outcome signalAt entryAt exitAt entryPrice exitPrice quantity exitReason durationMs grossPnl fees costReserve netBeforeRebate turnover',
  { armed: ARMED, fill: FILL, rebateScenarios: [REBATE], feeSnapshot: FEE, costConfig: COSTS });
for (const type of ['disarmed', 'exit_intent', 'exit_sent', 'result', 'signal', 'entry_fill', 'exit_fill', 'invalidated', 'armed']) EVENT_FIELDS[`binance_scalp_${type}`] = SCALP;

function publicValue(value, schema, gaps, depth = 0) {
  if (depth > 12) { gaps.add('projection_depth_limit'); return null; }
  if (value === null) return null;
  if (schema === true || schema?.$scalar && typeof value !== 'object') {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') {
      if (value.length > 160) { gaps.add('projection_string_limit'); return '[omitted]'; }
      return /(?:bearer\s|gh[pousr]_|github_pat_|-----BEGIN)/i.test(value) ? '[omitted]' : value;
    }
    gaps.add('normalized_field_shape_unsupported'); return null;
  }
  if (Array.isArray(schema) && Array.isArray(value)) {
    if (value.length > 2000) gaps.add('projection_array_item_limit');
    return value.slice(0, 2000).map(item => publicValue(item, schema[0], gaps, depth + 1));
  }
  if (Array.isArray(schema) || !value || typeof value !== 'object' || Array.isArray(value)) {
    gaps.add('normalized_field_shape_unsupported'); return null;
  }
  return Object.fromEntries(Object.entries(schema).filter(([key]) => key !== '$scalar' && Object.hasOwn(value, key))
    .map(([key, shape]) => [key, publicValue(value[key], shape, gaps, depth + 1)]));
}
const numeric = value => typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value);
function levels(rows, gaps) {
  if (!Array.isArray(rows)) return [];
  if (rows.length > 2000) gaps.add('projection_array_item_limit');
  return rows.slice(0, 2000).flatMap(row => {
    const price = Array.isArray(row) ? row[0] : row?.px ?? row?.price;
    const size = Array.isArray(row) ? row[1] : row?.sz ?? row?.size;
    return numeric(price) && numeric(size) ? [[price, size]] : [];
  });
}
function rawFrame(row, markets, gaps) {
  let payload;
  try { payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload; } catch { return null; }
  if (!payload || typeof payload !== 'object') return null;
  const data = payload.data ?? payload;
  let market, projected;
  if (row.venue === 'entropy' && payload.channel === 'l2Book') {
    market = markets.find(item => item.venue === row.venue && item.nativeSymbol === data.coin);
    projected = { channel: 'l2Book', data: { coin: market?.nativeSymbol, time: numeric(data.time) ? data.time : null, levels: [levels(data.levels?.[0], gaps), levels(data.levels?.[1], gaps)] } };
  } else if (row.venue === 'lighter' && ['subscribed/order_book', 'update/order_book'].includes(payload.type)) {
    const id = /^order_book:(\d+)$/.exec(payload.channel)?.[1], book = payload.order_book;
    market = markets.find(item => item.venue === row.venue && String(item.marketId) === id);
    projected = { type: payload.type, channel: `order_book:${id}`, order_book: { bids: levels(book?.bids, gaps), asks: levels(book?.asks, gaps) } };
    for (const key of ['nonce', 'begin_nonce', 'last_updated_at']) if (numeric(book?.[key])) projected.order_book[key] = book[key];
    if (numeric(payload.last_updated_at)) projected.last_updated_at = payload.last_updated_at;
  } else if (row.venue === 'binance' && data.e === 'depthUpdate') {
    market = markets.find(item => item.venue === row.venue && item.nativeSymbol === data.s);
    projected = { e: 'depthUpdate', s: market?.nativeSymbol, b: levels(data.b, gaps), a: levels(data.a, gaps) };
    for (const key of ['E', 'T', 'U', 'u', 'pu', 'st']) if (numeric(data[key])) projected[key] = data[key];
  }
  return market ? { symbol: market.symbol, payload: projected,
    payloadSha256: createHash('sha256').update(typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload)).digest('hex') } : null;
}

export function validateEvidenceQuery(query) {
  const { session, symbol } = query || {}, from = Number(query?.from), to = Number(query?.to);
  if (typeof session !== 'string' || !SESSION.test(session) || !['SNDK', 'ANTH'].includes(symbol)
    || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1e12 || to <= from || to - from > EVIDENCE_LIMITS.windowMs) {
    throw new RangeError('请选择有效会话、标的和不超过 24 小时的毫秒时间窗');
  }
  return { session, symbol, from, to };
}

export async function exportEvidence(directory, query, { limits: overrides = {}, clock = () => performance.now() } = {}) {
  const selection = validateEvidenceQuery(query), started = clock();
  const limits = Object.fromEntries(Object.entries(EVIDENCE_LIMITS).map(([key, maximum]) => [key, Math.min(maximum, Math.max(1, overrides[key] ?? maximum))]));
  const manifest = { schema: 1, selection, timeBasis: 'receivedAt_then_at_then_recordedAt', timeWindow: '[from,to)',
    limits, scan: { directoryEntries: 0, files: 0, bytes: 0, records: 0, elapsedMs: 0 },
    output: { bytes: 0, records: 0, rawFrames: 0, normalizedEvents: 0 }, sources: [], gaps: [],
    recordRaw: null, sessionStartSeen: false, sessionEndSeen: false, sourceCoverageVerified: false,
    rawProjection: 'public_market_fields_only_original_payload_sha256', maxDepthLevelsPerSide: 2000, collectionStarted: false };
  const gaps = new Set(), files = [], output = [];
  let markets = [], earliest = Infinity, latest = -Infinity, halted = false;
  const halt = reason => { gaps.add(reason); halted = true; };
  const expired = () => { if (clock() - started >= limits.scanMs) halt('scan_time_limit'); return halted; };
  try {
    const dir = await opendir(directory);
    for await (const entry of dir) {
      if (expired()) break;
      if (manifest.scan.directoryEntries >= limits.directoryEntries) { halt('directory_entry_limit'); break; }
      manifest.scan.directoryEntries++;
      const match = FILE.exec(entry.name);
      if (!match || match[2] !== selection.session) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) { gaps.add('non_regular_segment'); continue; }
      files.push({ name: entry.name, segment: Number(match[3]) });
    }
  } catch (error) { gaps.add(error.code === 'ENOENT' ? 'session_logs_absent_or_cleaned' : 'directory_unreadable'); }
  files.sort((a, b) => a.segment - b.segment);
  if (!files.length) gaps.add('session_logs_absent_or_cleaned');
  if (files.length && files[0].segment !== 0 || files.some((file, index) => index > 0 && file.segment !== files[index - 1].segment + 1)) gaps.add('segments_missing_or_cleaned');
  if (files.length > limits.files) gaps.add('file_limit');
  // Directory truncation still permits exporting the files already found, but remains explicit.
  halted = false;
  for (const file of files.slice(0, limits.files)) {
    if (expired()) break;
    let handle;
    const source = { file: file.name, segment: file.segment, scannedBytes: 0, scannedRecords: 0, badLines: 0, complete: false };
    const hash = createHash('sha256');
    manifest.sources.push(source);
    try {
      const pathname = join(directory, file.name), info = await lstat(pathname);
      if (!info.isFile() || info.isSymbolicLink()) { gaps.add('non_regular_segment'); continue; }
      handle = await open(pathname, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev) { gaps.add('segment_changed'); continue; }
      source.sizeAtOpen = opened.size; manifest.scan.files++;
      let pending = Buffer.alloc(0), position = 0, line = 0;
      while (position < opened.size && !expired()) {
        if (manifest.scan.bytes >= limits.scanBytes) { halt('scan_byte_limit'); break; }
        const buffer = Buffer.alloc(Math.min(64 * 1024, opened.size - position, limits.scanBytes - manifest.scan.bytes));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (!bytesRead) { gaps.add('segment_changed'); break; }
        position += bytesRead; source.scannedBytes += bytesRead; manifest.scan.bytes += bytesRead;
        const chunk = buffer.subarray(0, bytesRead); hash.update(chunk); pending = Buffer.concat([pending, chunk]);
        let newline;
        while ((newline = pending.indexOf(10)) !== -1 && !expired()) {
          if (manifest.scan.records >= limits.scanRecords) { halt('scan_record_limit'); break; }
          const bytes = pending.subarray(0, newline); pending = pending.subarray(newline + 1); line++;
          source.scannedRecords++; manifest.scan.records++;
          if (bytes.length > limits.lineBytes) { source.badLines++; gaps.add('oversize_line'); continue; }
          let row;
          try { row = JSON.parse(bytes.toString('utf8')); if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(); }
          catch { source.badLines++; gaps.add('bad_lines'); continue; }
          if (row.session !== selection.session) { gaps.add('session_mismatch'); continue; }
          if (row.type === 'session_start') { manifest.sessionStartSeen = true; manifest.recordRaw = typeof row.config?.recordRaw === 'boolean' ? row.config.recordRaw : null; }
          if (row.type === 'session_end') manifest.sessionEndSeen = true;
          if (row.type === 'metadata' && Array.isArray(row.markets)) markets = row.markets.filter(item => ['SNDK', 'ANTH'].includes(item?.symbol)
            && ['entropy', 'lighter', 'binance'].includes(item?.venue) && /^[\w:@./-]{1,80}$/.test(item?.nativeSymbol || '')).slice(0, 32);
          const at = [row.receivedAt, row.at, row.recordedAt].find(value => Number.isSafeInteger(value) && value >= 1e12);
          if (at === undefined) { if (!['metadata', 'session_start', 'session_end'].includes(row.type)) gaps.add('events_without_wall_time'); continue; }
          earliest = Math.min(earliest, at); latest = Math.max(latest, at);
          if (at < selection.from || at >= selection.to) continue;
          let record;
          if (row.type === 'raw') {
            const raw = rawFrame(row, markets, gaps);
            if (!raw) { gaps.add('raw_symbol_unresolved_or_unsupported'); continue; }
            if (raw.symbol !== selection.symbol) continue;
            record = { kind: 'raw_frame', session: row.session, venue: row.venue, receivedAt: row.receivedAt, receivedMono: row.receivedMono, ...raw };
          } else {
            if (row.symbol !== selection.symbol) continue;
            const shape = EVENT_FIELDS[row.type];
            if (!shape) { gaps.add('normalized_event_type_unsupported'); continue; }
            record = { kind: 'normalized_event', session: row.session, ...publicValue(row, { ...COMMON, ...shape }, gaps) };
          }
          const text = `${JSON.stringify({ ...record, evidenceSource: { file: file.name, line } })}\n`;
          const length = Buffer.byteLength(text);
          if (manifest.output.records >= limits.outputRecords) { halt('output_record_limit'); break; }
          if (manifest.output.bytes + length > limits.outputBytes) { halt('output_byte_limit'); break; }
          output.push(text); manifest.output.bytes += length; manifest.output.records++;
          manifest.output[record.kind === 'raw_frame' ? 'rawFrames' : 'normalizedEvents']++;
        }
        if (pending.length > limits.lineBytes) { halt('oversize_line'); break; }
      }
      source.complete = !halted && position === opened.size && pending.length === 0;
      if (!halted && pending.length) gaps.add('partial_line');
      const final = await handle.stat();
      if (final.size !== opened.size || final.mtimeMs !== opened.mtimeMs) gaps.add('segment_changed_during_read');
    } catch (error) { gaps.add(error.code === 'ENOENT' ? 'segment_cleaned_during_read' : 'segment_unreadable'); }
    finally { source.scannedSha256 = hash.digest('hex'); await handle?.close(); }
    if (halted) break;
  }
  if (!manifest.sessionStartSeen) gaps.add('session_start_absent_or_cleaned');
  if (manifest.recordRaw === false) gaps.add('raw_recording_disabled');
  else if (manifest.recordRaw === null) gaps.add('raw_recording_state_unknown');
  if (!Number.isFinite(earliest) || selection.from < earliest || selection.to > latest + 1) gaps.add('window_outside_retained_observations');
  manifest.observedRange = Number.isFinite(earliest) ? { from: earliest, to: latest } : null;
  manifest.scan.elapsedMs = Math.round((clock() - started) * 100) / 100;
  manifest.gaps = [...gaps]; manifest.scanComplete = !gaps.size;
  return { manifest, jsonl: output.join('') };
}
