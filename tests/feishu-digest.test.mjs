import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';
import { DIGEST_DEFAULTS, buildDigest, latestSlot, localClock, nextSlot, postCard, renderCard, validateChannel, validateDigestConfig } from '../server/automation/feishu-digest-core.mjs';
import { createFeishuDigest } from '../server/automation/feishu-digest.mjs';
import { aeroSection, collectSections, executionSection, fundingSection, positionsSection, projectSection, researchSection } from '../server/automation/feishu-digest-sources.mjs';
import { loadCredentialCipher } from '../server/runtime/credentials.mjs';

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const WEBHOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/abc-123';
const defaults = (extra = {}) => ({ ...structuredClone(DIGEST_DEFAULTS), ...extra });
// 2026-10-30 is a Friday; 01:00 UTC is 09:00 in Asia/Shanghai.
const AT_NINE = Date.parse('2026-10-30T01:00:00Z');
const section = (id, level = 'ok', extra = {}) => ({ id, name: id, level, status: '正常', asOf: null, metrics: [], issues: [], ...extra });
const okFetch = calls => async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ code: 0 }) }; };
function manager(options = {}) {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'feishu-digest-'));
  const clock = { now: options.at ?? AT_NINE }, calls = [];
  const digest = createFeishuDigest({ dataDir, ...loadCredentialCipher(dataDir, silent), log: silent, tickMs: 0, now: () => clock.now, fetcher: okFetch(calls), retryMs: 60000,
    readSections: async () => [section('hub:a')], ...options.manager });
  digest.initialize();
  return { digest, clock, calls, dataDir };
}
const settled = async digest => { while (digest.state().sending) await new Promise(resolve => setTimeout(resolve, 1)); };
function enable(digest, schedule = {}) {
  digest.setChannel({ webhookUrl: WEBHOOK, signingSecret: '' });
  return digest.save(defaults({ enabled: true, schedule: { ...DIGEST_DEFAULTS.schedule, times: ['09:00'], ...schedule } }));
}

test('configuration accepts only known fields and normalizes the schedule', () => {
  const next = validateDigestConfig(defaults({ title: ' 日报 ', schedule: { ...DIGEST_DEFAULTS.schedule, times: ['21:00', '09:00', '09:00'], weekdays: [5, 1, 1] }, sections: { 'project:aster': { enabled: false, hidden: ['a', 'a'] } } }));
  assert.equal(next.title, '日报');
  assert.deepEqual(next.schedule.times, ['09:00', '21:00']);
  assert.deepEqual(next.schedule.weekdays, [1, 5]);
  assert.deepEqual(next.sections['project:aster'].hidden, ['a']);
  for (const bad of [{ extra: 1 }, { title: '' }, { title: 'a\nb' }, { enabled: 'yes' }, { sections: { __proto__x: { enabled: true, hidden: [] } } }, { sections: { 'hub:a': { enabled: true } } }]) assert.throws(() => validateDigestConfig(defaults(bad)), undefined, JSON.stringify(bad));
  for (const bad of [{ times: [] }, { times: ['24:00'] }, { times: ['9:00'] }, { intervalMinutes: 4 }, { intervalMinutes: 721 }, { intervalMinutes: 1.5 }, { weekdays: [] }, { weekdays: [0] }, { timezone: 'Mars/Base' }, { mode: 'cron' }, { cron: '*' }]) assert.throws(() => validateDigestConfig(defaults({ schedule: { ...DIGEST_DEFAULTS.schedule, ...bad } })), undefined, JSON.stringify(bad));
});

test('the webhook must be a Feishu or Lark custom bot address', () => {
  assert.deepEqual(validateChannel({ webhookUrl: ` ${WEBHOOK} `, signingSecret: ' s ' }), { webhookUrl: WEBHOOK, signingSecret: 's' });
  for (const webhookUrl of ['http://open.feishu.cn/open-apis/bot/v2/hook/a', 'https://evil.example/open-apis/bot/v2/hook/a', 'https://open.feishu.cn.evil.example/open-apis/bot/v2/hook/a', 'https://u:p@open.feishu.cn/open-apis/bot/v2/hook/a', `${WEBHOOK}?a=1`, 'https://open.feishu.cn/open-apis/bot/v2/hook/../x', 'https://open.feishu.cn:8443/open-apis/bot/v2/hook/a', 'nonsense']) assert.throws(() => validateChannel({ webhookUrl, signingSecret: '' }), undefined, webhookUrl);
  assert.throws(() => validateChannel({ webhookUrl: WEBHOOK }));
});

