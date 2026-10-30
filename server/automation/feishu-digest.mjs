import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { atomicJson } from '../../tools/entropy-lighter-lab/core.mjs';
import { HttpError } from '../http-common.mjs';
import { DIGEST_DEFAULTS, buildDigest, latestSlot, nextSlot, postCard, renderCard, validateChannel, validateDigestConfig } from './feishu-digest-core.mjs';

const FILE_LIMIT = 256 * 1024;
const HISTORY_LIMIT = 20;
// A restart inside this window still delivers the slot it missed.
const GRACE_MINUTES = 15;

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
  let config = structuredClone(DIGEST_DEFAULTS), loadError = null, channelHost = null, channelError = null;
  let lastSlot = 0, history = [], retry = null, sending = null, controller = null, timer = null, closed = false;
  const minuteNow = () => Math.floor(now() / 60000);
  const hostOf = url => new URL(url).hostname;

  function persistState() {
    try { atomicJson(statePath, { lastSlot, history }); }
    catch (error) { log.warn({ err: error, type: 'feishu-digest' }, '飞书汇总状态写入失败'); }
  }
  function record(entry) {
    history = [entry, ...history].slice(0, HISTORY_LIMIT); persistState();
    if (entry.status === 'failed' || entry.status === 'uncertain') log.warn({ status: entry.status, kind: entry.kind, error: entry.error, type: 'feishu-digest' }, '飞书汇总发送失败');
  }
  function readChannel() {
    const saved = readBounded(channelPath);
    if (!saved) throw new HttpError(409, '请先保存飞书机器人 Webhook');
    return decrypt(saved.value);
  }
  function deliver(kind, slot, attempt) {
    const started = now(), current = config;
    const active = new AbortController(); controller = active;
    sending = (async () => {
      const entry = { at: new Date(started).toISOString(), kind, status: 'sent', attention: 0, error: null };
      try {
        const digest = buildDigest(await readSections(), current, now());
        entry.attention = digest.attention.length;
        if (kind === 'schedule' && current.onlyOnAttention && !entry.attention) entry.status = 'skipped';
        else await postCard(readChannel(), renderCard(digest, current).card, { fetcher, now: now(), signal: active.signal });
      } catch (error) {
        entry.status = error.uncertain ? 'uncertain' : 'failed';
        entry.error = error.message;
        if (kind === 'schedule' && !error.uncertain && attempt < maxAttempts) retry = { slot, attempt: attempt + 1, at: now() + retryMs };
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
      lastSlot = slot; retry = null; persistState();
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
      nextAt: next === null ? null : new Date(next * 60000).toISOString(), history: structuredClone(history), loadError, serverNow: now() };
  }
  return {
    state,
    tick,
    initialize() {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      try { const saved = readBounded(configPath); if (saved) config = validateDigestConfig(saved); }
      catch (error) { loadError = '已保存的汇总配置无法读取，已停用，保存后恢复'; config = structuredClone(DIGEST_DEFAULTS); log.warn({ err: error, type: 'feishu-digest' }, loadError); }
      try { const saved = readBounded(statePath); if (saved) { lastSlot = Number.isSafeInteger(saved.lastSlot) ? saved.lastSlot : minuteNow(); history = Array.isArray(saved.history) ? saved.history.slice(0, HISTORY_LIMIT) : []; } else lastSlot = minuteNow(); }
      catch { lastSlot = minuteNow(); }
      try { const channel = readChannel(); channelHost = hostOf(channel.webhookUrl); }
      catch (error) { if (!(error instanceof HttpError)) { channelError = '已保存的 Webhook 无法读取，请重新填写'; log.warn({ type: 'feishu-digest' }, channelError); } }
      if (tickMs > 0) { timer = setInterval(tick, tickMs); timer.unref?.(); }
    },
    save(value) {
      const next = checked(validateDigestConfig, value);
      if (next.enabled && !channelHost) throw new HttpError(409, '启用前请先保存飞书机器人 Webhook');
      // Saving must not deliver a slot that was already due before this schedule existed.
      if (next.enabled && (!config.enabled || JSON.stringify(next.schedule) !== JSON.stringify(config.schedule))) { lastSlot = Math.max(lastSlot, minuteNow()); persistState(); }
      if (!next.enabled) retry = null;
      atomicJson(configPath, next);
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
      retry = null; rmSync(channelPath, { force: true }); channelHost = null; channelError = null;
      return state();
    },
    async preview(value) {
      const next = checked(validateDigestConfig, value), items = await readSections();
      const digest = buildDigest(items, next, now()), { bytes, omitted } = renderCard(digest, next);
      return { digest, bytes, omitted, catalog: items.map(({ id, name, level, status, metrics }) => ({ id, name, level, status, metrics: metrics.map(({ key, label }) => ({ key, label })) })) };
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
