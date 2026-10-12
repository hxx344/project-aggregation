export type MonitorRuntime = { available: boolean; monitorId: string; enabled: boolean; revision: number; running: boolean; error?: string; reason?: string };
export type MonitorRuntimeMap = Record<string, MonitorRuntime>;

export function parseMonitorRuntime(value: unknown): MonitorRuntime {
  const item = value as MonitorRuntime;
  if (!item || typeof item.available !== 'boolean' || typeof item.monitorId !== 'string' || typeof item.enabled !== 'boolean' || !Number.isSafeInteger(item.revision) || item.revision < 0 || typeof item.running !== 'boolean') throw new Error('监控开关状态无效');
  return item;
}
