import os from 'node:os';
import { readFile, stat, statfs } from 'node:fs/promises';

// Host load for the 「服务器状态」 page. Only local system calls: no network, no
// paths, hostnames or process ids in the answer.
const CPU_MIN_INTERVAL_MS = 1000;
const CPU_FIRST_SAMPLE_MS = 250;
const CPU_MAX_INTERVAL_MS = 30_000;

const cpuTimes = list => list.reduce((sum, cpu) => {
  const { user, nice, sys, idle, irq } = cpu.times;
  return { ...sum, busy: sum.busy + user + nice + sys + irq, total: sum.total + user + nice + sys + idle + irq };
}, { busy: 0, total: 0, cores: list.length });
const percent = (part, whole) => whole > 0 ? Math.min(100, Math.max(0, Math.round(part / whole * 1000) / 10)) : null;

async function readSwap(meminfo) {
  try {
    const text = await meminfo();
    const field = name => { const match = new RegExp(`^${name}:\\s+(\\d+) kB`, 'm').exec(text); return match ? Number(match[1]) * 1024 : null; };
    const total = field('SwapTotal'), free = field('SwapFree');
    return total === null || free === null ? null : { totalBytes: total, usedBytes: total - free, usedPercent: percent(total - free, total) };
  } catch { return null; }
}

/**
 * CPU usage is the busy share between two readings of the kernel counters. The
 * first read, and any read more than CPU_MAX_INTERVAL_MS after the previous one
 * (which would otherwise report the average over the whole gap), samples twice,
 * CPU_FIRST_SAMPLE_MS apart. Other reads compare with the previous reading, and
 * reads closer than CPU_MIN_INTERVAL_MS reuse the last value, so polling from
 * several tabs does not shrink the window.
 */
export function createHostStatus({ dataDir, now = Date.now, cpus = os.cpus, totalmem = os.totalmem, freemem = os.freemem, loadavg = os.loadavg, uptime = os.uptime,
  meminfo = () => readFile('/proc/meminfo', 'utf8'), statDisk = statfs, statPath = stat, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let last = null, usage = null, first = null, latest = [];
  const sample = () => cpuTimes(latest = cpus());
  async function cpuUsage() {
    if (!last || now() - last.at > CPU_MAX_INTERVAL_MS) {
      first ??= (async () => {
        const start = sample();
        await wait(CPU_FIRST_SAMPLE_MS);
        const end = sample();
        usage = percent(end.busy - start.busy, end.total - start.total);
        last = { at: now(), ...end };
      })().finally(() => { first = null; });
      await first;
      return usage;
    }
    if (now() - last.at < CPU_MIN_INTERVAL_MS) return usage;
    const current = sample();
    // A core going on or offline adds or drops its whole counters; keep the old value then.
    if (current.cores === last.cores && current.total > last.total) usage = percent(current.busy - last.busy, current.total - last.total);
    last = { at: now(), ...current };
    return usage;
  }
  async function disk(id, label, target) {
    try {
      const [fs, info] = await Promise.all([statDisk(target), statPath(target)]);
      const total = fs.blocks * fs.bsize, available = fs.bavail * fs.bsize, used = (fs.blocks - fs.bfree) * fs.bsize;
      // Same base as df: the space ordinary users can still write.
      return { id, label, device: info.dev, sameFs: `${fs.blocks}:${fs.bfree}:${fs.bavail}`, totalBytes: total, availableBytes: available, usedBytes: used, usedPercent: percent(used, used + available) };
    } catch { return { id, label, device: null, error: '无法读取' }; }
  }
  async function disks() {
    const list = await Promise.all([...(dataDir ? [disk('data', '数据目录', dataDir)] : []), disk('root', '系统盘', '/')]);
    const data = list.find(item => item.id === 'data'), root = list.find(item => item.id === 'root');
    // Same device, or (btrfs subvolumes have their own st_dev) identical block counts.
    const same = data && root && !data.error && !root.error && (data.device === root.device || data.sameFs === root.sameFs);
    return (same ? [{ ...data, label: '数据目录（系统盘）' }] : list).map(({ device, sameFs, ...item }) => item);
  }
  async function read() {
    const total = totalmem(), available = Math.min(freemem(), total);
    const [cpu, swap, diskList] = await Promise.all([cpuUsage(), readSwap(meminfo), disks()]);
    return {
      schemaVersion: 1,
      generatedAt: new Date(now()).toISOString(),
      cpu: { usagePercent: cpu, cores: latest.length, model: latest[0]?.model?.trim() || null, loadAverage: loadavg().map(value => Math.round(value * 100) / 100) },
      memory: { totalBytes: total, availableBytes: available, usedBytes: total - available, usedPercent: percent(total - available, total), swap },
      disks: diskList,
      uptimeSeconds: Math.floor(uptime()),
    };
  }
  return { read };
}
