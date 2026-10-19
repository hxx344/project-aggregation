/** 输入与产物摘要：缓存复用、跳过判断和回滚核对共用同一套哈希规则。 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/** 生成物、依赖和运行状态不参与源码输入摘要。 */
const IGNORED_DIRECTORIES = new Set([
  'node_modules', '.git', 'dist', '.next', '.vinext', '.wrangler', '.build-cache', '.module-cache',
  '.pipeline', '.data', '.data-dev', '.data-test', '__pycache__', '.pytest_cache', '.venv', '.venv-aster', 'output',
]);

export function hashFile(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * 对一组文件/目录求稳定摘要。
 * 目录按字典序遍历，符号链接直接报错：链接可能指向构建机之外，摘要不可复现。
 */
export function hashPaths(root, paths = []) {
  const hash = createHash('sha256');
  const visit = (absolute, relative) => {
    if (!existsSync(absolute)) {
      hash.update(`${relative}\u0000<absent>\n`);
      return;
    }
    const stats = statSync(absolute);
    if (stats.isSymbolicLink()) throw new Error(`输入包含符号链接：${relative}`);
    if (stats.isDirectory()) {
      for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (IGNORED_DIRECTORIES.has(entry.name) || entry.name.endsWith('.tsbuildinfo')) continue;
        visit(path.join(absolute, entry.name), `${relative}/${entry.name}`);
      }
      return;
    }
    hash.update(`${relative}\u0000`).update(readFileSync(absolute));
  };
  for (const relative of [...paths].sort()) visit(path.resolve(root, relative), relative.replaceAll('\\', '/'));
  return hash.digest('hex');
}

/** 记录产物当前摘要；缺失记为 null，供跳过判断拒绝复用不完整产物。 */
export function snapshotOutputs(root, outputs = []) {
  const snapshot = {};
  for (const relative of outputs) {
    const absolute = path.resolve(root, relative);
    snapshot[relative] = existsSync(absolute) && statSync(absolute).isFile() ? hashFile(absolute) : null;
  }
  return snapshot;
}

export function outputsIntact(root, snapshot = {}) {
  const entries = Object.entries(snapshot);
  if (!entries.length) return true;
  return entries.every(([relative, expected]) => {
    if (!expected) return false;
    const absolute = path.resolve(root, relative);
    return existsSync(absolute) && statSync(absolute).isFile() && hashFile(absolute) === expected;
  });
}
