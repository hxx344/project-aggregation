import type { LiveQuote } from "./market";

export type AlertRule = { id: string; name: string; direction: "above" | "below"; threshold: number; enabled: boolean; cooldownSeconds?: number; hysteresis?: number };
export type AlertConfig = { enabled: boolean; cooldownSeconds: number; hysteresis: number; rules: AlertRule[] };
export type AlertView = {
  available: boolean;
  reason?: string;
  revision: number;
  config: AlertConfig & { webhookConfigured: boolean; signingSecretConfigured: boolean };
  status: { checkedAt: string | null; lastSuccessAt: string | null; lastError: string; lastQuote: LiveQuote | null };
  ruleStates: Record<string, { armed: boolean; lastSentAt: number | null; lastAttemptAt: number | null }>;
  history: { id: string; time: string; kind: "alert" | "test"; status: "sent" | "failed"; premium?: number; rules: string[]; error: string }[];
};
