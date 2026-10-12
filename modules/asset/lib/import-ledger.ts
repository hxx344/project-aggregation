import { createHash, randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { chinaDate, db, getLedger, lock, unlock } from './store';
import { seedLedger, type SourceLedger } from './seed';
import { EXAMPLE_SOURCE, parseSource } from './source-ledger';
import type { Asset, Ledger } from './types';

function importPlan(source: SourceLedger, current: Ledger, previous: SourceLedger) {
  const imported = seedLedger(source), old = seedLedger(previous);
  const retained: string[] = [], matched = new Set<string>();
  const key = (asset: Asset) => asset.mode === 'manual' ? asset.project + '\0' + asset.kind : asset.mode;
  const edited = (asset: Asset) => {
    const base = old.assets.find(a => a.id === asset.id);
    return !base || asset.quantity !== base.quantity || (asset.mode === 'manual' && (asset.price !== base.price || asset.value !== base.value));
  };
  imported.assets = imported.assets.map(asset => {
    const existing = current.assets.filter(a => key(a) === key(asset));
    if (existing.length > 1) throw new Error('已有资产名称和类型重复，无法安全合并');
    const saved = existing[0];
    if (!saved) return asset;
    matched.add(saved.id);
    if ((asset.mode === 'bybit' || asset.mode === 'aster' || asset.mode === 'binance' || asset.mode === 'okx' || asset.mode === 'variational') && (current.connections[asset.mode].configured || current.connections[asset.mode].lastSync)) {
      retained.push(asset.project + ' 已同步余额');
      return { ...saved, id: asset.id, cell: asset.cell };
    }
    if (asset.mode === 'manual' && edited(saved)) {
      retained.push(asset.project + ' 手动修改');
      return { ...saved, id: asset.id, cell: asset.cell };
    }
    if (asset.mode === 'market') {
      const quantity = edited(saved) ? saved.quantity : asset.quantity;
      if (edited(saved)) retained.push(asset.project + ' 手动数量');
      const fresh = saved.price !== null && !saved.error && Date.now() - Date.parse(saved.updatedAt) < 900000;
      if (fresh) return { ...saved, id: asset.id, cell: asset.cell, quantity, value: (quantity ?? 0) * saved.price! };
      return { ...asset, quantity, value: quantity === null || asset.price === null ? null : quantity * asset.price };
    }
    return asset;
  });
  let nextId = Math.max(...imported.assets.map(a => Number(a.id.slice(4)))) + 1;
  for (const asset of current.assets) {
    const syncedWallet = (asset.mode === 'binance' || asset.mode === 'okx' || asset.mode === 'variational') && (current.connections[asset.mode].configured || current.connections[asset.mode].lastSync);
    if (!matched.has(asset.id) && (edited(asset) || syncedWallet)) {
      imported.assets.push({ ...asset, id: 'row-' + nextId++ });
      retained.push(asset.project + (syncedWallet ? ' 已同步余额（额外保留）' : ' 手动修改（额外保留）'));
    }
  }
  if (current.fx !== old.fx || current.fxStatus.source !== 'saved') { imported.fx = current.fx; imported.fxStatus = current.fxStatus; retained.push('当前汇率'); }
  return { ledger: imported, retained };
}

/** Import once into the example ledger; never overwrite an existing personal ledger. */
export async function importLedger(owner: string, input: unknown, apply: boolean) {
  const source = parseSource(input);
  if (source.source === EXAMPLE_SOURCE) throw new Error('请选择从原表生成的导入文件，不能再次导入示例');
  const fingerprint = createHash('sha256').update(JSON.stringify(source)).digest('hex');
  await lock(owner);
  try {
    const current = await getLedger(owner);
    const priorFingerprint = await db().prepare('SELECT value FROM settings WHERE owner = ? AND key = ?').bind(owner, 'source-import-hash').first<{ value: string }>();
    if (priorFingerprint?.value === fingerprint) return { ledger: current, alreadyImported: true };
    if (current.dataKind !== 'example') throw new Error('此账本已含原表数据，已停止导入以保留现有记录');
    const original = await db().prepare('SELECT value FROM settings WHERE owner = ? AND key = ?').bind(owner, 'source-ledger').first<{ value: string }>();
    if (!original) throw new Error('无法读取原有记录，未执行导入');
    const previous: SourceLedger = JSON.parse(original.value);
    const plan = importPlan(source, current, previous);
    const summary = {
      source: source.source, rows: seedLedger(source).assets.length, periods: source.periods.length,
      baselineDate: source.baselineDate, baselineTotal: plan.ledger.baselineTotal,
      resultingRows: plan.ledger.assets.length, retained: plan.retained,
    };
    if (!apply) return { summary };

    const batchId = randomUUID();
    const backupName = 'before-import-' + batchId + '.sqlite';
    const backupPath = resolve(process.env.ASSET_DATA_DIR || '.data', 'backups', backupName);
    await db().backup(backupPath);
    chmodSync(backupPath, 0o600);
    const snapshots = await db().prepare('SELECT data FROM snapshots WHERE owner = ?').bind(owner).all<{ data: string }>();
    // Keep pre-import snapshots readable, but exclude example values from the real trend.
    const archived = [
      ...previous.periods.map(({ rows, ...period }) => ({ ...period, assets: rows })),
      ...snapshots.results.map(row => JSON.parse(row.data)),
    ].map((period, index) => ({ ...period, id: `archive-${batchId}-${index}`, archived: true }));
    const date = chinaDate(), total = plan.ledger.assets.reduce((sum, a) => sum + (a.value ?? 0), 0);
    const today = { id: 'daily-' + date, date, total, fx: plan.ledger.fx, fxStatus: plan.ledger.fxStatus, cny: total * plan.ledger.fx, future: false, difference: 0,
      partial: plan.ledger.assets.some(a => a.mode !== 'manual' && (!!a.error || Date.now() - Date.parse(a.updatedAt) > 900000)),
      updatedAt: new Date().toISOString(), assets: plan.ledger.assets };
    const settings: Record<string, string> = { 'source-ledger': JSON.stringify(source), 'source-import-hash': fingerprint, fx: String(plan.ledger.fx), 'fx-status': JSON.stringify(plan.ledger.fxStatus), 'last-attempt': '0' };
    await db().batch([
      db().prepare('DELETE FROM assets WHERE owner = ?').bind(owner),
      ...plan.ledger.assets.map(asset => db().prepare('INSERT INTO assets(owner,id,data) VALUES(?,?,?)').bind(owner, asset.id, JSON.stringify(asset))),
      ...Object.entries(settings).map(([key, value]) => db().prepare('INSERT INTO settings(owner,key,value) VALUES(?,?,?) ON CONFLICT(owner,key) DO UPDATE SET value=excluded.value').bind(owner, key, value)),
      db().prepare('DELETE FROM snapshots WHERE owner = ?').bind(owner),
      ...archived.map(period => db().prepare('INSERT INTO snapshots(owner,date,data) VALUES(?,?,?)').bind(owner, period.id, JSON.stringify(period))),
      db().prepare('INSERT INTO snapshots(owner,date,data) VALUES(?,?,?)').bind(owner, date, JSON.stringify(today)),
    ]);
    return { ledger: await getLedger(owner), summary, backupName };
  } finally { await unlock(owner); }
}