test('slots follow the configured timezone, weekdays and interval', () => {
  const plan = { ...DIGEST_DEFAULTS.schedule, times: ['09:00'] }, minute = AT_NINE / 60000;
  assert.equal(localClock(AT_NINE, 'Asia/Shanghai').label, '10-30 09:00');
  assert.equal(latestSlot(plan, minute, 15), minute);
  assert.equal(latestSlot(plan, minute + 14, 15), minute);
  assert.equal(latestSlot(plan, minute + 15, 15), null);
  assert.equal(latestSlot({ ...plan, timezone: 'UTC' }, minute, 15), null);
  assert.equal(latestSlot({ ...plan, weekdays: [1] }, minute, 15), null);
  assert.equal(nextSlot({ ...plan, weekdays: [1] }, minute), minute + 3 * 1440);
  const interval = { ...plan, mode: 'interval', intervalMinutes: 180 };
  assert.equal(latestSlot(interval, minute, 15), minute);
  assert.equal(latestSlot(interval, minute + 60, 15), null);
  // Local midnight is the anchor in every zone, including one that is not a whole hour from UTC.
  assert.equal(localClock(nextSlot({ ...interval, timezone: 'Asia/Kolkata' }, minute) * 60000, 'Asia/Kolkata').minuteOfDay % 180, 0);
  // 2026-11-01 repeats 01:00 in New York; the fall-back day is 25 hours long and keeps local 09:00.
  const ny = { ...plan, timezone: 'America/New_York' };
  assert.equal(localClock(nextSlot(ny, Date.parse('2026-11-01T05:00:00Z') / 60000) * 60000, ny.timezone).time, '09:00');
  const at = iso => Date.parse(iso) / 60000, night = { ...ny, times: ['01:30'] };
  assert.equal(latestSlot(night, at('2026-11-01T05:30:00Z'), 15), at('2026-11-01T05:30:00Z'));
  assert.equal(latestSlot(night, at('2026-11-01T06:30:00Z'), 15), null, 'the repeated 01:30 does not fire again');
  const hourly = { ...ny, mode: 'interval', intervalMinutes: 60 };
  assert.equal(latestSlot(hourly, at('2026-11-01T05:00:00Z'), 1), at('2026-11-01T05:00:00Z'));
  assert.equal(latestSlot(hourly, at('2026-11-01T06:00:00Z'), 1), at('2026-11-01T06:00:00Z'), 'an interval is real time, so the repeated hour still sends');
  for (const [timezone, first, second, time] of [['Australia/Lord_Howe', '2026-04-04T14:45:00Z', '2026-04-04T15:15:00Z', '01:45'], ['Antarctica/Troll', '2026-10-25T00:30:00Z', '2026-10-25T02:30:00Z', '02:30']]) {
    const plan = { ...ny, timezone, times: [time] };
    assert.equal(localClock(at(first) * 60000, timezone).time, localClock(at(second) * 60000, timezone).time, timezone);
    assert.equal(latestSlot(plan, at(first), 1), at(first), timezone);
    assert.equal(latestSlot(plan, at(second), 1), null, timezone);
  }
  assert.equal(nextSlot({ ...ny, times: ['02:30'] }, at('2027-03-14T05:00:00Z')), at('2027-03-15T06:30:00Z'), 'a skipped local time has no slot that day');
});

test('the digest honours section and metric choices and reports the worst level', () => {
  const items = [section('hub:a', 'ok', { metrics: [{ key: 'x', label: 'X', text: '1' }, { key: 'y', label: 'Y', text: '2' }] }), section('hub:b', 'alert', { issues: ['坏了'] }), section('hub:c', 'idle'), section('hub:d', 'warn')];
  const digest = buildDigest(items, defaults({ sections: { 'hub:a': { enabled: true, hidden: ['y'] }, 'hub:d': { enabled: false, hidden: [] } } }), AT_NINE);
  assert.deepEqual(digest.sections.map(item => item.id), ['hub:a', 'hub:b']);
  assert.deepEqual(digest.sections[0].metrics.map(item => item.key), ['x']);
  assert.equal(digest.level, 'alert');
  assert.equal(digest.attention.length, 1);
  assert.equal(buildDigest(items, defaults({ hideIdle: false, sections: { 'hub:b': { enabled: false, hidden: [] } } }), AT_NINE).level, 'warn');
  assert.equal(buildDigest([section('hub:a')], defaults(), AT_NINE).level, 'ok');
});

test('the card neutralizes names and stays inside the webhook size limit', () => {
  const config = defaults();
  const hostile = section('project:<at user_id="all">', 'ok', { name: '<at user_id="all"></at>*x*', metrics: [{ key: 'm', label: 'L', text: '<at user_id="all"></at>' }] });
  const { card } = renderCard(buildDigest([hostile], config, AT_NINE), config);
  const heading = card.elements.find(item => item.text?.tag === 'lark_md' && item.text.content.includes('&#60;at'));
  assert.ok(!heading.text.content.includes('<at'));
  assert.ok(!heading.text.content.includes('*x*'));
  const body = card.elements.find(item => item.text?.tag === 'plain_text' && item.text.content.includes('L：'));
  assert.ok(body, 'metric text is plain_text, so markup in it cannot act');
  const big = Array.from({ length: 40 }, (_, index) => section(`hub:s${index}`, 'ok', { metrics: Array.from({ length: 24 }, (_, row) => ({ key: `k${row}`, label: '指标'.repeat(20), text: '值'.repeat(80) })) }));
  const fitted = renderCard(buildDigest(big, config, AT_NINE), config);
  assert.ok(fitted.bytes <= 19 * 1024, `${fitted.bytes} bytes`);
  assert.ok(fitted.omitted > 0);
  assert.match(JSON.stringify(fitted.card), new RegExp(`另有 ${fitted.omitted} 个模块`));
  const noisy = Array.from({ length: 30 }, (_, index) => section(`hub:s${index}`, 'alert', { name: '模块', issues: Array.from({ length: 6 }, () => '错'.repeat(120)) }));
  assert.ok(renderCard(buildDigest(noisy, config, AT_NINE), config).bytes <= 19 * 1024);
});

test('a signed card matches the documented signature', async () => {
  const calls = [];
  await postCard({ webhookUrl: WEBHOOK, signingSecret: 'secret' }, { elements: [] }, { fetcher: okFetch(calls), now: 1599360473000 });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.msg_type, 'interactive');
  assert.equal(body.timestamp, '1599360473');
  assert.equal(body.sign, createHmac('sha256', '1599360473\nsecret').update('').digest('base64'));
  assert.equal(calls[0].init.redirect, 'error');
  await postCard({ webhookUrl: WEBHOOK, signingSecret: '' }, {}, { fetcher: okFetch(calls) });
  assert.equal(JSON.parse(calls[1].init.body).sign, undefined);
});

