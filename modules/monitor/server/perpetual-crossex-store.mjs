import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeCrossExBlockedBases } from '../lib/perpetual-crossex-config.ts';

export const initialCrossExSettings = () => ({ version: 1, revision: 0, config: { requireSpotTransfer: false, blockedBases: [] } });
export function validateCrossExConfig(config, previous = { blockedBases: [] }) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(key => !['requireSpotTransfer', 'blockedBases'].includes(key)) || typeof config.requireSpotTransfer !== 'boolean') throw new Error('CrossEx 筛选配置无效');
  return { requireSpotTransfer: config.requireSpotTransfer, blockedBases: normalizeCrossExBlockedBases(Object.hasOwn(config, 'blockedBases') ? config.blockedBases : previous.blockedBases) };
}

export async function openCrossExSettingsStore(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'crossex-settings.json');
  let state = initialCrossExSettings();
  try {
    const text = await readFile(file, 'utf8');
    if (text.length > 16_384) throw new Error('State too large');
    const loaded = JSON.parse(text);
    if (loaded.version !== 1 || !Number.isSafeInteger(loaded.revision) || loaded.revision < 0) throw new Error('Invalid state');
    state = { version: 1, revision: loaded.revision, config: validateCrossExConfig(loaded.config) };
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('CrossEx 筛选设置无法读取，请修复或恢复 crossex-settings.json。', { cause: error });
  }
  return {
    get: () => structuredClone(state),
    async save(next) {
      const copy = structuredClone(next), temporary = `${file}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, `${JSON.stringify(copy)}\n`, { mode: 0o600 }); await rename(temporary, file); state = copy; }
      catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    },
  };
}
