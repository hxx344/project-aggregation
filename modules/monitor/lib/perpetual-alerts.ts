import type { QualityBudget } from './perpetual-fees.ts';

export interface PerpetualAlertRule {
  id: string; name: string; enabled: boolean; base: string; longKey: string; shortKey: string;
  thresholdPercent: number; durationSeconds: number; windowSeconds: number; minHitRatio: number;
  cooldownSeconds: number; maxAgeSeconds: number; budget: QualityBudget;
}
export interface PerpetualAlertConfig { enabled: boolean; rules: PerpetualAlertRule[] }
export interface PerpetualAlertProgress {
  state: 'disabled' | 'observing' | 'triggered'; checkedAt: number | null;
  netSpreadPercent: number | null; continuousSeconds: number; hitRatio: number;
  coverage: number; reason: string; lastAttemptAt: number | null; lastSentAt: number | null;
}
export interface PerpetualAlertEvent {
  id: string; ruleId: string; name: string; time: number; status: 'sending' | 'sent' | 'failed';
  base: string; longKey: string; shortKey: string; netSpreadPercent: number; error: string;
}
export interface PerpetualAlertView {
  available: boolean; revision: number; generatedAt: number; config: PerpetualAlertConfig;
  webhookConfigured: boolean; running: boolean; error: string;
  progress: Record<string, PerpetualAlertProgress>; history: PerpetualAlertEvent[];
}

export const maxPerpetualAlertRules = 20;

/** Called only by the add-rule event; HTTP deployments may lack randomUUID. */
export const createPerpetualAlertId = () => globalThis.crypto?.randomUUID?.() ?? `pair-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