test('send failures separate a definite refusal from a possibly delivered message', async () => {
  const send = fetcher => postCard({ webhookUrl: WEBHOOK, signingSecret: '' }, {}, { fetcher });
  const reply = (status, json) => async () => ({ ok: status < 400, status, json });
  await assert.rejects(send(reply(200, async () => ({ code: 19024 }))), error => !error.uncertain && /关键词/.test(error.message));
  await assert.rejects(send(reply(200, async () => ({ code: 77 }))), error => !error.uncertain && /请检查机器人配置/.test(error.message));
  await assert.rejects(send(reply(400, async () => ({}))), error => !error.uncertain);
  await assert.rejects(send(reply(503, async () => ({}))), error => error.uncertain === true);
  await assert.rejects(send(reply(200, async () => { throw new Error('html'); })), error => error.uncertain === true);
  await assert.rejects(send(reply(200, async () => ({ StatusCode: 0 }))), error => error.uncertain === true);
  await assert.rejects(send(async () => { throw new Error('reset'); }), error => error.uncertain === true);
});

test('each slot goes out once, including across a restart', async () => {
  const { digest, clock, calls, dataDir } = manager({ at: AT_NINE - 60000 });
  enable(digest);
  assert.equal(digest.state().nextAt, new Date(AT_NINE).toISOString());
  clock.now = AT_NINE + 5000; digest.tick(); digest.tick(); await settled(digest);
  digest.tick(); await settled(digest);
  assert.equal(calls.length, 1);
  assert.equal(digest.state().history[0].status, 'sent');
  await digest.close();
  const reopened = manager({ dataDir, at: AT_NINE + 120000 });
  reopened.digest.tick(); await settled(reopened.digest);
  assert.equal(reopened.calls.length, 0);
  await reopened.digest.close();
});

// Keep the old durable state while making the atomic rename fail on both Windows and POSIX.
function blockStateWrite(dataDir, name = 'state.json') {
  const file = join(dataDir, 'feishu-digest', name), backup = `${file}.before-test`;
  renameSync(file, backup); mkdirSync(file);
  let restored = false;
  return () => {
    if (restored) return;
    rmdirSync(file); renameSync(backup, file); restored = true;
  };
}

test('a failed durable slot claim sends nothing and can retry once after storage recovers', async t => {
  const f = manager({ at: AT_NINE - 60000 });
  enable(f.digest);
  const restore = blockStateWrite(f.dataDir);
  t.after(async () => { restore(); await f.digest.close(); rmSync(f.dataDir, { recursive: true, force: true }); });
  f.clock.now = AT_NINE;
  f.digest.tick(); await settled(f.digest);
  f.digest.tick(); await settled(f.digest);
  assert.equal(f.calls.length, 0, 'no external request before the slot claim is durable');
  assert.match(f.digest.state().loadError, /状态.*保存|保存.*状态/);
  assert.deepEqual(f.digest.state().history, []);
  restore();
  f.clock.now += 60000;
  f.digest.tick(); await settled(f.digest);
  assert.equal(f.calls.length, 1, 'failed persistence must not consume the in-memory slot');
  assert.equal(f.digest.state().loadError, null);
  f.digest.tick(); await settled(f.digest);
  assert.equal(f.calls.length, 1);
  await f.digest.close();
  const reopened = manager({ dataDir: f.dataDir, at: AT_NINE + 120000 });
  try { reopened.digest.tick(); await settled(reopened.digest); assert.equal(reopened.calls.length, 0); }
  finally { await reopened.digest.close(); }
});

test('a failed durable schedule-save keeps the prior schedule and its unsent slot', async t => {
  const f = manager({ at: AT_NINE - 60000 });
  enable(f.digest);
  const oldConfig = f.digest.state().config, restore = blockStateWrite(f.dataDir);
  t.after(async () => { restore(); await f.digest.close(); rmSync(f.dataDir, { recursive: true, force: true }); });
  f.clock.now = AT_NINE;
  const next = { ...oldConfig, schedule: { ...oldConfig.schedule, times: ['10:00'] } };
  assert.throws(() => f.digest.save(next), error => error.status === 503);
  assert.deepEqual(f.digest.state().config, oldConfig);
  assert.deepEqual(JSON.parse(readFileSync(join(f.dataDir, 'feishu-digest', 'config.json'), 'utf8')), oldConfig);
  restore();
  f.digest.tick(); await settled(f.digest);
  assert.equal(f.calls.length, 1, 'the failed schedule change must not claim the old 09:00 slot');
  f.digest.save(next);
  assert.deepEqual(f.digest.state().config.schedule.times, ['10:00']);
});

test('a durable slot claim prevents restart duplication even if the send history cannot be saved', async t => {
  let f, restore, sends = 0;
  f = manager({ at: AT_NINE - 60000, manager: { fetcher: async () => {
    sends++; restore = blockStateWrite(f.dataDir);
    return { ok: true, status: 200, json: async () => ({ code: 0 }) };
  } } });
  t.after(async () => { restore?.(); await f.digest.close(); rmSync(f.dataDir, { recursive: true, force: true }); });
  enable(f.digest);
  f.clock.now = AT_NINE; f.digest.tick(); await settled(f.digest);
  assert.equal(sends, 1);
  assert.equal(f.digest.state().history[0].status, 'sent');
  assert.match(f.digest.state().loadError, /状态.*保存|保存.*状态/);
  restore(); await f.digest.close();
  const reopened = manager({ dataDir: f.dataDir, at: AT_NINE + 120000 });
  try { reopened.digest.tick(); await settled(reopened.digest); assert.equal(reopened.calls.length, 0); }
  finally { await reopened.digest.close(); }
});

