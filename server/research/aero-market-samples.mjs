// Aero 市场小时样本库：每条链每轮扫描后，把有 gauge 的池子当前读数按整点写入 SQLite，保留 30 天，
// 供页面按所选宽度与投入逐点重算净年化再取平均。只是可重建的研究缓存：打开或写入失败只停用平均值，不影响扫描。
import { DatabaseSync } from 'node:sqlite';

const HOUR = 3600;
export const SAMPLE_RETENTION_SEC = 30 * 86400;
export const SAMPLE_WINDOWS = Object.freeze({ '24h': 86400, '3d': 3 * 86400, '7d': 7 * 86400, '30d': 30 * 86400 });
// 每个池子最多返回这么多个样本：窗口越长抽样越稀，接口体积与窗口长度无关（约 400 个池子 × 24 点）。
export const MAX_SAMPLES_PER_POOL = 24;
const SCHEMA_VERSION = 1;

// 4–6 位有效数字足够算平均，同时让响应体积减半。
const round = (v, digits) => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toPrecision(digits)));

// 在一个池子窗口内实际有样本的整点里，从最新到最旧均匀取至多 MAX_SAMPLES_PER_POOL 个（含首尾）：
// 服务刚上线或停过、池子新建或时有时无、各链扫描间隔不同时都按该池自己的整点用满点数。
export function pickSlots(slotsDesc) {
  const n = slotsDesc.length;
  if (n <= MAX_SAMPLES_PER_POOL) return slotsDesc;
  return Array.from({ length: MAX_SAMPLES_PER_POOL }, (_, i) => slotsDesc[Math.round((i * (n - 1)) / (MAX_SAMPLES_PER_POOL - 1))]);
}

