import { createHmac } from 'node:crypto';

// Pure rules of the Feishu digest: configuration, schedule slots, the digest
// model and its card. Reading the modules and sending live in feishu-digest.mjs.
export const DIGEST_DEFAULTS = Object.freeze({
  enabled: false, title: '工作台汇总', onlyOnAttention: false, hideIdle: true, showIssues: true, sections: Object.freeze({}),
  schedule: Object.freeze({ mode: 'times', times: Object.freeze(['09:00', '21:00']), intervalMinutes: 240, weekdays: Object.freeze([1, 2, 3, 4, 5, 6, 7]), timezone: 'Asia/Shanghai' }),
});
const CONFIG_KEYS = Object.keys(DIGEST_DEFAULTS);
const SCHEDULE_KEYS = Object.keys(DIGEST_DEFAULTS.schedule);
const SECTION_ID = /^(?:project|hub):[A-Za-z0-9_.-]{1,64}$/;
const METRIC_KEY = /^[A-Za-z0-9_-]{1,64}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const MAX_SECTIONS = 64;
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function validTimezone(value) {
  if (typeof value !== 'string' || !value || value.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; }
}
function schedule(value) {
  if (!object(value) || !exactKeys(value, SCHEDULE_KEYS)) throw new Error('发送时间格式不正确');
  const { mode, times, intervalMinutes, weekdays, timezone } = value;
  if (!['times', 'interval'].includes(mode)) throw new Error('发送方式只能是固定时间或按间隔');
  if (!Array.isArray(times) || !times.length || times.length > 24 || times.some(time => typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))) throw new Error('固定时间需要 1 到 24 个 HH:MM');
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 720) throw new Error('发送间隔需要 5 到 720 分钟');
  if (!Array.isArray(weekdays) || !weekdays.length || weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7)) throw new Error('请至少选择一个发送日');
  if (!validTimezone(timezone)) throw new Error('时区无效，请填写如 Asia/Shanghai 的 IANA 时区');
  return { mode, times: [...new Set(times)].sort(), intervalMinutes, weekdays: [...new Set(weekdays)].sort(), timezone };
}
function sections(value) {
  if (!object(value) || Object.keys(value).length > MAX_SECTIONS) throw new Error('模块设置格式不正确');
  const next = {};
  for (const [id, item] of Object.entries(value)) {
    if (!SECTION_ID.test(id) || !object(item) || !exactKeys(item, ['enabled', 'hidden'])) throw new Error('模块设置格式不正确');
    if (typeof item.enabled !== 'boolean' || !Array.isArray(item.hidden) || item.hidden.length > 48 || item.hidden.some(key => typeof key !== 'string' || !METRIC_KEY.test(key))) throw new Error('模块设置格式不正确');
    next[id] = { enabled: item.enabled, hidden: [...new Set(item.hidden)] };
  }
  return next;
}
export function validateDigestConfig(value) {
  if (!object(value) || !exactKeys(value, CONFIG_KEYS)) throw new Error('汇总配置格式不正确');
  const { enabled, title, onlyOnAttention, hideIdle, showIssues } = value;
  if ([enabled, onlyOnAttention, hideIdle, showIssues].some(item => typeof item !== 'boolean')) throw new Error('汇总配置格式不正确');
  if (typeof title !== 'string' || !title.trim() || title.length > 60 || CONTROL.test(title)) throw new Error('标题需要 1 到 60 个字符');
  return { enabled, title: title.trim(), onlyOnAttention, hideIdle, showIssues, schedule: schedule(value.schedule), sections: sections(value.sections) };
}
export function validateChannel(value) {
  if (!object(value) || !exactKeys(value, ['webhookUrl', 'signingSecret']) || typeof value.webhookUrl !== 'string' || typeof value.signingSecret !== 'string') throw new Error('机器人配置格式不正确');
  const signingSecret = value.signingSecret.trim();
  if (signingSecret.length > 512 || CONTROL.test(signingSecret)) throw new Error('签名密钥无效');
  let url;
  try { url = new URL(value.webhookUrl.trim()); } catch { throw new Error('请输入有效的飞书机器人 Webhook 地址'); }
  if (url.protocol !== 'https:' || !['open.feishu.cn', 'open.larksuite.com'].includes(url.hostname) || (url.port && url.port !== '443') || url.username || url.password || url.search || url.hash || !/^\/open-apis\/bot\/v2\/hook\/[a-zA-Z0-9-]+$/.test(url.pathname)) throw new Error('Webhook 必须是飞书或 Lark 自定义机器人 HTTPS 地址');
  return { webhookUrl: url.href, signingSecret };
}

