import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const active = new Set();
// Same Linux identity as module supervision; unknown identity never proves death.
function processStart(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const value = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
    return Number.isSafeInteger(value) ? value : null;
  } catch { return null; }
}

export function parseUpdateOwner(value) {
  if (!value) return null;
  const owner = JSON.parse(value), base = owner?.baseline;
  if (owner?.version !== 1 || typeof owner.requestId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(owner.requestId)
    || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !['preparing', 'sending'].includes(owner.phase)
    || owner.processStart !== null && (!Number.isSafeInteger(owner.processStart) || owner.processStart < 0)
    || typeof base?.maintenance !== 'boolean' || base.pendingPlanId !== null && (typeof base.pendingPlanId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(base.pendingPlanId))
    || !['source', 'ci'].includes(base.pendingDeployMode)) throw new Error('更新准入所有者记录无效，保持维护');
  return owner;
}

export const newUpdateOwner = baseline => ({ version: 1, requestId: randomUUID(), pid: process.pid, processStart: processStart(process.pid), phase: 'preparing', baseline });
export const trackUpdateOwner = owner => active.add(owner.requestId);
export const finishUpdateOwner = owner => { if (owner) active.delete(owner.requestId); };
export function updateOwnerAlive(owner) {
  if (owner.pid === process.pid) return active.has(owner.requestId);
  try { process.kill(owner.pid, 0); } catch (error) { return error.code !== 'ESRCH'; }
  const observed = processStart(owner.pid);
  return observed === null || owner.processStart === null || observed === owner.processStart;
}
