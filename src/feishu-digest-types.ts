// Mirrors server/automation/feishu-digest.mjs state(); the webhook is never part of it.
export type DigestSchedule = { mode: 'times' | 'interval'; times: string[]; intervalMinutes: number; weekdays: number[]; timezone: string };
export type DigestSectionSetting = { enabled: boolean; hidden: string[] };
export type DigestConfig = { enabled: boolean; title: string; onlyOnAttention: boolean; hideIdle: boolean; showIssues: boolean; schedule: DigestSchedule; sections: Record<string, DigestSectionSetting> };
export type DigestHistoryEntry = { at: string; kind: 'schedule' | 'manual'; status: 'sent' | 'skipped' | 'failed' | 'uncertain'; attention: number; error: string | null };
export type DigestSnapshot = {
  schema: 1; config: DigestConfig; channel: { configured: boolean; host: string | null; error: string | null }; sending: boolean;
  nextAt: string | null; history: DigestHistoryEntry[]; loadError: string | null; serverNow: number; result?: DigestHistoryEntry | null;
};
export type DigestLevel = 'ok' | 'notice' | 'idle' | 'warn' | 'alert';
export type DigestMetric = { key: string; label: string; text: string; lines?: string[]; groups?: { title: string; lines: string[] }[] };
export type DigestSection = { id: string; name: string; level: DigestLevel; status: string; asOf: number | null; metrics: DigestMetric[]; issues: string[] };
export type DigestPreview = {
  digest: { title: string; at: string; clock: string; level: 'ok' | 'warn' | 'alert'; sections: DigestSection[]; attention: { name: string; level: DigestLevel; status: string; issues: string[] }[] };
  bytes: number; omitted: number; catalog: { id: string; name: string; level: DigestLevel; status: string; metrics: { key: string; label: string }[] }[];
};
