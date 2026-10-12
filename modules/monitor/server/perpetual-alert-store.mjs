import { mkdir, readFile, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initialPerpetualAlertState, validatePerpetualAlertConfig } from './perpetual-alert-engine.mjs';

export async function openPerpetualAlertStore(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = resolve(directory, 'opportunity-alerts.json');
  let state = initialPerpetualAlertState();
  try {
    if ((await stat(file)).size > 1_000_000) throw new Error('State too large');
    const loaded = JSON.parse(await readFile(file, 'utf8'));
    if (loaded.version !== 1 || !Number.isSafeInteger(loaded.revision) || loaded.revision < 0 || !loaded.ruleStates || typeof loaded.ruleStates !== 'object' || Array.isArray(loaded.ruleStates) || !Array.isArray(loaded.history)) throw new Error('Invalid state');
    loaded.config = validatePerpetualAlertConfig(loaded.config);
    loaded.ruleStates = Object.fromEntries(loaded.config.rules.map(rule => {
      const saved = loaded.ruleStates[rule.id];
      if (saved && (typeof saved.armed !== 'boolean' || [saved.lastSentAt, saved.lastAttemptAt].some(value => value !== null && (!Number.isFinite(value) || value < 0)))) throw new Error('Invalid rule state');
      return [rule.id, saved ?? { armed: true, lastSentAt: null, lastAttemptAt: null }];
    }));
    loaded.history = loaded.history.filter(item => item && Number.isFinite(item.time) && item.time > 0 && Number.isFinite(item.netSpreadPercent)
      && ['sending', 'sent', 'failed'].includes(item.status)
      && [['id', 64], ['ruleId', 64], ['name', 80], ['base', 80], ['longKey', 160], ['shortKey', 160], ['error', 200]].every(([key, length]) => typeof item[key] === 'string' && item[key].length <= length)).slice(0, 100);
    state = loaded;
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('合约机会提醒状态无法读取，请修复或恢复 opportunity-alerts.json。', { cause: error }); }
  return {
    get: () => structuredClone(state),
    async save(next) {
      const copy = structuredClone(next), temporary = `${file}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, `${JSON.stringify(copy)}\n`, { mode: 0o600 }); await rename(temporary, file); state = copy; }
      catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    },
  };
}
