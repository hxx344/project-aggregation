"use client";

import { memo } from "react";
import SettledFundingPanel, { type SettledFundingConfig } from "./settled-funding-panel";
import { FIRST_FUNDING_SETTLEMENT, FUNDING_HOUR } from "../lib/hynix-funding-history";
import { useFundingHistory } from "../hooks/use-funding-history";

const config: SettledFundingConfig = {
  label: "海力士历史多空资金费", intervalMs: FUNDING_HOUR, firstSettlement: FIRST_FUNDING_SETTLEMENT,
  short: "空 ADR、多正股", long: "多 ADR、空正股", coverage: { count: "个共同结算小时", missing: "小时", valid: "个有效小时" },
  method: "区间累计年化 = 净小时费率之和 ÷ 有效小时数 × 8,760，不复利。历史图按两腿等名义计算；顶部卡片按固定 10 份 ADR 对 1 股正股计算当前预估年化。",
  details: <><p>做空净小时率 = (SKHY 费率 − SKHX 费率) ÷ 2；做多取相反数。分母是双腿总名义金额，每小时按等名义权重计算。累计曲线从所选区间重新求和，累计年化曲线使用截至各时点的有效小时数。只统计资金费，不含价差盈亏。</p><p>从 2026-07-10 15:00 UTC 的结算开始，与价差图首个完整价格小时结束时间对应。缺少任一腿或整个小时均保留断点，不补零；缺失时的累计值只代表已覆盖部分。历史数据每 5 分钟检查更新。</p><a href="https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding" target="_blank" rel="noreferrer">Hyperliquid 资金费规则 ↗</a><a href="https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals" target="_blank" rel="noreferrer">历史结算费率接口 ↗</a></>,
};

function HynixFundingPanel({ range, onRangeChange }: { range: number | null; onRangeChange: (range: number | null) => void }) {
  const { data, error, loading, refresh } = useFundingHistory();
  return <SettledFundingPanel range={range} onRangeChange={onRangeChange} config={config}
    feed={{ rows: data?.rows ?? null, fetchedAt: data?.metadata.fetchedAt ?? null, snapshot: data?.status === "snapshot", error, notice: data?.error, loading, refresh }}/>;
}

export default memo(HynixFundingPanel);
