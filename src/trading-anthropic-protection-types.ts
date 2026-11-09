export type ProtectionStatus = {
  state: 'ready' | 'monitoring' | 'disabled' | 'blocked' | 'unknown' | 'unconfigured' | 'unmatched' | 'running' | 'pending' | 'stale';
  reason: string; checkedAt: string | null; validUntil: string | null; monitorUntil?: string;
};
export type PositionProtection = { alert: ProtectionStatus; reduction: ProtectionStatus };
