import { mkdir, readFile, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PERPETUAL_PAPER_LIMITS as limits, calculatePerpetualPaperPnl } from '../lib/perpetual-paper.ts';
import { takerFeeVenues, validFeePercent } from '../lib/perpetual-fees.ts';
import { validatePerpetualExitPosition } from '../lib/perpetual-exit.ts';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const nullable = value => value === null || finite(value);
const time = value => finite(value) && value > 0;
const nullableTime = value => value === null || time(value);
const positive = value => finite(value) && value > 0;
const money = value => finite(value) && Math.abs(value) <= 1e9;
const text = (value, max) => typeof value === 'string' && value.length <= max;
const keys = value => text(value, 160) && /^[a-z0-9-]+:[^\s\u0000-\u001f]+$/.test(value);
const venueIds = new Set(takerFeeVenues.map(item => item.id));
const invalid = () => { throw new Error('Invalid paper-position state'); };

/** Reject corrupt states instead of silently losing active position records. */
export function validatePerpetualPaperState(input) {
  if (!input || input.version !== 1 || !Number.isSafeInteger(input.revision) || input.revision < 0 || !Array.isArray(input.positions)
    || input.positions.length > limits.active + limits.closed || input.positions.filter(item => item?.status === 'active').length > limits.active
    || input.positions.filter(item => item?.status !== 'active').length > limits.closed) invalid();
  const ids = new Set(), requestIds = new Set();
  const positions = input.positions.map(item => {
    try { validatePerpetualExitPosition(item); } catch { invalid(); }
    if (!item || !text(item.id, 64) || !/^[a-zA-Z0-9_-]+$/.test(item.id) || ids.has(item.id)
      || !['paper', 'manual'].includes(item.mode) || !['active', 'closed', 'stopped'].includes(item.status)
      || !text(item.base, 80) || !item.base || !keys(item.longKey) || !keys(item.shortKey) || item.longKey.split(':')[0] === item.shortKey.split(':')[0]
      || !text(item.identity, 1000) || !item.identity || !text(item.note, 200)
      || ![item.quantity, item.entryLongPrice, item.entryShortPrice].every(positive) || !money(item.entryFeePaid) || item.entryFeePaid < 0 || !money(item.settledFunding)
      || !positive(item.quantity * item.entryLongPrice) || !positive(item.quantity * item.entryShortPrice)
      || !(item.capital === null || positive(item.capital)) || !(item.targetNetProfit === null || money(item.targetNetProfit))
      || !(item.maxHoldingHours === null || positive(item.maxHoldingHours) && item.maxHoldingHours <= 8760)
      || ![item.openedAt, item.createdAt, item.updatedAt, item.fundingUpdatedAt].every(time) || item.openedAt > item.createdAt || item.updatedAt < item.createdAt
      || ![item.nextFundingAt, item.targetReachedAt, item.timedOutAt].every(nullableTime) || !nullable(item.worstObservedNetProfit)
      || !Number.isSafeInteger(item.observations) || item.observations < 0 || !Number.isSafeInteger(item.validObservations) || item.validObservations < 0 || item.validObservations > item.observations
      || !Array.isArray(item.samples) || item.samples.length > (item.status === 'active' ? limits.samples : limits.closedSamples)
      || item.samples.some((point, index) => !Array.isArray(point) || point.length !== 2 || !time(point[0]) || !nullable(point[1]) || index > 0 && point[0] <= item.samples[index - 1][0])
      || !item.takerOverrides || typeof item.takerOverrides !== 'object' || Array.isArray(item.takerOverrides)
      || Object.entries(item.takerOverrides).some(([venue, rate]) => !venueIds.has(venue) || !validFeePercent(rate))) invalid();
    ids.add(item.id);
    if (item.requestId !== undefined || item.requestFingerprint !== undefined) {
      if (typeof item.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.requestId)
        || typeof item.requestFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(item.requestFingerprint) || requestIds.has(item.requestId)) invalid();
      requestIds.add(item.requestId);
    }
    let lastObservation = null, close = null;
    if (item.lastObservation !== null) {
      const observation = item.lastObservation;
      if (!observation || !time(observation.at) || typeof observation.valid !== 'boolean' || !text(observation.reason, 200) || !nullableTime(observation.sourceAt)
        || !nullable(observation.longBid) || !nullable(observation.shortAsk) || typeof observation.fundingNeedsReview !== 'boolean') invalid();
      if (observation.valid && (!observation.pnl || !positive(observation.longBid) || !positive(observation.shortAsk) || !time(observation.sourceAt)
        || Object.values(observation.pnl).some(value => !nullable(value)))) invalid();
      if (!observation.valid && observation.pnl !== null) invalid();
      // Historical manual funding may differ from the latest user-confirmed total.
      const pnl = observation.valid ? calculatePerpetualPaperPnl({ ...item, settledFunding: observation.pnl.settledFunding }, {
        exitLongPrice: observation.longBid, exitShortPrice: observation.shortAsk, closeFeePaid: observation.pnl.closeFeePaid,
      }) : null;
      if (observation.valid && !pnl) invalid();
      // Capital can be edited later; keep the historical denominator's recorded return.
      if (pnl) {
        if (!nullable(observation.pnl.returnOnCapitalPercent)) invalid();
        pnl.returnOnCapitalPercent = observation.pnl.returnOnCapitalPercent;
      }
      lastObservation = { at: observation.at, valid: observation.valid, reason: observation.reason, sourceAt: observation.sourceAt,
        longBid: observation.longBid, shortAsk: observation.shortAsk, pnl, fundingNeedsReview: observation.fundingNeedsReview };
    }
    if (item.status !== 'active') {
      const value = item.close;
      if (!value || !time(value.closedAt) || value.closedAt < item.openedAt || !money(value.settledFunding) || value.kind !== (item.status === 'closed' ? 'realized' : 'stop')) invalid();
      const pnl = value.kind === 'realized' ? calculatePerpetualPaperPnl({ ...item, settledFunding: value.settledFunding }, value) : null;
      if (value.kind === 'realized' && !pnl) invalid();
      close = { kind: value.kind, closedAt: value.closedAt, exitLongPrice: value.kind === 'realized' ? value.exitLongPrice : null,
        exitShortPrice: value.kind === 'realized' ? value.exitShortPrice : null, closeFeePaid: value.kind === 'realized' ? value.closeFeePaid : null, settledFunding: value.settledFunding, pnl };
    } else if (item.close !== null) invalid();
    return { id: item.id, mode: item.mode, status: item.status, base: item.base, longKey: item.longKey, shortKey: item.shortKey, identity: item.identity,
      ...(item.requestId ? { requestId: item.requestId, requestFingerprint: item.requestFingerprint } : {}),
      note: item.note, quantity: item.quantity, entryLongPrice: item.entryLongPrice, entryShortPrice: item.entryShortPrice, entryFeePaid: item.entryFeePaid,
      settledFunding: item.settledFunding, capital: item.capital, targetNetProfit: item.targetNetProfit, maxHoldingHours: item.maxHoldingHours,
      takerOverrides: { ...item.takerOverrides }, openedAt: item.openedAt, createdAt: item.createdAt, updatedAt: item.updatedAt,
      fundingUpdatedAt: item.fundingUpdatedAt, nextFundingAt: item.nextFundingAt, lastObservation, close,
      worstObservedNetProfit: item.worstObservedNetProfit, targetReachedAt: item.targetReachedAt, timedOutAt: item.timedOutAt,
      observations: item.observations, validObservations: item.validObservations, samples: item.samples.map(point => [...point]),
    };
  });
  return { version: 1, revision: input.revision, positions };
}

export async function openPerpetualPaperStore(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = resolve(directory, 'paper-positions.json');
  let state = { version: 1, revision: 0, positions: [] };
  try {
    if ((await stat(file)).size > limits.fileBytes) throw new Error('State too large');
    state = validatePerpetualPaperState(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('持仓记录无法读取，请修复或恢复 paper-positions.json。', { cause: error }); }
  return {
    get: () => structuredClone(state),
    async save(next) {
      const copy = validatePerpetualPaperState(next), content = `${JSON.stringify(copy)}\n`;
      if (Buffer.byteLength(content) > limits.fileBytes) throw new Error('持仓记录超过 1 MB 上限。');
      // The runtime holds the data-directory lock and serializes paper writes.
      // Reuse one path so interrupted writes cannot accumulate orphan files.
      const temporary = `${file}.tmp`;
      try { await writeFile(temporary, content, { mode: 0o600 }); await rename(temporary, file); state = copy; }
      catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    },
  };
}
