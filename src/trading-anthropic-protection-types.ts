export type ProtectionStatus = {
  state: 'ready' | 'disabled' | 'blocked' | 'unknown' | 'unconfigured' | 'unmatched' | 'running' | 'pending' | 'stale';
  reason: string; checkedAt: string | null; validUntil: string | null;
};
export type PositionProtection = { alert: ProtectionStatus; reduction: ProtectionStatus };
