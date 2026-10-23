import {
  configuredMarginPercent,
  cycleMarginLimit,
  migrationMarginLimit,
} from './policy.ts';

type RiskAccount = {
  policy?: { margin_limit?: string };
  risk_limits?: {
    high_leverage?: string;
    migration?: string;
    cycle?: string;
  };
  cycle?: { enabled: boolean };
};

export function accountRiskView(account: RiskAccount, ratio: number | null) {
  const base = account?.policy?.margin_limit;
  const marginPercent = configuredMarginPercent(base);
  const marginLimit = marginPercent === null ? null : Number(base);
  const high = account?.risk_limits?.high_leverage ?? base;
  const highMarginPercent = configuredMarginPercent(high);
  const highMarginLimit = highMarginPercent === null ? null : Number(high);
  const reportedMigration =
    account?.risk_limits?.migration ?? account?.risk_limits?.high_leverage;
  const migrationMarginPercent = configuredMarginPercent(
    reportedMigration ??
      (marginPercent !== null ? migrationMarginLimit(base!) : undefined),
  );
  const cycleLimit = cycleMarginLimit(account?.risk_limits);
  const cycleMarginPercent = configuredMarginPercent(cycleLimit);
  const cycleRiskLimit = cycleLimit === null ? null : Number(cycleLimit);
  const cycleMode = Boolean(account?.cycle?.enabled);
  const upperRiskLimit = cycleMode ? cycleRiskLimit : highMarginLimit;
  const upperRiskPercent = cycleMode ? cycleMarginPercent : highMarginPercent;
  const riskAccent =
    ratio === null || marginLimit === null || upperRiskLimit === null
      ? 'muted'
      : ratio > upperRiskLimit
        ? 'danger'
        : ratio > marginLimit
          ? 'amber'
          : 'mint';
  return {
    marginLimit,
    marginPercent,
    marginDraft: marginPercent ?? '',
    highMarginPercent,
    migrationMarginPercent,
    cycleMarginPercent,
    cycleMode,
    upperRiskLimit,
    upperRiskPercent,
    riskAccent,
  };
}
