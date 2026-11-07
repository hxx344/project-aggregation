import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { atomicJson } from '../tools/entropy-lighter-lab/core.mjs';
import { HttpError } from './http-common.mjs';
import { postCard, validateChannel } from './automation/feishu-digest-core.mjs';
import { decimal } from './trading-decimal.mjs';
import { EXECUTION_VENUE_SYMBOLS, TRADING_NAMES } from './trading-markets.mjs';

// Anthropic arbitrage positions and their liquidation watch. Read only: the
// Binance/OKX legs come from the read-only accounts (trading.anthropic()), the
// Hyperliquid legs from the public info endpoint for the master address of the
// live connection, the Lighter RH legs from the public account endpoint for the
// L1 address of the live connection (every account under that address).
// Alerts go through their own Feishu robot when one is saved, otherwise through
// the Feishu digest's robot.
// https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals
// https://apidocs.lighter.xyz/reference/account-1
const HL_INFO = 'https://api.hyperliquid.xyz/info';
const HL_SYMBOLS = EXECUTION_VENUE_SYMBOLS.hyperliquid;
const HL_DEXES = [...new Set(HL_SYMBOLS.map(symbol => symbol.split(':')[0]))];
const RH_ACCOUNT = 'https://api.rh.lighter.xyz/api/v1/account';
const RH_SYMBOLS = EXECUTION_VENUE_SYMBOLS['rh-lighter'];
// Lighter answers an address without any account with HTTP 400 and this code; it has no positions.
const RH_NOT_FOUND = 21100;
const RH_RATE_LIMITED = 23000;
// HTTP 429/405 or code 23000 is the venue firewall's static 60 s block of this IP; no read is sent until it ends.
// These reads are unauthenticated and spend the IP bucket shared with the monitor and asset module, not the
// L1-address bucket of the trading connection, so the trading client keeps its own cooldown.
const RH_COOLDOWN_MS = 60_000;
const MAX_ACCOUNTS = 256;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_ROWS = 2000;
const FILE_LIMIT = 256 * 1024;
const HISTORY_LIMIT = 20;
// Same freshness window as the read-only ledger (POSITION_STALE).
const LIVE_MS = 75_000;
// Monitoring counts as interrupted after this long without a fresh read.
const STALE_ALERT_MS = 180_000;
// An alert clears only once the distance is this many percentage points above the threshold.
const HYSTERESIS = 2;
const FAILURE_RETRY_MS = 60_000;
export const ANTHROPIC_ALERT_DEFAULTS = Object.freeze({ enabled: false, thresholdPercent: 20, repeatMinutes: 30 });
const SOURCES = Object.freeze(['binance', 'okx', 'hyperliquid', 'rh-lighter']);
const WALLETS = Object.freeze(['hyperliquid', 'rh-lighter']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const iso = time => new Date(time).toISOString();
const timeOf = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

export function validateAlertConfig(value) {
  if (!object(value) || Object.keys(value).length !== 3 || !['enabled', 'thresholdPercent', 'repeatMinutes'].every(key => Object.hasOwn(value, key))) throw new Error('预警设置格式不正确');
  const { enabled, thresholdPercent, repeatMinutes } = value;
  if (typeof enabled !== 'boolean') throw new Error('预警开关格式不正确');
  if (typeof thresholdPercent !== 'number' || !Number.isFinite(thresholdPercent) || thresholdPercent < 1 || thresholdPercent > 90) throw new Error('预警距离需要 1% 到 90%');
  if (!Number.isInteger(repeatMinutes) || repeatMinutes < 5 || repeatMinutes > 1440) throw new Error('重复提醒间隔需要 5 到 1440 分钟');
  return { enabled, thresholdPercent: Math.round(thresholdPercent * 100) / 100, repeatMinutes };
}

/** Percent the mark can move against the position before the liquidation price; negative once past it. */
export function liquidationDistance({ side, markPrice, liquidationPrice }) {
  const mark = Number(markPrice), liquidation = Number(liquidationPrice);
  if (markPrice === null || liquidationPrice === null || !(mark > 0) || !(liquidation > 0)) return null;
  return (side === 'long' ? mark - liquidation : liquidation - mark) / mark * 100;
}

/** Display mark derived from positionValue ÷ size, kept to eight significant digits. */
function significant(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  const digits = Math.min(18, Math.max(0, 7 - Math.floor(Math.log10(value))));
  return decimal(value.toFixed(digits).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''));
}