test('a failed config write restores the old durable slot and keeps the prior plan sendable after restart', async t => {
  const f = manager({ at: AT_NINE - 60000 });
  enable(f.digest);
  const oldConfig = f.digest.state().config;
  const statePath = join(f.dataDir, 'feishu-digest', 'state.json');
  const before = JSON.parse(readFileSync(statePath, 'utf8'));
  const restore = blockStateWrite(f.dataDir, 'config.json');
  t.after(async () => { restore(); await f.digest.close(); rmSync(f.dataDir, { recursive: true, force: true }); });
  f.clock.now = AT_NINE;
  assert.throws(() => f.digest.save({ ...oldConfig, schedule: { ...oldConfig.schedule, times: ['10:00'] } }), error => error.status === 503);
  assert.deepEqual(f.digest.state().config, oldConfig);
  assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')), before, 'failed config replacement restores the durable claim');
  assert.equal(f.calls.length, 0);
  restore(); await f.digest.close();
  const reopened = manager({ dataDir: f.dataDir, at: AT_NINE + 60000 });
  try {
    assert.deepEqual(reopened.digest.state().config, oldConfig);
    reopened.digest.tick(); await settled(reopened.digest);
    assert.equal(reopened.calls.length, 1, 'the old 09:00 plan was not consumed by a failed edit');
    reopened.digest.tick(); await settled(reopened.digest); assert.equal(reopened.calls.length, 1);
  } finally { await reopened.digest.close(); }
});

test('a slot missed during a restart is delivered only inside the grace window', async () => {
  for (const [late, expected] of [[10, 1], [20, 0]]) {
    const first = manager({ at: AT_NINE - 60000 });
    enable(first.digest);
    await first.digest.close();
    const second = manager({ dataDir: first.dataDir, at: AT_NINE + late * 60000 });
    second.digest.tick(); await settled(second.digest);
    assert.equal(second.calls.length, expected, `${late} minutes late`);
    await second.digest.close();
  }
});

test('enabling or moving a schedule does not deliver a slot that already passed', async () => {
  const { digest, clock, calls } = manager({ at: AT_NINE + 120000 });
  enable(digest);
  digest.tick(); await settled(digest);
  assert.equal(calls.length, 0);
  digest.save(defaults({ enabled: true, schedule: { ...DIGEST_DEFAULTS.schedule, times: ['09:01'] } }));
  digest.tick(); await settled(digest);
  assert.equal(calls.length, 0);
  clock.now = AT_NINE + 3 * 3600000;
  digest.save(defaults({ enabled: true, schedule: { ...DIGEST_DEFAULTS.schedule, times: ['12:01'] } }));
  clock.now += 60000; digest.tick(); await settled(digest);
  assert.equal(calls.length, 1);
  await digest.close();
});

test('a definite refusal retries a bounded number of times; an uncertain send never does', async () => {
  const refused = [];
  const failing = manager({ at: AT_NINE - 60000, manager: { fetcher: async (url, init) => { refused.push(init); return { ok: true, status: 200, json: async () => ({ code: 11232 }) }; } } });
  enable(failing.digest);
  failing.clock.now = AT_NINE;
  for (let round = 0; round < 6; round++) { failing.digest.tick(); await settled(failing.digest); failing.clock.now += 60000; }
  assert.equal(refused.length, 3);
  assert.equal(failing.digest.state().history[0].status, 'failed');
  assert.match(failing.digest.state().history[0].error, /频率受限/);
  await failing.digest.close();
  const lost = [];
  const unknown = manager({ at: AT_NINE - 60000, manager: { fetcher: async (url, init) => { lost.push(init); throw new Error('timeout'); } } });
  enable(unknown.digest);
  unknown.clock.now = AT_NINE;
  for (let round = 0; round < 4; round++) { unknown.digest.tick(); await settled(unknown.digest); unknown.clock.now += 60000; }
  assert.equal(lost.length, 1);
  assert.equal(unknown.digest.state().history[0].status, 'uncertain');
  await unknown.digest.close();
});

test('a retry from a send that was under way does not survive disabling or clearing', async () => {
  let release;
  const reads = [], refused = [];
  const hold = () => new Promise(resolve => { release = () => resolve([section('hub:a')]); });
  const { digest, clock } = manager({ at: AT_NINE - 60000, manager: { readSections: () => { reads.push(1); return hold(); }, fetcher: async (url, init) => { refused.push(init); return { ok: true, status: 200, json: async () => ({ code: 11232 }) }; } } });
  enable(digest);
  clock.now = AT_NINE; digest.tick();
  await new Promise(resolve => setImmediate(resolve));
  digest.save(defaults({ enabled: false }));
  release(); await settled(digest);
  assert.equal(refused.length, 1);
  assert.equal(digest.state().history[0].status, 'failed');
  clock.now = AT_NINE + 120000;
  digest.save(defaults({ enabled: true, schedule: { ...DIGEST_DEFAULTS.schedule, times: ['23:00'] } }));
  clock.now += 120000; digest.tick(); await settled(digest);
  assert.equal(refused.length, 1, 'the cancelled slot is not retried after enabling again');
  await digest.close();
});

test('changing the schedule during a send drops the retry of its old slot', async () => {
  let release;
  const refused = [];
  const { digest, clock } = manager({ at: AT_NINE - 60000, manager: { readSections: () => new Promise(resolve => { release = () => resolve([section('hub:a')]); }), fetcher: async (url, init) => { refused.push(init); return { ok: true, status: 200, json: async () => ({ code: 11232 }) }; } } });
  enable(digest);
  clock.now = AT_NINE; digest.tick();
  await new Promise(resolve => setImmediate(resolve));
  digest.save(defaults({ enabled: true, schedule: { ...DIGEST_DEFAULTS.schedule, times: ['23:00'] } }));
  release(); await settled(digest);
  clock.now += 120000; digest.tick(); await settled(digest);
  assert.equal(refused.length, 1);
  await digest.close();
});

