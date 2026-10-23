/** 配置备份只含原文件，元数据可写入 journal；提权入口不输出配置内容。 */
import { copyFileSync, mkdirSync, lstatSync, chmodSync, chownSync, rmSync, constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function regularFile(target) {
  try {
    const stats = lstatSync(target);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`配置路径不是普通文件：${target}`);
    return stats;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function snapshotFile(target, backup) {
  const stats = regularFile(target);
  if (!stats) return { target, backup: null, existed: false };
  mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
  copyFileSync(target, backup, constants.COPYFILE_EXCL);
  chmodSync(backup, 0o600);
  return { target, backup, existed: true, mode: stats.mode & 0o7777, uid: stats.uid, gid: stats.gid };
}

export function restoreFile(snapshot) {
  regularFile(snapshot.target);
  if (!snapshot.existed) {
    rmSync(snapshot.target, { force: true });
    return;
  }
  if (!snapshot.backup || !regularFile(snapshot.backup)) throw new Error(`缺少恢复备份：${snapshot.backup ?? snapshot.target}`);
  copyFileSync(snapshot.backup, snapshot.target);
  if (process.platform !== 'win32' && Number.isInteger(snapshot.uid) && Number.isInteger(snapshot.gid)) {
    const current = regularFile(snapshot.target);
    if (current.uid !== snapshot.uid || current.gid !== snapshot.gid) chownSync(snapshot.target, snapshot.uid, snapshot.gid);
  }
  chmodSync(snapshot.target, snapshot.mode ?? 0o600);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [operation, target, backup] = process.argv.slice(2);
    if (operation === 'snapshot') process.stdout.write(`${JSON.stringify(snapshotFile(target, backup))}\n`);
    else if (operation === 'restore') restoreFile(JSON.parse(target));
    else throw new Error('未知配置文件操作');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
