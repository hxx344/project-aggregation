export type NotificationView = {
  available: boolean;
  reason?: string;
  revision: number;
  webhookConfigured: boolean;
  signingSecretConfigured: boolean;
  candidates: { id: "oil" | "hynix"; label: string; destination: string; signingSecretConfigured: boolean }[];
  migratedFrom: string[];
  lastTestAt: number | null;
  testResult: { time: string; status: "sending" | "sent" | "failed"; error: string } | null;
  error: string;
};