test('clearing the webhook or closing while reading sends nothing and records nothing', async () => {
  const posted = [];
  const hanging = () => new Promise(() => {});
  const first = manager({ at: AT_NINE - 60000, manager: { readSections: hanging, fetcher: async (url, init) => { posted.push(init); return { ok: true, status: 200, json: async () => ({ code: 0 }) }; } } });
  enable(first.digest);
  first.clock.now = AT_NINE; first.digest.tick();
  await new Promise(resolve => setImmediate(resolve));
  first.digest.clearChannel();
  await settled(first.digest);
  assert.equal(posted.length, 0);
  assert.deepEqual(first.digest.state().history, []);
  await first.digest.close();
  const second = manager({ at: AT_NINE - 60000, manager: { readSections: hanging } });
  enable(second.digest);
  second.clock.now = AT_NINE; second.digest.tick();
  await new Promise(resolve => setImmediate(resolve));
  await second.digest.close();
  assert.deepEqual(second.digest.state().history, []);
});

test('previews share one read until it expires, and a failed read is not kept', async () => {
  let reads = 0, broken = false;
  const { digest, clock } = manager({ manager: { readSections: async () => { reads++; if (broken) throw new Error('down'); return [section('hub:a')]; } } });
  await digest.preview(defaults()); await digest.preview(defaults({ title: '另一个' }));
  assert.equal(reads, 1);
  clock.now += 15000; broken = true;
  await assert.rejects(digest.preview(defaults()));
  broken = false;
  await digest.preview(defaults());
  assert.equal(reads, 3);
  await digest.preview(defaults(), { fresh: true });
  assert.equal(reads, 4);
  await digest.close();
});

test('attention-only mode skips a quiet digest but not one with a problem or a manual send', async () => {
  let level = 'ok';
  const { digest, clock, calls } = manager({ at: AT_NINE - 60000, manager: { readSections: async () => [section('hub:a', level)] } });
  digest.setChannel({ webhookUrl: WEBHOOK, signingSecret: '' });
  digest.save(defaults({ enabled: true, onlyOnAttention: true, schedule: { ...DIGEST_DEFAULTS.schedule, times: ['09:00', '09:05'] } }));
  clock.now = AT_NINE; digest.tick(); await settled(digest);
  assert.equal(calls.length, 0);
  assert.equal(digest.state().history[0].status, 'skipped');
  clock.now = AT_NINE + 60000 * 5; digest.save(defaults({ enabled: true, onlyOnAttention: true, schedule: { ...DIGEST_DEFAULTS.schedule, times: ['09:00', '09:05', '09:06'] } }));
  clock.now += 60000; digest.tick(); await settled(digest);
  assert.equal(digest.state().history.length, 1, 'consecutive skips collapse so failures stay visible');
  clock.now = AT_NINE;
  assert.equal((await digest.send()).result.status, 'sent');
  assert.equal(calls.length, 1);
  level = 'alert'; digest.save(defaults({ enabled: true, onlyOnAttention: true, schedule: { ...DIGEST_DEFAULTS.schedule, times: ['09:20'] } })); clock.now = AT_NINE + 20 * 60000; digest.tick(); await settled(digest);
  assert.equal(calls.length, 2);
  await digest.close();
});

test('the webhook is stored encrypted, never returned, and clearing it stops the schedule', async () => {
  const { digest, dataDir } = manager();
  assert.throws(() => digest.save(defaults({ enabled: true })), error => error.status === 409);
  await assert.rejects(digest.send(), error => error.status === 409);
  digest.setChannel({ webhookUrl: WEBHOOK, signingSecret: 'sign-secret' });
  digest.save(defaults({ enabled: true }));
  const stored = readFileSync(join(dataDir, 'feishu-digest', 'channel.json'), 'utf8');
  assert.ok(!stored.includes('abc-123') && !stored.includes('sign-secret'));
  const visible = JSON.stringify(digest.state());
  assert.ok(!visible.includes('abc-123') && !visible.includes('sign-secret'));
  assert.equal(digest.state().channel.host, 'open.feishu.cn');
  assert.ok(digest.state().nextAt);
  const cleared = digest.clearChannel();
  assert.equal(cleared.config.enabled, false);
  assert.equal(cleared.nextAt, null);
  assert.ok(!existsSync(join(dataDir, 'feishu-digest', 'channel.json')));
  await digest.close();
});

test('unreadable saved files disable sending instead of crashing or guessing', async () => {
  const first = manager();
  enable(first.digest);
  await first.digest.close();
  const directory = join(first.dataDir, 'feishu-digest');
  writeFileSync(join(directory, 'config.json'), '{broken');
  writeFileSync(join(directory, 'channel.json'), JSON.stringify({ value: 'not-a-ciphertext' }));
  writeFileSync(join(directory, 'state.json'), '{broken');
  const second = manager({ dataDir: first.dataDir });
  const state = second.digest.state();
  assert.equal(state.config.enabled, false);
  assert.match(state.loadError, /无法读取/);
  assert.match(state.channel.error, /重新填写/);
  assert.equal(state.channel.configured, false);
  await second.digest.close();
});