/** Positions of the Anthropic coins in one HIP-3 dex's clearinghouseState. */
export function parseHyperliquidState(state, dex) {
  if (!object(state) || !Array.isArray(state.assetPositions) || state.assetPositions.length > MAX_ROWS) throw new Error('invalid_state');
  const rows = [], seen = new Set();
  for (const entry of state.assetPositions) {
    if (!object(entry) || !object(entry.position) || typeof entry.position.coin !== 'string') throw new Error('invalid_state');
    const { coin } = entry.position;
    if (!HL_SYMBOLS.includes(coin) || !coin.startsWith(`${dex}:`)) continue;
    if (seen.has(coin)) throw new Error('duplicate_position');
    seen.add(coin);
    const p = entry.position, size = decimal(p.szi);
    if (size === '0') continue;
    const side = size.startsWith('-') ? 'short' : 'long', quantity = side === 'short' ? size.slice(1) : size;
    const notional = decimal(p.positionValue, { nonnegative: true });
    const optional = (value, options) => value === null || value === undefined ? null : decimal(value, options);
    const leverage = object(p.leverage) && ['cross', 'isolated'].includes(p.leverage.type) && Number.isSafeInteger(p.leverage.value) && p.leverage.value > 0 ? p.leverage : null;
    const liquidation = optional(p.liquidationPx, { nonnegative: true });
    rows.push({ id: `hyperliquid:${coin}:${side}`, exchange: 'hyperliquid', symbol: coin, side, quantity, quantityUnit: null,
      entryPrice: optional(p.entryPx, { nonnegative: true }), markPrice: significant(Number(notional) / Number(quantity)), notional,
      unrealizedPnl: optional(p.unrealizedPnl), leverage: leverage ? String(leverage.value) : null, marginMode: leverage?.type ?? null,
      marginUsed: optional(p.marginUsed, { nonnegative: true }), liquidationPrice: liquidation === '0' ? null : liquidation });
  }
  return rows;
}

/** Positions of the Anthropic markets in every account the Lighter RH `account?by=l1_address` answer lists. */
export function parseRhLighterAccounts(body) {
  if (!object(body) || !Array.isArray(body.accounts) || body.accounts.length > MAX_ACCOUNTS) throw new Error('invalid_state');
  const rows = [], seen = new Set();
  for (const account of body.accounts) {
    if (!object(account) || !Number.isSafeInteger(account.index) || account.index < 0 || !Array.isArray(account.positions) || account.positions.length > MAX_ROWS) throw new Error('invalid_state');
    for (const p of account.positions) {
      if (!object(p) || typeof p.symbol !== 'string') throw new Error('invalid_state');
      if (!RH_SYMBOLS.includes(p.symbol)) continue;
      const key = `${account.index}:${p.symbol}`;
      if (seen.has(key)) throw new Error('duplicate_position');
      seen.add(key);
      const quantity = decimal(p.position, { nonnegative: true });
      if (quantity === '0') continue;
      if (p.sign !== 1 && p.sign !== -1) throw new Error('invalid_state');
      if (![0, 1].includes(p.margin_mode)) throw new Error('invalid_state');
      const side = p.sign === 1 ? 'long' : 'short';
      const notional = decimal(p.position_value, { nonnegative: true });
      const fraction = Number(decimal(p.initial_margin_fraction, { nonnegative: true }));
      // The usable leverage rounds down, as in the trading adapter.
      const leverage = fraction > 0 ? Math.floor(100 / fraction + 1e-9) : null;
      // The liquidation price is computed, not a tick-sized value: digits past 18 decimals are dropped, never rounded up.
      const liquidation = decimal(typeof p.liquidation_price === 'string' ? p.liquidation_price.replace(/^(\d+\.\d{18})\d+$/, '$1') : p.liquidation_price, { nonnegative: true });
      const isolated = p.margin_mode === 1;
      rows.push({ id: `rh-lighter:${p.symbol}:${account.index}:${side}`, exchange: 'rh-lighter', symbol: p.symbol, account: account.index, side, quantity, quantityUnit: null,
        entryPrice: decimal(p.avg_entry_price, { nonnegative: true }), markPrice: significant(Number(notional) / Number(quantity)), notional,
        unrealizedPnl: decimal(p.unrealized_pnl), leverage: Number.isSafeInteger(leverage) && leverage >= 1 ? String(leverage) : null, marginMode: isolated ? 'isolated' : 'cross',
        marginUsed: isolated ? decimal(p.allocated_margin, { nonnegative: true }) : null, liquidationPrice: liquidation === '0' ? null : liquidation });
    }
  }
  return rows;
}

