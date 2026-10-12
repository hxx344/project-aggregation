import { createHmac } from "node:crypto";
import { validateWebhook } from "./alert-engine.mjs";

export function createFeishuPayload(text, secret = "", now = Date.now()) {
  const payload = { msg_type: "text", content: { text } };
  if (secret) {
    const timestamp = String(Math.floor(now / 1000));
    payload.timestamp = timestamp;
    payload.sign = createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64");
  }
  return payload;
}

const failures = {
  9499: "消息格式不正确", 19021: "签名密钥或服务器时间不正确",
  19022: "服务器 IP 不在机器人白名单内", 19024: "消息未匹配机器人的关键词设置",
  11232: "机器人发送频率受限",
};

export async function sendFeishu(config, text, { fetcher = fetch, now = Date.now() } = {}) {
  const url = validateWebhook(config.webhookUrl);
  const body = JSON.stringify(createFeishuPayload(text, config.signingSecret, now));
  if (Buffer.byteLength(body) > 20 * 1024) throw new Error("告警消息超过飞书 20 KB 限制。");
  let response;
  try {
    response = await fetcher(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, redirect: "error", signal: AbortSignal.timeout(8_000) });
  } catch { throw new Error("飞书连接失败或超时，将在条件仍满足时重试。"); }
  if (!response.ok) throw new Error(`飞书返回 HTTP ${response.status}。`);
  let result;
  try { result = await response.json(); } catch { throw new Error("飞书返回了无法识别的响应。"); }
  if (result?.code !== 0) {
    const code = Number.isInteger(result?.code) ? result.code : "未知";
    throw new Error(`飞书发送失败（${code}）：${failures[code] ?? "请检查机器人配置"}。`);
  }
}

export function formatAlert(quote, rules) {
  return [
    "海力士价差告警",
    `当前 ADR 溢价率：${quote.premium.toFixed(2)}%`,
    ...rules.map(rule => `${rule.name}：${rule.direction === "above" ? "≥" : "≤"} ${rule.threshold}%`),
    `ADR：$${quote.adr.toFixed(2)} ｜ 正股 ÷ 10：$${quote.equivalent.toFixed(2)}`,
    `每份价差：$${quote.spread.toFixed(2)}`,
    `报价获取时间：${quote.fetchedAt}（UTC）`,
    "来源：Hyperliquid xyz:SKHY / xyz:SKHX 永续合约",
  ].join("\n");
}