const project = (extra = {}) => ({ project: { id: 'aster', name: 'ASTER', adapter: 'aster', enabled: true }, state: 'online', message: '', updatedAt: new Date(AT_NINE - 1000).toISOString(), diagnostics: [], metrics: [], ...extra });
test('a project section keeps units and missing values and follows the overview delay', () => {
  const section = projectSection(project({ metrics: [{ key: 'a', label: '余额', value: 1250.5, unit: 'USD' }, { key: 'b', label: '费率', value: 2.5, unit: '%' }, { key: 'c', label: '待处理', value: null, unit: '个' }, { key: 'd', label: '零', value: 0, unit: 'USD' }] }), AT_NINE);
  assert.deepEqual(section.metrics.map(item => item.text), ['1,250.5 USD', '2.5%', '—', '0 USD']);
  assert.equal(section.level, 'ok');
  assert.equal(section.asOf, AT_NINE - 1000);
  const fresh = projectSection(project({ state: 'offline', diagnostics: [{ id: 'hub:connection', kind: 'fault', message: '连接失败', firstSeenAt: new Date(AT_NINE - 60000).toISOString() }] }), AT_NINE);
  assert.equal(fresh.level, 'notice');
  assert.deepEqual(fresh.issues, []);
  const held = projectSection(project({ state: 'offline', diagnostics: [{ id: 'hub:connection', kind: 'fault', message: '连接失败', firstSeenAt: new Date(AT_NINE - 200000).toISOString() }] }), AT_NINE);
  assert.equal(held.level, 'alert');
  assert.deepEqual(held.issues, ['连接失败']);
  const stale = projectSection(project({ state: 'stale', diagnostics: [{ id: 'hub:data-freshness', kind: 'fault', message: '数据已过期', firstSeenAt: new Date(AT_NINE - 200000).toISOString() }] }), AT_NINE);
  assert.equal(stale.level, 'warn');
  assert.equal(stale.status, '数据过期');
  assert.equal(projectSection(project({ state: 'partial', diagnostics: [{ id: 'x', kind: 'notice', message: '提示', firstSeenAt: '' }] }), AT_NINE).level, 'notice');
  assert.equal(projectSection(project({ state: 'unauthorized', diagnostics: [{ id: 'hub:auth', kind: 'action', message: '请重新登录', firstSeenAt: '' }] }), AT_NINE).level, 'alert');
  assert.equal(projectSection(project({ state: 'disabled' }), AT_NINE).level, 'idle');
  assert.deepEqual(projectSection(project({ state: 'offline', diagnostics: undefined, message: undefined }), AT_NINE).issues, ['项目状态异常，请进入项目查看']);
});

const position = (extra = {}) => ({ symbol: 'CLUSDT', side: 'long', quantity: '10', quantityUnit: '桶', notional: '700', unrealizedPnl: '3.2', pnlCurrency: 'USDT', cycle: { status: 'complete', net: '-1.5', currency: 'USDT' }, ...extra });
const positions = (scopes, extra = {}) => ({ sources: [{ name: 'Asset', error: null, data: { exchanges: [{ name: 'Binance', accounts: [{ scopes }] }] }, ...extra }] });
test('position totals stay per currency and say when they are incomplete', () => {
  const full = positionsSection(positions([{ label: 'U 本位', status: 'live', fetchedAt: new Date(AT_NINE).toISOString(), positions: [position(), position({ symbol: 'BZUSDT', side: 'short', notional: '900', unrealizedPnl: '-1', pnlCurrency: 'USDC', cycle: null })] }]));
  const value = key => full.metrics.find(item => item.key === key);
  assert.equal(full.level, 'ok');
  assert.equal(value('pnl').text, '+3.2 USDT / -1 USDC');
  assert.equal(value('cycleNet').text, '-1.5 USDT（1 笔未计入）');
  assert.deepEqual(value('positions').groups.map(group => group.title), ['Binance（2 笔）']);
  assert.deepEqual(value('positions').groups[0].rows[0], { symbol: 'BZUSDT', side: '空', quantity: '10 桶', pnl: '-1 USDC' });
  const broken = positionsSection(positions([{ label: 'U 本位', status: 'error', fetchedAt: null, error: '接口失败', positions: [position()] }]));
  const quoted = positionsSection(positions([{ label: 'U 本位', status: 'error', fetchedAt: null, error: '请求失败 https://rpc.example/v2/key-123?token=abc 超时', positions: [] }]));
  assert.deepEqual(quoted.issues, ['Binance U 本位：请求失败 [地址已隐藏] 超时']);
  assert.equal(broken.level, 'warn');
  assert.deepEqual(broken.issues, ['Binance U 本位：接口失败']);
  assert.match(broken.metrics[0].text, /来源不完整/);
  const missing = positionsSection(positions([{ label: 'U 本位', status: 'live', fetchedAt: null, positions: [position({ unrealizedPnl: null })] }]));
  assert.equal(missing.metrics.find(item => item.key === 'pnl').text, '—');
  assert.equal(positionsSection({ sources: [] }).level, 'idle');
  const partial = positionsSection(positions([{ label: 'U 本位', status: 'live', fetchedAt: null, positions: [position({ cycle: { status: 'partial', net: '9', currency: 'USDT' } })] }]));
  assert.equal(partial.metrics.find(item => item.key === 'cycleNet').text, '—', 'a partial cycle is not a total');
  // A source nobody set up is not a fault; the Asset project section already says so.
  assert.equal(positionsSection({ sources: [{ name: 'Asset', status: 'unconfigured', error: '请保存地址', data: null }] }).level, 'idle');
  const many = positionsSection(positions([{ label: 'U', status: 'live', fetchedAt: null, positions: Array.from({ length: 15 }, (_, index) => position({ symbol: `S${index}` })) }]));
  assert.equal(many.metrics.at(-1).text, '15 项');
  assert.equal(many.metrics.at(-1).groups[0].rows.length, 15);
  const mixed = positionsSection({ sources: [{ name: 'Asset', error: null, data: { exchanges: [
    { name: 'Binance', accounts: [{ scopes: [{ label: 'U', status: 'live', fetchedAt: null, positions: [position({ symbol: 'A', notional: '1' }), position({ symbol: 'B', notional: '-9' })] }] }, { scopes: [{ label: 'U', status: 'live', fetchedAt: null, positions: [position({ symbol: 'C', notional: '5' })] }] }] },
    { name: 'Aster', accounts: [{ scopes: [{ label: 'U', status: 'live', fetchedAt: null, positions: [position({ symbol: 'D' })] }] }] }] } }] }).metrics.at(-1);
  assert.deepEqual(mixed.groups.map(group => [group.title, group.rows.map(row => row.symbol)]), [['Aster（1 笔）', ['D']], ['Binance（3 笔）', ['B', 'C', 'A']]]);
  const config = defaults(), { elements } = renderCard(buildDigest([{ ...many, metrics: [mixed] }], config, AT_NINE), config).card;
  const tables = elements.filter(element => element.tag === 'table');
  assert.deepEqual(tables.map(element => element.rows.map(row => row.symbol)), [['D'], ['B', 'C', 'A']]);
  assert.deepEqual(tables[0].columns.map(column => [column.name, column.display_name, column.data_type]), [['symbol', '合约', 'text'], ['side', '方向', 'text'], ['quantity', '数量', 'text'], ['pnl', '浮动盈亏', 'text']]);
  assert.ok(tables.every(element => element.page_size <= 10));
  assert.equal(elements[elements.indexOf(tables[0]) - 1].text.content, '**Aster（1 笔）**', 'each table sits under its exchange');
  const sixth = { key: 'positions', label: '持仓明细', text: '6 项', groups: ['A', 'B', 'C', 'D', 'E', 'F'].map(name => ({ title: `${name}（16 笔）`, columns: mixed.groups[0].columns, rows: Array.from({ length: 16 }, () => ({ symbol: `${name}USDT`, side: '多', quantity: '1', pnl: '+1' })) })) };
  const overflow = renderCard(buildDigest([{ ...many, metrics: [sixth] }], config, AT_NINE), config).card.elements;
  const shown = overflow.filter(element => element.tag === 'table');
  assert.equal(shown.length, 5, 'Feishu refuses a sixth table');
  assert.equal(shown.at(-1).rows.length, 16, 'long tables page instead of losing rows');
  assert.equal(overflow.at(-3).text.tag, 'plain_text');
  assert.match(overflow.at(-3).text.content, /^F（16 笔）\n  FUSDT · 多 · 1 · \+1\n/);
  assert.equal(positionsSection(positions([{ label: 'U', status: 'live', fetchedAt: null, positions: [] }])).metrics.at(-1).text, '无');
});

