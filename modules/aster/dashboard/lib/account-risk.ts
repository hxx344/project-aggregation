import { configuredMarginPercent } from './policy.ts';

type RiskAccount = {
  policy?: { margin_limit?: string };
  risk_limits?: { high_leverage?: string };
};

export function accountRiskView(account: RiskAccount, ratio: number | null) {
  const base = account?.policy?.margin_limit;
  const marginPercent = configuredMarginPercent(base);
  const marginLimit = marginPercent === null ? null : Number(base);
  const high = account?.risk_limits?.high_leverage ?? base;
  const highMarginPercent = configuredMarginPercent(high);
  const highMarginLimit = highMarginPercent === null ? null : Number(high);
  const riskAccent =
    ratio === null || marginLimit === null || highMarginLimit === null
      ? 'muted'
      : ratio > highMarginLimit
        ? 'danger'
        : ratio > marginLimit
          ? 'amber'
          : 'mint';
  return {
    marginLimit,
    marginPercent,
    marginDraft: marginPercent ?? '',
    highMarginLimit,
    highMarginPercent,
    riskAccent,
  };
}