// Reads at most MAX_BODY_BYTES of the body as it streams; the fetch signal also aborts the read.
async function readLimited(response, name) {
  const length = response.headers?.get?.('content-length');
  if (length && Number(length) > MAX_BODY_BYTES) throw new Error(`${name} 响应过大`);
  if (!response.body?.getReader) throw new Error(`${name} 仓位数据无法识别`);
  const reader = response.body.getReader(), chunks = [];
  let size = 0, done = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) { done = true; break; }
      size += chunk.value.byteLength;
      if (size > MAX_BODY_BYTES) throw new Error(`${name} 响应过大`);
      chunks.push(Buffer.from(chunk.value));
    }
    return Buffer.concat(chunks, size).toString('utf8');
  } finally {
    if (!done) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function readBounded(file) {
  if (!existsSync(file)) return null;
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > FILE_LIMIT) throw new Error('invalid_anthropic_watch_file');
  return JSON.parse(readFileSync(file, 'utf8'));
}

const fmt = value => value === null ? '—' : String(value);
const sideName = side => side === 'long' ? '做多' : '做空';
const legName = row => `${TRADING_NAMES[row.exchange]} ${row.symbol}${row.account === undefined ? '' : ` 账户 ${row.account}`} ${sideName(row.side)}`;
function eventLine(event, threshold) {
  if (event.type === 'alert' || event.type === 'repeat') {
    const row = event.row;
    return `🔴 ${legName(row)}：${event.type === 'repeat' ? '仍' : ''}距强平 ${event.distance.toFixed(2)}%（阈值 ${threshold}%）\n　　标记价 ${fmt(row.markPrice)} · 强平价 ${fmt(row.liquidationPrice)} · 数量 ${row.quantity}${row.quantityUnit ? ` ${row.quantityUnit}` : ''}${row.leverage ? ` · ${row.leverage}×` : ''}${row.marginMode ? ` ${row.marginMode === 'isolated' ? '逐仓' : '全仓'}` : ''}`;
  }
  if (event.type === 'recover') return event.distance === null ? `🟢 ${legName(event.row)}：交易所不再提供强平价（通常是保证金已充足），解除预警`
    : `🟢 ${legName(event.row)}：距强平已回到 ${event.distance.toFixed(2)}%，解除预警`;
  if (event.type === 'gone') return `⚠️ ${event.label}：仓位已不在账户中（可能已平仓或被强平），请到交易所核对`;
  if (event.type === 'stale') return `⚠️ ${TRADING_NAMES[event.source]}：仓位读取已中断${event.minutes ? ` ${event.minutes} 分钟` : ''}，暂时无法监控强平距离`;
  return `🟢 ${TRADING_NAMES[event.source]}：仓位读取已恢复`;
}
export function alertCard(events, { title, threshold, at, test = false }) {
  const danger = test || events.some(event => ['alert', 'repeat', 'gone', 'stale'].includes(event.type));
  const clock = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(at));
  const lines = test ? ['这是一条测试消息：Anthropic 强平预警会通过这个机器人发送。', ...events.map(line => `· ${line}`)] : events.map(event => eventLine(event, threshold));
  return { config: { wide_screen_mode: true },
    header: { template: danger ? 'red' : 'green', title: { tag: 'plain_text', content: `${title} · Anthropic 强平预警${test ? '（测试）' : ''} ${clock}` } },
    elements: [{ tag: 'div', text: { tag: 'plain_text', content: lines.join('\n') } }, { tag: 'hr' },
      { tag: 'note', elements: [{ tag: 'plain_text', content: `距强平 = 标记价到强平价的距离 ÷ 标记价；阈值 ${threshold}%。数据来自工作台最新读取，时间为北京时间。` }] }] };
}

