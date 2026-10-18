import fs from 'node:fs';
import path from 'node:path';

// This only rejects unfinished recovery. AccountWriter's persistent transaction
// gate remains the authority for every financial request and state commit.
export function assertRecoveryStartup(dataDir) {
  if (!fs.existsSync(dataDir)) return;
  const database = path.join(dataDir, 'execution-control.sqlite');
  const marker = `${database}.required`;
  let marked = false;
  try { fs.lstatSync(marker); marked = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (marked && !fs.existsSync(database)) throw new Error('账户保护数据库缺失，拒绝创建空库');
  if (fs.readdirSync(dataDir).some(name => name.startsWith('.recovery-stage-'))) throw new Error('存在未完成恢复，拒绝启动');
  const filename = path.join(dataDir, 'recovery-control.json');
  let info;
  try { info = fs.lstatSync(filename); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 8 * 1024 * 1024) throw new Error('恢复控制记录无法确认，拒绝启动');
  let control;
  try { control = JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { throw new Error('恢复控制记录无法确认，拒绝启动'); }
  if (control.body?.schemaVersion !== 1 || control.body.status !== 'complete'
    || !fs.existsSync(path.join(dataDir, 'execution-control.sqlite')) || !fs.existsSync(path.join(dataDir, 'execution-control.sqlite.required'))) throw new Error('隔离恢复尚未完成，拒绝启动');
}