test('funding, execution, Aero and research sections show their own state', () => {
  const account = { exchange: 'binance', name: 'Binance', connected: true, positions: { state: 'live', error: null }, funding: { state: 'live', error: null } };
  const funding = (extra = {}) => ({ strategy: { name: '原油四腿资金费套利' }, exchanges: ['binance', 'bybit'], accounts: [account, { ...account, exchange: 'bybit', name: 'Bybit' }], funding: { complete: true, net: '12.5', currency: 'USDT' }, pnl: { latest: { time: AT_NINE, unrealizedPnl: null, totalPnl: '30' } }, ...extra });
  const ok = fundingSection(funding());
  assert.deepEqual(ok.metrics.map(item => item.text), ['+12.5 USDT', '— USDT', '+30 USDT']);
  assert.equal(ok.asOf, AT_NINE);
  assert.equal(fundingSection(funding({ pnl: { status: 'incomplete', latest: { time: AT_NINE, unrealizedPnl: null, totalPnl: null } } })).asOf, null, 'an expired curve must not look fresh');
  assert.equal(fundingSection(funding({ accounts: [{ ...account, connected: false }] })).level, 'idle');
  assert.equal(fundingSection(funding({ accounts: [account, { ...account, exchange: 'bybit', name: 'Bybit', positions: { state: 'stale', error: null } }], funding: { complete: false, net: null } })).level, 'warn');

  const job = (status, reason = null) => ({ market: 'oil', action: 'open', status, batchIndex: 1, batchCount: 3, reason });
  const execution = jobs => ({ generatedAt: new Date(AT_NINE).toISOString(), connections: [{ connected: true }, { connected: false }], positions: [{}], jobs });
  assert.equal(executionSection({ ...execution([]), connections: [{ connected: false }] }).level, 'idle');
  assert.equal(executionSection(execution([job('completed')])).level, 'ok');
  assert.equal(executionSection(execution([])).asOf, null);
  assert.equal(executionSection({ ...execution([]), positions: [{ fetchedAt: new Date(AT_NINE - 9000).toISOString() }, { fetchedAt: new Date(AT_NINE).toISOString() }] }).asOf, AT_NINE - 9000);
  assert.equal(executionSection(execution([job('running')])).status, '任务运行中');
  assert.equal(executionSection(execution([job('paused')])).level, 'warn');
  const attention = executionSection(execution([job('attention', '委托待核对')]));
  assert.equal(attention.level, 'alert');
  assert.match(attention.issues[0], /委托待核对/);

  const cycle = { at: new Date(AT_NINE - 1000).toISOString(), symbols: ['WETH', 'USDC'], price: 3500.5, positions: [{ liquidity: '0' }, { liquidity: '5', staked: true, state: 'in', value: 1000, apr: 0.125, aeroPerDay: 2, feeApr: null }], rewards: { pending: '1.5' } };
  const aero = extra => ({ enabled: true, state: 'running', error: null, paused: false, lastCycle: cycle, ledger: { reward: '4', gasEth: '0.01' }, config: { intervalSec: 60 }, ...extra });
  const running = aeroSection(aero(), AT_NINE);
  assert.equal(running.level, 'ok');
  assert.equal(running.metrics.find(item => item.key === 'apr').text, '12.5%');
  assert.equal(running.metrics.find(item => item.key === 'feeApr').text, '—');
  assert.equal(running.metrics.find(item => item.key === 'range').text, '区间内');
  assert.equal(aeroSection(aero({ enabled: false, state: 'stopped' }), AT_NINE).level, 'idle');
  assert.equal(aeroSection(aero({ state: 'fault', error: '私钥无法读取' }), AT_NINE).level, 'alert');
  assert.equal(aeroSection(aero(), AT_NINE + 3600000).level, 'warn');
  assert.equal(aeroSection(aero({ paused: true }), AT_NINE + 3600000).level, 'notice');

  assert.equal(researchSection({ enabled: false, state: 'stopped' }).level, 'idle');
  assert.equal(researchSection({ enabled: true, state: 'running', stale: false, error: null, insights: { asOf: AT_NINE, summary: { title: '无优势' }, leader: { title: 'SNDK', samples: 12 } } }).metrics[2].text, '12');
  assert.equal(researchSection({ enabled: true, state: 'running', stale: true, error: null, insights: null }).level, 'warn');
});

