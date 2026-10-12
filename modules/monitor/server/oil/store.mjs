import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { defaultConfig, validateConfig } from './config.mjs';

export function emptyStore(defaults = defaultConfig, marketSource = 'binance') { return { schemaVersion: 1, marketSource, revision: 0, config: defaults(), states: {}, events: [] }; }

export function activateBinanceSource(data) {
  if (data.marketSource === 'binance') return data;
  return { ...data, marketSource: 'binance', revision: data.revision + 1, states: {}, events: data.events.map(event => ({ ...event, source: event.source ?? 'hyperliquid' })) };
}

export class FileStore {
  constructor(directory, externallyLocked = false, { defaults = defaultConfig, validate = validateConfig, marketSource } = {}) { this.defaults = defaults; this.validate = validate; this.marketSource = marketSource; this.externallyLocked = externallyLocked; this.directory = path.resolve(directory); this.file = path.join(this.directory, 'monitor.json'); this.lock = path.join(this.directory, 'monitor.lock'); }
  async acquire() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (this.externallyLocked) return;
    // The lock is intentionally not auto-stolen: PID namespaces can share a volume.
    try { this.lockHandle = await open(this.lock, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('数据目录已被锁定。确认其他实例已停止后，再移除 monitor.lock 并重启。'); throw error; }
    await this.lockHandle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  }
  async read() {
    let raw;
    try { raw = await readFile(this.file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return emptyStore(this.defaults, this.marketSource); throw error; }
    const data = JSON.parse(raw);
    if (this.marketSource && (data.marketSource ?? (this.marketSource === 'binance' ? 'binance' : undefined)) !== this.marketSource) throw new Error('告警配置交易所不匹配；请恢复对应交易所的 monitor.json');
    if (data.schemaVersion !== 1 || !Number.isSafeInteger(data.revision) || data.revision < 0 || !data.states || typeof data.states !== 'object' || Array.isArray(data.states) || !Array.isArray(data.events)) throw new Error('持久化数据格式无效；请从备份恢复 monitor.json');
    data.config = this.validate(data.config);
    for (const state of Object.values(data.states)) {
      if (!state || typeof state.active !== 'boolean' || typeof state.alerted !== 'boolean' || (state.lastSentAt !== null && (!Number.isFinite(state.lastSentAt) || state.lastSentAt < 0)) || !Number.isFinite(state.nextAttemptAt) || state.nextAttemptAt < 0 || (state.eventId != null && typeof state.eventId !== 'string')) throw new Error('告警状态损坏；请从备份恢复 monitor.json');
    }
    if (data.events.length > 100 || data.events.some(event => !event || !['sending', 'sent', 'failed'].includes(event.status) || !Array.isArray(event.rules))) throw new Error('告警记录损坏；请从备份恢复 monitor.json');
    return data;
  }
  async write(data) {
    const temp = `${this.file}.tmp`;
    const handle = await open(temp, 'w', 0o600);
    try { await handle.writeFile(JSON.stringify(data, null, 2) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, this.file);
    if (process.platform !== 'win32') {
      const directory = await open(this.directory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  }
  async release() {
    if (!this.lockHandle) return;
    await this.lockHandle.close(); this.lockHandle = null;
    await unlink(this.lock);
  }
}
