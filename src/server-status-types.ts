export type HostDisk = { id: 'data' | 'root'; label: string; error?: string; totalBytes?: number; availableBytes?: number; usedBytes?: number; usedPercent?: number | null };
export type HostStatus = {
  schemaVersion: 1;
  generatedAt: string;
  cpu: { usagePercent: number | null; cores: number; model: string | null; loadAverage: number[] };
  memory: { totalBytes: number; availableBytes: number; usedBytes: number; usedPercent: number | null; swap: { totalBytes: number; usedBytes: number; usedPercent: number | null } | null };
  disks: HostDisk[];
  uptimeSeconds: number;
};

export const hostLevel = (value: number | null | undefined) => value == null ? '' : value >= 90 ? 'alert' : value >= 75 ? 'warn' : '';
export function formatBytes(bytes: number | undefined) {
  if (bytes === undefined || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
export function formatUptime(seconds: number) {
  const days = Math.floor(seconds / 86400), hours = Math.floor(seconds % 86400 / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return days ? `${days} 天 ${hours} 小时` : hours ? `${hours} 小时 ${minutes} 分钟` : `${minutes} 分钟`;
}
