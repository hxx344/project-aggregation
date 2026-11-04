export type HostDisk = { id: 'data' | 'root'; label: string; error?: string; totalBytes?: number; availableBytes?: number; usedBytes?: number; usedPercent?: number | null };
export type HostStatus = {
  schemaVersion: 1;
  generatedAt: string;
  cpu: { usagePercent: number | null; cores: number; model: string | null; loadAverage: number[] };
  memory: { totalBytes: number; availableBytes: number; usedBytes: number; usedPercent: number | null; swap: { totalBytes: number; usedBytes: number; usedPercent: number | null } | null };
  disks: HostDisk[];
  uptimeSeconds: number;
};
