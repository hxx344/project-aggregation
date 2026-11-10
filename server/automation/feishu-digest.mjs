import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { deliveryReview, publicDeliveryReviews } from './delivery-review.mjs';
import { atomicJson } from '../../tools/entropy-lighter-lab/core.mjs';
import { HttpError } from '../http-common.mjs';
import { DIGEST_DEFAULTS, buildDigest, latestSlot, nextSlot, postCard, renderCard, validateChannel, validateDigestConfig } from './feishu-digest-core.mjs';

const FILE_LIMIT = 256 * 1024;
const HISTORY_LIMIT = 20;
// A restart inside this window still delivers the slot it missed.
const GRACE_MINUTES = 15;
// Typing in the form previews every 400 ms; one read serves them until this expires or fails.
const PREVIEW_CACHE_MS = 15000;

function readBounded(file) {
  if (!existsSync(file)) return null;
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > FILE_LIMIT) throw new Error('invalid_feishu_digest_file');
  return JSON.parse(readFileSync(file, 'utf8'));
}
function checked(validate, value) {
  try { return validate(value); } catch (error) { throw new HttpError(400, error.message); }
}

// The webhook is a credential: it is stored encrypted, decrypted only to send,
// and never returned. lastSlot is written before sending, so a crash or a lost
// response cannot post one slot twice; only a definite refusal retries.
export function createFeishuDigest({ dataDir, encrypt, decrypt, readSections, log = console, fetcher = fetch, now = Date.now,
  tickMs = 20000, retryMs = 60000, maxAttempts = 3 } = {}) {
  const directory = path.join(dataDir, 'feishu-digest');
  const configPath = path.join(directory, 'config.json'), channelPath = path.join(directory, 'channel.json'), statePath = path.join(directory, 'state.json');
  const reviewPath = path.join(directory, 'reviews.json');
  let reviews = {}, reviewError = null;
  let config = structuredClone(DIGEST_DEFAULTS), loadError = null, stateError = null, channelHost = null, channelError = null;
  let lastSlot = 0, history = [], retry = null, sending = null, controller = null, timer = null, closed = false, epoch = 0, previewRead = null;
  const minuteNow = () => Math.floor(now() / 60000);
  const hostOf = url => new URL(url).hostname;

  function persistState(nextSlot = lastSlot) {
    try {
      atomicJson(statePath, { lastSlot: nextSlot, history }); stateError = null;
      return true;
    } catch (error) {
      stateError = '发送状态无法保存，新的定时发送将等待存储恢复';
      log.warn({ err: error, type: 'feishu-digest' }, '飞书汇总状态写入失败');
      return false;
    }
  }
  function record(entry) {
    // Quiet checks collapse into one row, so a frequent schedule cannot push failures out.
    const retained = history.filter(item => item.id !== entry.id);
    if (entry.status === 'skipped' && retained[0]?.status === 'skipped') retained.shift();
    history = [entry, ...retained].slice(0, HISTORY_LIMIT);
    const saved = persistState();
    if (entry.status === 'failed' || entry.status === 'uncertain') log.warn({ status: entry.status, kind: entry.kind, error: entry.error, type: 'feishu-digest' }, '飞书汇总发送失败');
    return saved;
  }
  function readChannel() {
    const saved = readBounded(channelPath);
    if (!saved) throw new HttpError(409, '请先保存飞书机器人 Webhook');
    return decrypt(saved.value);
  }
  // A send already under way must not bring back a retry the user has cancelled.
  function invalidate() { epoch++; retry = null; }
  function previewSections(fresh) {
    if (fresh || !previewRead || now() - previewRead.at >= PREVIEW_CACHE_MS) {
      const read = { at: now(), items: readSections() };
      previewRead = read;
      read.items.catch(() => { if (previewRead === read) previewRead = null; });
    }
    return previewRead.items;
  }
  function deliver(kind, slot, attempt) {
    const started = now(), current = config, run = epoch;
    const active = new AbortController(); controller = active;
    const stopped = new Promise(resolve => active.signal.addEventListener('abort', () => resolve(null), { once: true }));
    sending = (async () => {
      const entry = { id: randomUUID(), at: new Date(started).toISOString(), kind, status: 'generated', attention: 0, error: null, stages: [{ status: 'generated', at: new Date(started).toISOString() }] };
      const stage = status => { entry.status = status; entry.stages.push({ status, at: new Date(now()).toISOString() }); };
      try {
        const items = await Promise.race([readSections(), stopped]);
        // Cleared or shutting down before anything went out: there is nothing to record.
        if (active.signal.aborted) return null;
        const digest = buildDigest(items, current, now());
        entry.attention = digest.attention.length;
        if (!record(entry)) throw new HttpError(503, '投递身份无法保存，未发送');
        if (kind === 'schedule' && current.onlyOnAttention && !entry.attention) stage('skipped');
        else {
          const channel = readChannel(), card = renderCard(digest, current).card;
          stage('sending');
          if (!record(entry)) throw new HttpError(503, '投递占用无法保存，未发送');
          await postCard(channel, card, { fetcher, now: now(), signal: active.signal });
          stage('sent');
        }
      } catch (error) {
        stage(error.uncertain ? 'uncertain' : 'failed');
        entry.error = error.message;
        if (kind === 'schedule' && !error.uncertain && attempt < maxAttempts && run === epoch) retry = { slot, attempt: attempt + 1, at: now() + retryMs };
      }
      record(entry);
      return entry;
    })().finally(() => { sending = null; controller = null; });
    return sending;
  }
  function tick() {
    if (closed || sending || !config.enabled || !channelHost) return;
    const slot = latestSlot(config.schedule, minuteNow(), GRACE_MINUTES);
    if (slot !== null && slot > lastSlot) {
      // Claim the slot on disk before consuming it in memory or making an external request.
      // A failed write leaves the same slot eligible for a later tick inside the grace window.
      if (!persistState(slot)) return;
      lastSlot = slot; retry = null;
      void deliver('schedule', slot, 1);
    } else if (retry && now() >= retry.at) {
      const { slot: failed, attempt } = retry; retry = null;
      void deliver('schedule', failed, attempt);
    }
  }
  function state() {
    const minute = minuteNow();
    const next = config.enabled && channelHost ? nextSlot(config.schedule, minute) : null;
    return { schema: 1, config: structuredClone(config), channel: { configured: !!channelHost, host: channelHost, error: channelError }, sending: !!sending,
      nextAt: next === null ? null : new Date(next * 60000).toISOString(), history: structuredClone(history.map(entry => ({ ...entry, reviews: publicDeliveryReviews(reviews[entry.id]) }))), reviewError, loadError: loadError ?? stateError, serverNow: now() };
  }
  return {
    state,
    tick,
    reviewDelivery(input) {
      const note = deliveryReview(input, now());
      if (reviewError) throw new HttpError(503, reviewError);
      if (!history.some(entry => entry.id === input.id)) throw new HttpError(404, '投递记录不存在或已超出保留范围');
      const retained = new Set(history.map(entry => entry.id));
      const next = Object.fromEntries(Object.entries(reviews).filter(([id]) => retained.has(id)));
      next[input.id] = [...(next[input.id] ?? []).slice(-4), note];
      atomicJson(reviewPath, next); reviews = next;
      return state();
    },
    initialize() {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      try { const saved = readBounded(configPath); if (saved) config = validateDigestConfig(saved); }
      catch (error) { loadError = '已保存的汇总配置无法读取，已停用，保存后恢复'; config = structuredClone(DIGEST_DEFAULTS); log.warn({ err: error, type: 'feishu-digest' }, loadError); }
      try { const saved = readBounded(statePath); if (saved) { lastSlot = Number.isSafeInteger(saved.lastSlot) ? saved.lastSlot : minuteNow(); history = Array.isArray(saved.history) ? saved.history.slice(0, HISTORY_LIMIT) : []; } else lastSlot = minuteNow(); }
      catch { lastSlot = minuteNow(); stateError = '发送记录读取失败，历史投递结果未知'; }
      history = history.map((entry, index) => ({ ...entry, id: entry.id ?? createHash('sha256').update(JSON.stringify([entry, index])).digest('hex'),
        ...(entry.status === 'sending' ? { status: 'uncertain', error: '进程重启前正在发送，渠道结果未知；不会重发此投递' } : {}) }));
      try { reviews = readBounded(reviewPath) ?? {}; } catch { reviewError = '人工核对记录读取失败，证据状态未知'; }
      try { const channel = readChannel(); channelHost = hostOf(channel.webhookUrl); }
      catch (error) { if (!(error instanceof HttpError)) { channelError = '已保存的 Webhook 无法读取，请重新填写'; log.warn({ type: 'feishu-digest' }, channelError); } }
      if (tickMs > 0) { timer = setInterval(tick, tickMs); timer.unref?.(); }
    },
    save(value) {
      const next = checked(validateDigestConfig, value);
      if (next.enabled && !channelHost) throw new HttpError(409, '启用前请先保存飞书机器人 Webhook');
      // Saving must not deliver a slot that was already due before this schedule existed.
      const rescheduled = next.enabled && (!config.enabled || JSON.stringify(next.schedule) !== JSON.stringify(config.schedule));
      const nextSlot = rescheduled ? Math.max(lastSlot, minuteNow()) : lastSlot;
      if (rescheduled) {
        if (!persistState(nextSlot)) throw new HttpError(503, '发送状态无法保存，发送计划未更改，请恢复存储后重试');
      }
      try { atomicJson(configPath, next); }
      catch (error) {
        // Nothing was sent between these synchronous writes. Restore the old schedule's
        // claim if its replacement was not saved, so a failed edit cannot consume its slot.
        const restored = !rescheduled || persistState(lastSlot);
        if (!restored) stateError = '发送计划保存失败，原发送状态也未能恢复，请恢复存储后重新保存';
        log.warn({ err: error, type: 'feishu-digest' }, '飞书汇总配置写入失败');
        throw new HttpError(503, restored ? '汇总配置无法保存，发送计划未更改，请恢复存储后重试' : stateError);
      }
      lastSlot = nextSlot;
      if (rescheduled || !next.enabled) invalidate();
      config = next; loadError = null;
      return state();
    },
    setChannel(value) {
      const next = checked(validateChannel, value);
      atomicJson(channelPath, { value: encrypt(next) });
      channelHost = hostOf(next.webhookUrl); channelError = null;
      return state();
    },
    clearChannel() {
      if (config.enabled) { const next = { ...config, enabled: false }; atomicJson(configPath, next); config = next; }
      invalidate(); controller?.abort();
      rmSync(channelPath, { force: true }); channelHost = null; channelError = null;
      return state();
    },
    async preview(value, { fresh = false } = {}) {
      const next = checked(validateDigestConfig, value), items = await previewSections(fresh);
      const digest = buildDigest(items, next, now()), { bytes, omitted } = renderCard(digest, next);
      return { digest, bytes, omitted, catalog: items.map(({ id, name, level, status, metrics }) => ({ id, name, level, status, metrics: metrics.map(({ key, label }) => ({ key, label })) })) };
    },
    /** Other alerts reuse this robot; the digest title carries any keyword the robot requires. */
    alertChannel: () => ({ configured: !!channelHost, title: config.title }),
    async postAlert(card, { signal } = {}) {
      if (closed) throw new Error('飞书发送已停止');
      await postCard(readChannel(), card, { fetcher, now: now(), signal });
    },
    async send() {
      if (sending) throw new HttpError(409, '正在发送，请稍后再试');
      if (!channelHost) throw new HttpError(409, '请先保存飞书机器人 Webhook');
      const result = await deliver('manual', null, maxAttempts);
      return { ...state(), result };
    },
    async close() {
      closed = true; clearInterval(timer); controller?.abort();
      await sending?.catch(() => {});
    },
  };
}