export function openMarketSamples({ file, log = console, now = Date.now }) {
  let db = null, error = null, version = 0, prunedAt = 0;
  const cache = new Map();
  const poolIds = new Map();
  const statements = {};
  try {
    db = new DatabaseSync(file);
    db.exec('PRAGMA busy_timeout=1000');
    // 先认版本再切 WAL：不认识的库原样保留，不留下 -wal/-shm。
    const current = db.prepare('PRAGMA user_version').get().user_version;
    if (current !== 0 && current !== SCHEMA_VERSION) throw new Error(`样本库版本 ${current} 不受支持`);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL');
    if (current === 0) {
      // 池地址只存一次，样本按 (整点, 池) 聚簇：窗口读取与过期清理都是主键范围操作；(池, 整点) 索引给出每池的整点列表。
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS pools (id INTEGER PRIMARY KEY, chain TEXT NOT NULL, address TEXT NOT NULL, UNIQUE (chain, address));
        CREATE TABLE IF NOT EXISTS samples (
          slot INTEGER NOT NULL, pool INTEGER NOT NULL, tick INTEGER NOT NULL, staked REAL NOT NULL,
          usd0 REAL, usd1 REAL, emission REAL, aero_usd REAL, vol24h REAL, vol7d REAL, fee INTEGER,
          PRIMARY KEY (slot, pool)) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS samples_pool ON samples (pool, slot);
        PRAGMA user_version=${SCHEMA_VERSION};
        COMMIT;`);
    }
    statements.addPool = db.prepare('INSERT INTO pools (chain, address) VALUES (?, ?) ON CONFLICT (chain, address) DO NOTHING');
    statements.poolId = db.prepare('SELECT id FROM pools WHERE chain = ? AND address = ?');
    // 同一整点只留一条；先写入的若缺排放或 AERO 价（重启后首轮、Base 尚未扫完）则由同一整点的后续读数补上。
    statements.upsert = db.prepare(`INSERT INTO samples (slot, pool, tick, staked, usd0, usd1, emission, aero_usd, vol24h, vol7d, fee)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (slot, pool) DO UPDATE SET tick = excluded.tick, staked = excluded.staked, usd0 = excluded.usd0, usd1 = excluded.usd1,
        emission = excluded.emission, aero_usd = excluded.aero_usd, vol24h = excluded.vol24h, vol7d = excluded.vol7d, fee = excluded.fee
      WHERE (samples.emission IS NULL OR samples.aero_usd IS NULL) AND excluded.emission IS NOT NULL AND excluded.aero_usd IS NOT NULL`);
    statements.prune = db.prepare('DELETE FROM samples WHERE slot < ?');
    // 读取分两步：先按 (池, 整点) 索引取每池窗口内的整点列表（在 SQLite 里拼成一个字符串，每池一行），
    // 再只取挑中的 (整点, 池) 行。30 天约 30 万行的库一次约 120 毫秒，不再把全部原始行逐行转成 JS 对象（同步读会卡住同进程的其它模块上秒）。
    // 用有序子查询而非 group_concat(… ORDER BY)：后者每池建一棵临时 B 树，慢 3 倍；顺序在 JS 里再核一遍。
    statements.slots = db.prepare(`SELECT p.id, p.chain, p.address,
        (SELECT group_concat(slot) FROM (SELECT slot FROM samples s WHERE s.pool = p.id AND s.slot >= ? ORDER BY slot DESC)) AS slots FROM pools p`);
    statements.read = db.prepare(`SELECT s.pool, s.slot, s.tick, s.staked, s.usd0, s.usd1, s.emission, s.aero_usd, s.vol24h, s.vol7d, s.fee
      FROM json_each(?) j JOIN samples s ON s.slot = j.value ->> 0 AND s.pool = j.value ->> 1 ORDER BY s.pool, s.slot`);
    statements.ticks = db.prepare(`SELECT s.slot, s.tick FROM pools p JOIN samples s ON s.pool = p.id
      WHERE p.chain = ? AND p.address = ? AND s.slot >= ? AND s.slot < ? ORDER BY s.slot`);
  } catch (reason) {
    error = String(reason?.message || reason).slice(0, 240);
    log.warn?.({ type: 'aero-market', err: error }, 'Aero 样本库无法打开，平均净年化停用');
    try { db?.close(); } catch { /* 已失败，保留原始错误 */ }
    db = null;
  }

  function idOf(chainId, address) {
    const k = `${chainId}:${address}`;
    let id = poolIds.get(k);
    if (id === undefined) {
      statements.addPool.run(chainId, address);
      id = Number(statements.poolId.get(chainId, address).id);
      poolIds.set(k, id);
    }
    return id;
  }

  function record(chainId, nowSec, rows, aeroUsd) {
    if (!db) return;
    const slot = Math.floor(nowSec / HOUR) * HOUR;
    const usable = rows.filter((r) => r.gauge && Number.isFinite(Number(r.stakedLiquidity)));
    if (!usable.length) return;
    try {
      db.exec('BEGIN IMMEDIATE');
      let changes = 0;
      try {
        for (const r of usable) {
          changes += Number(statements.upsert.run(slot, idOf(chainId, r.address), r.tick, Number(r.stakedLiquidity), r.token0.usd, r.token1.usd,
            r.emissionPerSec, aeroUsd ?? null, r.vol24h?.daily ?? null, r.vol7d?.daily ?? null, r.fee ?? null).changes);
        }
        if (nowSec - prunedAt >= HOUR) { changes += Number(statements.prune.run(nowSec - SAMPLE_RETENTION_SEC - HOUR).changes); prunedAt = nowSec; }
        db.exec('COMMIT');
      } catch (reason) {
        // 回滚会撤销本轮新登记的池 id，内存映射一并作废；磁盘满等错误时 SQLite 可能已自行回滚，回滚失败不能盖掉原始错误。
        poolIds.clear();
        try { if (db.isTransaction) db.exec('ROLLBACK'); } catch { /* 保留原始错误 */ }
        throw reason;
      }
      if (changes) { version += 1; cache.clear(); }
      error = null;
    } catch (reason) {
      // 写入失败（多为磁盘或锁）只丢这一轮样本，下一轮再试。
      error = String(reason?.message || reason).slice(0, 240);
      log.warn?.({ type: 'aero-market', chain: chainId, err: error }, 'Aero 样本写入失败');
    }
  }

  // 返回窗口内有排放的池子按时间抽样的读数：[整点秒, tick, 质押流动性, token0 美元价, token1 美元价, 排放美元/秒, 24h 日波动, 7d 日波动, 费率]。
  // hours 为该池窗口内实际的整点样本数，用于判断覆盖是否足够。
  function read(windowKey) {
    const windowSec = SAMPLE_WINDOWS[windowKey];
    if (!windowSec) throw new Error('unknown_window');
    if (!db) return { window: windowKey, available: false, error, version, pools: {} };
    // 缓存按窗口与当前整点：有新样本时清空；扫描停了也会在整点后按新窗口重读。
    const nowSec = Math.floor(now() / 1000), from = Math.floor(nowSec / HOUR) * HOUR - windowSec + HOUR, cacheKey = `${windowKey}:${from}`;
    const hit = cache.get(cacheKey);
    if (hit) return hit;
    let rows;
    const known = new Map(), picked = [];
    try {
      for (const r of statements.slots.all(from)) {
        if (!r.slots) continue;
        const slots = String(r.slots).split(',').map(Number), id = Number(r.id);
        if (slots.some((v, i) => i > 0 && v >= slots[i - 1])) slots.sort((x, y) => y - x);
        known.set(id, { key: `${r.chain}:${r.address}`, hours: slots.length });
        for (const slot of pickSlots(slots)) picked.push([slot, id]);
      }
      rows = statements.read.all(JSON.stringify(picked));
    } catch (reason) { return { window: windowKey, available: false, error: String(reason?.message || reason).slice(0, 240), version, pools: {} }; }
    const found = new Map();
    for (const r of rows) {
      const pool = known.get(Number(r.pool));
      if (!pool) continue;
      let entry = found.get(pool.key);
      if (!entry) found.set(pool.key, entry = { hours: pool.hours, samples: [], emits: false });
      if (r.emission > 0) entry.emits = true;
      const emissionUsd = r.emission !== null && r.aero_usd !== null ? r.emission * r.aero_usd : null;
      entry.samples.push([r.slot, r.tick, round(r.staked, 6), round(r.usd0, 6), round(r.usd1, 6), round(emissionUsd, 5), round(r.vol24h, 4), round(r.vol7d, 4), r.fee]);
    }
    // 抽中的整点上都没有排放的池子不给平均值；按池键排序让响应稳定。
    const pools = {};
    for (const k of [...found.keys()].sort()) { const { hours, samples, emits } = found.get(k); if (emits) pools[k] = { hours, samples }; }
    const result = { window: windowKey, available: true, error, version, from: from * 1000, pools };
    if (cache.size >= Object.keys(SAMPLE_WINDOWS).length * 2) cache.clear();
    cache.set(cacheKey, result);
    return result;
  }

  // 单个池子 [fromSec, toSec) 内的整点 tick，供详情页的长周期价格图；走 (池, 整点) 索引，30 天最多 720 行。
  function ticks(chainId, address, fromSec, toSec) {
    if (!db) return [];
    try { return statements.ticks.all(chainId, address, fromSec, toSec).map((r) => [Number(r.slot), Number(r.tick)]); }
    catch (reason) { log.warn?.({ type: 'aero-market', err: String(reason?.message || reason).slice(0, 240) }, 'Aero 样本库读取价格历史失败'); return []; }
  }

  return {
    record, read, ticks,
    status: () => ({ available: db !== null, error, version }),
    close() { try { db?.close(); } catch { /* 关闭失败不影响退出 */ } db = null; cache.clear(); poolIds.clear(); },
  };
}