export function createAnthropicWatch({ dataDir, readCex, readAddress, feishu, encrypt, decrypt, log = console, fetcher = fetch, now = Date.now, intervalMs = 30_000, timeoutMs = 10_000 } = {}) {
  const directory = path.join(dataDir, 'anthropic-watch');
  const configPath = path.join(directory, 'config.json'), statePath = path.join(directory, 'state.json'), channelPath = path.join(directory, 'channel.json');
  // The own robot's webhook is a credential like the digest's: encrypted at rest, decrypted only to send, never returned.
  // A saved but unreadable robot blocks sending instead of falling back to the digest's group.
  let ownHost = null, ownError = null;
  function robot() {
    if (ownHost || ownError) return { configured: !!ownHost, source: 'own', title: '工作台', host: ownHost, error: ownError };
    const digest = feishu.alertChannel();
    return { configured: digest.configured, source: digest.configured ? 'digest' : null, title: digest.title, host: null, error: null };
  }
  // Throws when the file is missing or unreadable; the caller treats that as a definite refusal (nothing was sent).
  function readOwn() {
    if (!existsSync(channelPath)) throw new Error('预警机器人已被清除');
    const saved = readBounded(channelPath);
    if (!object(saved)) throw new Error('invalid_anthropic_watch_channel');
    return validateChannel(decrypt(saved.value));
  }
  async function post(card) {
    if (closed) throw new Error('飞书发送已停止');
    if (!ownHost && !ownError) return feishu.postAlert(card, { signal: controller.signal });
    let channel;
    try { channel = readOwn(); } catch { throw new Error('预警机器人无法读取，消息未发出，请重新填写'); }
    await postCard(channel, card, { fetcher, now: now(), signal: controller.signal });
  }
  const NO_ROBOT = '请先保存预警机器人，或在「系统 → 飞书汇总」配置机器人';
  let config = { ...ANTHROPIC_ALERT_DEFAULTS }, loadError = null, stateError = null;
  // active: leg id → { sentAt, label }; stale: source → sentAt. Both are claimed on disk before a send.
  let alerts = { active: {}, stale: {} }, history = [], failedAt = 0, lastError = null;
  const emptyWallet = address => ({ address, rows: [], fetchedAt: null, lastAttemptAt: null, error: null });
  const wallets = Object.fromEntries(WALLETS.map(exchange => [exchange, emptyWallet(null)]));
  let timer = null, first = null, closed = false, polling = null, sending = null, testing = false;
  // notLiveSince: source → first time this process saw it without a fresh read; startedAt bounds it.
  let startedAt = now();
  const notLiveSince = {};
  let rhCooldownUntil = 0;
  const controller = new AbortController();

  function persist(next = alerts) {
    try { atomicJson(statePath, { alerts: next, history }); stateError = null; return true; }
    catch (error) { stateError = '预警状态无法保存，预警暂停发送，存储恢复后继续'; log.warn({ err: error, type: 'anthropic-watch' }, stateError); return false; }
  }

  async function readDex(address, dex, signal) {
    const name = TRADING_NAMES.hyperliquid;
    const response = await fetcher(HL_INFO, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'clearinghouseState', user: address, dex }),
      redirect: 'error', cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) });
    if (response.status === 429) throw new Error(`${name} 请求过于频繁，稍后自动重试`);
    if (!response.ok) throw new Error(`${name} 返回 HTTP ${response.status}`);
    const text = await readLimited(response, name);
    try { return parseHyperliquidState(JSON.parse(text), dex); } catch { throw new Error(`${name} 仓位数据无法识别`); }
  }
  async function readRhLighter(address, signal) {
    const name = TRADING_NAMES['rh-lighter'], limited = () => { rhCooldownUntil = now() + RH_COOLDOWN_MS; return new Error(`${name} 请求过于频繁，稍后自动重试`); };
    if (now() < rhCooldownUntil) throw new Error(`${name} 请求过于频繁，稍后自动重试`);
    const url = `${RH_ACCOUNT}?${new URLSearchParams({ by: 'l1_address', value: address })}`;
    const response = await fetcher(url, { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error', cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) });
    if (response.status === 429 || response.status === 405) { void response.body?.cancel().catch(() => {}); throw limited(); }
    if (!response.ok && response.status !== 400) throw new Error(`${name} 返回 HTTP ${response.status}`);
    const text = await readLimited(response, name);
    let body;
    try { body = JSON.parse(text); } catch { throw new Error(`${name} 仓位数据无法识别`); }
    if (response.status === 400) {
      if (object(body) && body.code === RH_NOT_FOUND) return [];
      if (object(body) && body.code === RH_RATE_LIMITED) throw limited();
      throw new Error(`${name} 返回 HTTP 400`);
    }
    if (object(body) && body.code === RH_RATE_LIMITED) throw limited();
    try { return parseRhLighterAccounts(body); } catch { throw new Error(`${name} 仓位数据无法识别`); }
  }
  const READERS = { hyperliquid: async (address, signal) => (await Promise.all(HL_DEXES.map(dex => readDex(address, dex, signal)))).flat(), 'rh-lighter': readRhLighter };
  async function readWallet(exchange) {
    const name = TRADING_NAMES[exchange];
    let address = null;
    try { address = readAddress(exchange); } catch { address = null; }
    if (typeof address !== 'string' || !/^0x[0-9a-f]{40}$/.test(address)) address = null;
    if (address !== wallets[exchange].address) {
      // Another account's legs never vanish from this one: a changed or removed connection drops their alerts.
      if (wallets[exchange].address) {
        const active = Object.fromEntries(Object.entries(alerts.active).filter(([id]) => !id.startsWith(`${exchange}:`)));
        const { [exchange]: staleSince, ...stale } = alerts.stale;
        // Memory drops them even if the disk write fails, since the old address is not read again.
        if (Object.keys(active).length !== Object.keys(alerts.active).length || staleSince !== undefined) { alerts = { active, stale }; persist(); }
      }
      delete notLiveSince[exchange];
      wallets[exchange] = emptyWallet(address);
    }
    if (!address) return;
    wallets[exchange].lastAttemptAt = iso(now());
    try {
      const rows = await READERS[exchange](address, controller.signal);
      if (wallets[exchange].address === address) wallets[exchange] = { ...wallets[exchange], rows, fetchedAt: iso(now()), error: null };
    } catch (error) {
      if (closed || wallets[exchange].address !== address) return;
      wallets[exchange].error = error?.name === 'TimeoutError' ? `${name} 读取超时，保留上次仓位` : error instanceof Error && error.message.startsWith(`${name} `) ? error.message : `${name} 读取失败，保留上次仓位`;
    }
  }

  function sources() {
    const current = now();
    let cex = [];
    try { cex = readCex(); } catch (error) { log.warn({ err: error, type: 'anthropic-watch' }, 'Anthropic 只读仓位读取失败'); }
    const walletState = w => !w.address ? 'unconfigured' : !w.fetchedAt ? w.error ? 'error' : 'loading' : w.error || current - timeOf(w.fetchedAt) > LIVE_MS ? 'stale' : 'live';
    const list = [...cex.map(item => ({ exchange: item.exchange, connected: item.connected,
      state: item.state === 'live' && item.positions.some(row => Object.hasOwn(row, 'riskFetchedAt') && (timeOf(row.riskFetchedAt) === null || current - timeOf(row.riskFetchedAt) > LIVE_MS)) ? 'stale' : item.state,
      fetchedAt: item.fetchedAt, error: item.error, refreshing: !!item.refreshing,
      positions: item.positions.map(row => ({ ...row, quantityUnit: row.quantityUnit ?? null, marginMode: row.marginMode ?? null, marginUsed: null })) })),
    ...WALLETS.map(exchange => { const w = wallets[exchange];
      return { exchange, connected: !!w.address, address: w.address, state: walletState(w), fetchedAt: w.fetchedAt, error: w.error, refreshing: !!polling, positions: w.rows }; })];
    return SOURCES.map(exchange => list.find(item => item.exchange === exchange)).filter(Boolean);
  }

  function evaluate(list) {
    const threshold = config.thresholdPercent, repeatMs = config.repeatMinutes * 60_000, current = now();
    const events = [], next = { active: { ...alerts.active }, stale: { ...alerts.stale } };
    for (const source of list) {
      const ids = new Set(source.positions.map(row => row.id));
      const watched = source.positions.length > 0 || Object.keys(next.active).some(id => id.startsWith(`${source.exchange}:`));
      if (source.state === 'live') delete notLiveSince[source.exchange];
      else notLiveSince[source.exchange] ??= current;
      if (source.state === 'live') {
        if (next.stale[source.exchange]) { events.push({ type: 'stale-recover', source: source.exchange }); delete next.stale[source.exchange]; }
        for (const row of source.positions) {
          const distance = liquidationDistance(row), active = next.active[row.id];
          if (distance === null) {
            if (active) { events.push({ type: 'recover', row, distance: null }); delete next.active[row.id]; }
            continue;
          }
          if (distance <= threshold) {
            if (!active || current - active.sentAt >= repeatMs) { events.push({ type: active ? 'repeat' : 'alert', row, distance }); next.active[row.id] = { sentAt: current, label: legName(row) }; }
          } else if (active && distance > threshold + HYSTERESIS) { events.push({ type: 'recover', row, distance }); delete next.active[row.id]; }
        }
        for (const [id, active] of Object.entries(next.active)) {
          if (id.startsWith(`${source.exchange}:`) && !ids.has(id)) { events.push({ type: 'gone', label: active.label }); delete next.active[id]; }
        }
      } else if (watched && !next.stale[source.exchange]) {
        // Counted from the last fresh read, but never from before this process saw the source; a source
        // still loading or failing its first read waits the same window, so a restart or reconnect is quiet.
        const read = timeOf(source.fetchedAt), since = Math.max(read ?? notLiveSince[source.exchange], startedAt);
        if (current - since >= STALE_ALERT_MS) {
          events.push({ type: 'stale', source: source.exchange, minutes: read === null ? null : Math.floor((current - read) / 60_000) });
          next.stale[source.exchange] = current;
        }
      }
    }
    return { events, next };
  }

  async function deliver(events, next) {
    const channel = robot();
    const previous = alerts;
    // Claim before sending (L090): a failed claim sends nothing and keeps the events eligible.
    if (!persist(next)) return;
    alerts = next;
    const entry = { at: iso(now()), status: 'sent', count: events.length, summary: events.map(event => eventLine(event, config.thresholdPercent).split('\n')[0]).slice(0, 6), error: null };
    try { await post(alertCard(events, { title: channel.title, threshold: config.thresholdPercent, at: now() })); failedAt = 0; lastError = null; }
    catch (error) {
      entry.status = error?.uncertain ? 'uncertain' : 'failed'; entry.error = String(error?.message || '飞书发送失败').slice(0, 200); lastError = entry.error;
      // A definite refusal releases the claim so the next check sends again; an uncertain one may have arrived.
      // Switching off or changing account replaces the alerts object; their result is never rolled back.
      if (!error?.uncertain && !closed) { failedAt = now(); if (alerts === next) alerts = previous; }
      log.warn({ status: entry.status, error: entry.error, type: 'anthropic-watch' }, 'Anthropic 强平预警发送失败');
    }
    history = [entry, ...history].slice(0, HISTORY_LIMIT);
    persist();
  }

  async function poll() {
    if (closed || polling) return polling;
    polling = (async () => {
      await Promise.all(WALLETS.map(readWallet));
      if (closed || sending || !config.enabled || loadError) return;
      const channel = robot();
      if (!channel.configured || failedAt && now() - failedAt < FAILURE_RETRY_MS) return;
      const { events, next } = evaluate(sources());
      if (!events.length) return;
      sending = deliver(events, next).finally(() => { sending = null; });
      await sending;
    })().catch(error => log.warn({ err: error, type: 'anthropic-watch' }, 'Anthropic 仓位检查失败')).finally(() => { polling = null; });
    return polling;
  }

  function state() {
    const list = sources(), channel = robot();
    return { schema: 1, generatedAt: iso(now()), sources: list.map(source => ({ ...source, positions: source.positions.map(row => {
      const distance = liquidationDistance(row);
      return { ...row, distancePercent: distance === null ? null : distance.toFixed(2), alerting: Object.hasOwn(alerts.active, row.id) };
    }) })), alerts: { config: { ...config }, channel: { configured: channel.configured, source: channel.source, host: channel.host, error: channel.error }, history: structuredClone(history), error: loadError ?? stateError ?? lastError,
      staleAfterSeconds: STALE_ALERT_MS / 1000, hysteresisPercent: HYSTERESIS } };
  }

  return {
    state,
    poll,
    initialize() {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      startedAt = now();
      try { const saved = readBounded(configPath); if (saved) config = validateAlertConfig(saved); }
      catch (error) { loadError = '已保存的预警设置无法读取，预警已停用，重新保存后恢复'; config = { ...ANTHROPIC_ALERT_DEFAULTS }; log.warn({ err: error, type: 'anthropic-watch' }, loadError); }
      try {
        const saved = readBounded(statePath);
        if (saved && object(saved.alerts) && object(saved.alerts.active) && object(saved.alerts.stale)) alerts = { active: saved.alerts.active, stale: saved.alerts.stale };
        if (saved && Array.isArray(saved.history)) history = saved.history.slice(0, HISTORY_LIMIT);
      } catch (error) { log.warn({ err: error, type: 'anthropic-watch' }, 'Anthropic 预警状态无法读取，从空状态开始'); }
      try { if (existsSync(channelPath)) ownHost = new URL(readOwn().webhookUrl).hostname; }
      catch { ownHost = null; ownError = '已保存的预警机器人无法读取，请重新填写'; log.warn({ type: 'anthropic-watch' }, ownError); }
      if (intervalMs > 0) {
        timer = setInterval(() => void poll(), intervalMs); timer.unref?.();
        first = setTimeout(() => void poll(), 1000); first.unref?.();
      }
    },
    save(value) {
      let next;
      try { next = validateAlertConfig(value); } catch (error) { throw new HttpError(400, error.message); }
      if (next.enabled && !robot().configured) throw new HttpError(409, robot().error ?? `启用前${NO_ROBOT}`);
      try { atomicJson(configPath, next); }
      catch (error) { log.warn({ err: error, type: 'anthropic-watch' }, 'Anthropic 预警设置写入失败'); throw new HttpError(503, '预警设置无法保存，请恢复存储后重试'); }
      // Switching off forgets open alerts, so switching on again reports the current situation afresh.
      if (!next.enabled) { alerts = { active: {}, stale: {} }; persist(); }
      config = next; loadError = null; failedAt = 0; lastError = null;
      return state();
    },
    setChannel(value) {
      let next;
      try { next = validateChannel(value); } catch (error) { throw new HttpError(400, error.message); }
      try { atomicJson(channelPath, { value: encrypt(next) }); }
      catch (error) { log.warn({ err: error, type: 'anthropic-watch' }, 'Anthropic 预警机器人写入失败'); throw new HttpError(503, '预警机器人无法保存，请恢复存储后重试'); }
      ownHost = new URL(next.webhookUrl).hostname; ownError = null; failedAt = 0; lastError = null;
      return state();
    },
    clearChannel() {
      // Without the digest's robot there is nowhere left to send: switch off durably before removing the robot,
      // so a failed write never leaves alerts on disk enabled while the page shows them off.
      if (config.enabled && !feishu.alertChannel().configured) {
        const next = { ...config, enabled: false };
        try { atomicJson(configPath, next); }
        catch (error) { log.warn({ err: error, type: 'anthropic-watch' }, 'Anthropic 预警设置写入失败'); throw new HttpError(503, '预警设置无法保存，机器人未清除，请恢复存储后重试'); }
        config = next; alerts = { active: {}, stale: {} }; persist();
      }
      try { rmSync(channelPath, { force: true }); }
      catch (error) { log.warn({ err: error, type: 'anthropic-watch' }, 'Anthropic 预警机器人删除失败'); throw new HttpError(503, '预警机器人无法清除，请恢复存储后重试'); }
      ownHost = null; ownError = null; failedAt = 0; lastError = null;
      return state();
    },
    async test() {
      const channel = robot();
      if (!channel.configured) throw new HttpError(409, channel.error ?? NO_ROBOT);
      if (testing) throw new HttpError(409, '测试消息正在发送，请稍候');
      const lines = sources().flatMap(source => source.positions.map(row => {
        const distance = liquidationDistance(row);
        return `${legName(row)}：距强平 ${distance === null ? '未提供强平价' : `${distance.toFixed(2)}%`}`;
      }));
      testing = true;
      try { await post(alertCard(lines.length ? lines : ['当前没有读取到 Anthropic 仓位。'], { title: channel.title, threshold: config.thresholdPercent, at: now(), test: true })); }
      catch (error) { throw new HttpError(error?.uncertain ? 504 : 502, String(error?.message || '飞书发送失败')); }
      finally { testing = false; }
      return state();
    },
    async close() {
      closed = true; clearInterval(timer); clearTimeout(first); controller.abort();
      await polling?.catch(() => {});
    },
  };
}
