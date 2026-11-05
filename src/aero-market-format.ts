// Aero 市场列表与池子详情共用的显示格式。
export const dates = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
export const when = (ms: number | null) => (ms ? dates.format(ms) : '—');
export const message = (reason: unknown) => (reason instanceof Error ? reason.message : '请求失败，请重试。');
export const usd = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(v >= 10 ? 0 : 2)}`);
export const pct = (v: number | null | undefined, digits = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(digits)}%`);
// 带正负号的美元金额，用于回放盈亏。
export const signedUsd = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v < 0 ? '−' : '+'}${usd(Math.abs(v))}`);
export const signed = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(2)}%`);
export const days = (v: number | null) => (v === null ? '—' : v >= 365 ? '>1 年' : v >= 10 ? `${v.toFixed(0)} 天` : v >= 1 ? `${v.toFixed(1)} 天` : `${(v * 24).toFixed(1)} 小时`);
export const amount = (v: number) => (v >= 1e4 ? v.toLocaleString('zh-CN', { maximumFractionDigits: 0 }) : v.toLocaleString('zh-CN', { maximumFractionDigits: 2 }));
// 代币数量：小数额保留有效数字，避免 0.000012 显示成 0。
export const tokenAmount = (v: number) => (!Number.isFinite(v) ? '—' : v === 0 ? '0' : v >= 1 ? amount(v) : v.toPrecision(4));
