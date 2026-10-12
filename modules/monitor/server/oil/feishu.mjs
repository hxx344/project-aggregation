import { createHmac } from 'node:crypto';

export function validateWebhook(value) {
  if (!value) return '';
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['open.feishu.cn', 'open.larksuite.com'].includes(url.hostname) || url.port || url.username || url.password || url.search || url.hash || !/^\/open-apis\/bot\/v2\/hook\/[a-zA-Z0-9-]+$/.test(url.pathname)) throw new Error('FEISHU_WEBHOOK_URL 需要飞书或 Lark 自定义机器人 HTTPS 地址');
  return url.href;
}

export function createFeishuPayload(text, secret = '', now = Date.now()) {
  const payload = { msg_type: 'text', content: { text } };
  if (secret) {
    payload.timestamp = String(Math.floor(now / 1000));
    payload.sign = createHmac('sha256', `${payload.timestamp}\n${secret}`).update('').digest('base64');
  }
  return payload;
}

export function createNotifier({ webhook, secret = '', fetcher = fetch, clock = Date.now }) {
  const url = validateWebhook(webhook);
  return async text => {
    if (!url) throw new Error('尚未配置飞书机器人');
    const body = JSON.stringify(createFeishuPayload(text, secret, clock()));
    if (Buffer.byteLength(body) > 20_000) throw new Error('飞书消息超过长度限制');
    let response;
    try { response = await fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(10_000), redirect: 'error' }); }
    catch { throw new Error('飞书连接失败或超时'); }
    if (!response.ok) throw new Error(`飞书 HTTP ${response.status}`);
    let result;
    try { result = await response.json(); } catch { throw new Error('飞书响应格式无效'); }
    if (result.code !== 0) throw new Error(`飞书业务错误 ${Number.isFinite(result.code) ? result.code : 'unknown'}`);
  };
}