test('Aero digest uses the common wallet total instead of one independently estimated position', () => {
  const cycle = { at: new Date(AT_NINE).toISOString(), symbols: ['RSGP', 'USDC'], positions: [
    { liquidity: '200', staked: true, state: 'below', aeroPerDay: 57600, aeroPerDayEstimated: true },
    { liquidity: '200', staked: true, state: 'below', aeroPerDay: 57600, aeroPerDayEstimated: true },
  ], rewards: { dailyTotal: { perDay: 69120, scenario: 'same-lower', reason: null } } };
  const value = () => aeroSection({ enabled: true, state: 'running', paused: false, lastCycle: cycle, config: { intervalSec: 60 } }, AT_NINE).metrics.find(item => item.key === 'aeroPerDay').text;
  assert.equal(value(), '69,120（同下沿估计，假设其他活跃流动性不变）');
  for (const reason of ['different-lower', 'mixed-ranges']) {
    cycle.rewards.dailyTotal = { perDay: null, scenario: null, reason };
    assert.equal(value(), '—（逐仓独立估计，不合计）');
  }
  cycle.rewards.dailyTotal = { perDay: 0, scenario: 'no-emissions', reason: null };
  assert.equal(value(), '0');
  delete cycle.rewards.dailyTotal;
  assert.equal(value(), '—', 'old snapshots must not silently fall back to one position');
});

test('one failing source costs only its own section', async () => {
  const sections = await collectSections({ log: silent, now: () => AT_NINE, overview: () => ({ projects: [project(), { ...project(), project: { id: 'link', name: 'Link', adapter: 'link', enabled: true } }] }),
    positions: async () => { throw new Error('secret upstream text'); }, funding: () => { throw new Error('boom'); }, execution: () => ({ connections: [], positions: [], jobs: [] }),
    aero: () => ({ enabled: false, state: 'stopped' }), research: () => ({ enabled: false, state: 'stopped' }) });
  assert.deepEqual(sections.map(item => item.id), ['hub:positions', 'hub:funding', 'hub:execution', 'hub:aero-lp', 'hub:research', 'project:aster']);
  assert.equal(sections[0].status, '读取失败');
  assert.ok(!JSON.stringify(sections).includes('secret upstream text'));
});

test('workbench routes require the session and never expose the webhook', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'feishu-digest-app-'));
  const app = await createApp({ dataDir: directory, initialPassword: 'feishu-digest-fixture-password', refreshInterval: 0, assetSyncIntervalMs: 0, tradingRefreshIntervalMs: 0, executionIntervalMs: 0, baselineIntervalMs: 0, logger: silent, warmupEnabled: false });
  try {
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${app.server.address().port}`, route = '/api/automation/feishu-digest';
    for (const [suffix, method] of [['', 'GET'], ['/config', 'PUT'], ['/channel', 'PUT'], ['/channel/clear', 'POST'], ['/preview', 'POST'], ['/send', 'POST']]) assert.equal((await fetch(origin + route + suffix, { method })).status, 401, suffix);
    const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'feishu-digest-fixture-password' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0], { csrfToken } = await login.json();
    const request = (suffix = '', method = 'GET', body, headers = {}) => fetch(origin + route + suffix, { method, headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrfToken, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const secret = { webhookUrl: WEBHOOK, signingSecret: 'fixture-sign' };
    assert.equal((await request('/channel', 'PUT', secret, { 'X-CSRF-Token': '' })).status, 403);
    assert.equal((await request('/channel', 'PUT', secret, { Origin: 'https://wrong.example' })).status, 403);
    assert.equal((await request('', 'GET', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await request('?x=1')).status, 400);
    assert.equal((await request('/missing', 'POST', {})).status, 404);
    assert.equal((await request('/channel', 'PUT', { webhookUrl: 'https://evil.example/x', signingSecret: '' })).status, 400);
    assert.equal((await request('/config', 'PUT', { config: defaults({ enabled: true }) })).status, 409);
    assert.equal((await request('/send', 'POST', { extra: 1 })).status, 400);
    const saved = await request('/channel', 'PUT', secret);
    assert.equal(saved.status, 200);
    const text = await saved.text();
    assert.ok(!text.includes('abc-123') && !text.includes('fixture-sign'));
    assert.equal(JSON.parse(text).channel.host, 'open.feishu.cn');
    assert.equal((await request('/config', 'PUT', { config: defaults({ enabled: true, title: '日报' }) })).status, 200);
    const preview = await (await request('/preview', 'POST', { config: defaults({ hideIdle: false }) })).json();
    assert.equal(preview.digest.level, 'ok');
    assert.ok(preview.catalog.some(item => item.id === 'hub:positions'));
    assert.equal(preview.omitted, 0);
    assert.equal((await (await request('')).json()).config.title, '日报');
    assert.equal((await request('/preview', 'POST', { config: { enabled: true } })).status, 400);
    assert.equal((await request('/preview', 'POST', { config: defaults(), fresh: true })).status, 200);
    assert.equal((await request('/preview', 'POST', { config: defaults(), fresh: 'yes' })).status, 400);
    assert.equal((await request('/config', 'PUT', { config: defaults(), fresh: true })).status, 400);
  } finally { await app.close(); }
});