const clocks = new Map();
function formatter(timezone) {
  let format = clocks.get(timezone);
  if (!format) { format = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }); clocks.set(timezone, format); }
  return format;
}
const WEEKDAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
export function localClock(ms, timezone) {
  const parts = Object.fromEntries(formatter(timezone).formatToParts(ms).map(part => [part.type, part.value]));
  const time = `${parts.hour}:${parts.minute}`;
  return { weekday: WEEKDAYS[parts.weekday], time, minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute), label: `${parts.month}-${parts.day} ${time}` };
}
// When clocks go back a local time happens twice; shifts are 30 or 60 minutes in every current zone.
const repeated = (minute, timezone, label) => [30, 60].some(shift => localClock((minute - shift) * 60000, timezone).label === label);
// A slot is a minute since the epoch; matching on local clock parts keeps it right across DST.
// A repeated local time counts once, and one skipped by the spring change has no slot that day.
function isDue(plan, minute) {
  const clock = localClock(minute * 60000, plan.timezone);
  if (!plan.weekdays.includes(clock.weekday)) return false;
  const matches = plan.mode === 'times' ? plan.times.includes(clock.time) : clock.minuteOfDay % plan.intervalMinutes === 0;
  return matches && !repeated(minute, plan.timezone, clock.label);
}
export function latestSlot(plan, minute, graceMinutes) {
  for (let slot = minute; slot > minute - graceMinutes; slot--) if (isDue(plan, slot)) return slot;
  return null;
}
export function nextSlot(plan, minute) {
  for (let slot = minute + 1; slot <= minute + 8 * 1440; slot++) if (isDue(plan, slot)) return slot;
  return null;
}

const ATTENTION = new Set(['warn', 'alert']);
export function buildDigest(items, config, ms) {
  const visible = items.flatMap(section => {
    const setting = config.sections[section.id];
    if (setting?.enabled === false || (config.hideIdle && section.level === 'idle')) return [];
    const hidden = new Set(setting?.hidden ?? []);
    return [{ ...section, metrics: section.metrics.filter(metric => !hidden.has(metric.key)) }];
  });
  const attention = visible.filter(section => ATTENTION.has(section.level));
  const level = attention.some(section => section.level === 'alert') ? 'alert' : attention.length ? 'warn' : 'ok';
  return { title: config.title, at: new Date(ms).toISOString(), clock: localClock(ms, config.schedule.timezone).label, level, sections: visible,
    attention: attention.map(({ name, level: sectionLevel, status, issues }) => ({ name, level: sectionLevel, status, issues })) };
}

const ICONS = { ok: '🟢', notice: '🔵', idle: '⚪', warn: '🟠', alert: '🔴' };
const TEMPLATES = { ok: 'green', warn: 'orange', alert: 'red' };
const ATTENTION_LINES = 20;
// The webhook refuses bodies over 20 KB; the margin covers the signature fields.
const CARD_BYTES = 19 * 1024;
// Names come from project settings, so markdown and `<at>` markup must not act.
const escapeMarkdown = text => text.replace(/[&\\`*_[\]()<>#]/g, char => `&#${char.codePointAt(0)};`).replace(/~/g, '&sim;');
const markdown = content => ({ tag: 'div', text: { tag: 'lark_md', content } });
const plain = content => ({ tag: 'div', text: { tag: 'plain_text', content } });
const size = card => Buffer.byteLength(JSON.stringify({ msg_type: 'interactive', card }));
function sectionBlock(section, timezone) {
  const when = section.asOf ? ` · 数据 ${localClock(section.asOf, timezone).label}` : '';
  const lines = section.metrics.flatMap(metric => metric.lines?.length ? [`${metric.label}：`, ...metric.lines.map(line => `  ${line}`)] : [`${metric.label}：${metric.text}`]);
  return [{ tag: 'hr' }, markdown(`${ICONS[section.level]} **${escapeMarkdown(section.name)}**　${escapeMarkdown(section.status)}${when}`), ...(lines.length ? [plain(lines.join('\n'))] : [])];
}
function attentionLines(digest) {
  const lines = digest.attention.flatMap(item => (item.issues.length ? item.issues : [item.status]).map(issue => `· ${item.name}：${issue}`));
  return lines.length > ATTENTION_LINES ? [...lines.slice(0, ATTENTION_LINES), `· 另有 ${lines.length - ATTENTION_LINES} 条，请到工作台查看`] : lines;
}
export function renderCard(digest, { showIssues, schedule: plan }) {
  const count = digest.attention.length;
  const summary = [markdown(count ? `${ICONS[digest.level]} **${count} 个模块需要关注**` : `${ICONS.ok} **没有需要处理的问题**　共 ${digest.sections.length} 个模块`),
    ...(count && showIssues ? [plain(attentionLines(digest).join('\n'))] : [])];
  const blocks = digest.sections.map(section => sectionBlock(section, plan.timezone));
  const compose = kept => {
    const omitted = blocks.length - kept;
    return { config: { wide_screen_mode: true }, header: { template: TEMPLATES[digest.level], title: { tag: 'plain_text', content: `${digest.title} ${digest.clock}` } },
      elements: [...summary, ...blocks.slice(0, kept).flat(), { tag: 'hr' }, { tag: 'note', elements: [{ tag: 'plain_text', content: `${omitted ? `另有 ${omitted} 个模块超出飞书长度限制未显示。` : ''}数值来自各模块最新缓存，时间为 ${plan.timezone}` }] }] };
  };
  let kept = blocks.length, card = compose(kept);
  while (kept > 0 && size(card) > CARD_BYTES) card = compose(--kept);
  return { card, bytes: size(card), omitted: blocks.length - kept };
}

const FAILURES = { 9499: '消息格式不正确', 19021: '签名密钥或服务器时间不正确', 19022: '服务器 IP 不在机器人白名单内', 19024: '消息未匹配机器人的关键词设置，可在标题中加入关键词', 11232: '机器人发送频率受限' };
const uncertain = message => Object.assign(new Error(message), { uncertain: true });
export async function postCard({ webhookUrl, signingSecret }, card, { fetcher = fetch, now = Date.now(), signal, timeoutMs = 8000 } = {}) {
  const payload = { msg_type: 'interactive', card };
  if (signingSecret) {
    const timestamp = String(Math.floor(now / 1000));
    payload.timestamp = timestamp;
    payload.sign = createHmac('sha256', `${timestamp}\n${signingSecret}`).update('').digest('base64');
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  let response, result;
  try {
    response = await fetcher(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  // A lost response may follow a delivered message, so the caller must not resend blindly.
  } catch { throw uncertain('飞书连接失败或超时，消息可能已送达'); }
  if (!response.ok) { const error = new Error(`飞书返回 HTTP ${response.status}`); error.uncertain = response.status >= 500; throw error; }
  try { result = await response.json(); } catch { throw uncertain('飞书返回了无法识别的响应，消息可能已送达'); }
  if (!object(result) || !Number.isInteger(result.code)) throw uncertain('飞书返回了无法识别的响应，消息可能已送达');
  if (result.code !== 0) throw new Error(`飞书发送失败（${result.code}）：${FAILURES[result.code] ?? '请检查机器人配置'}`);
}
