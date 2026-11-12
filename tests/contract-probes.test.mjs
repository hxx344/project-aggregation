import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';
import { openHubDatabase } from '../server/control/schema.mjs';
import { createControlStore } from '../server/control/store.mjs';
import { createExecutionEntries, createExecutionJobsReader } from '../server/control/execution-jobs.mjs';
import { createContractProbes, LIVE_WINDOW_MS } from '../server/contract-probes.mjs';
import { createUpdateCoordinator, unavailableUpdateState } from '../server/updates.mjs';

// A stand-in for the probe scripts: same flags, console lines and exit codes, no network.
// --settle-timeout-s selects what a run does: 11 waits for a stop, 12 exits 1, 13 exits 2, 14 aborts a read-only run,
// 15 waits without handling the stop signal (it ends with no exit code).
const FAKE = `
import { closeSync, openSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2), value = name => { const at = argv.indexOf(name); return at < 0 ? undefined : argv[at + 1]; };
const out = value('--out'), live = argv.includes('--live'), mode = value('--settle-timeout-s');
closeSync(openSync(out, 'wx'));
const phrase = 'fake-' + (value('--symbol') ?? value('--a-prefix'));
const report = outcome => writeFileSync(out, JSON.stringify({ argv, cwd: process.cwd(), env: Object.keys(process.env).sort(), outcome }));
process.stdout.write('[t] 读取账户\\n');
const done = (code, outcome) => { report(outcome); process.stdout.write('\\n结果：' + outcome + '\\n报告已写入 ' + out + '\\n'); process.exit(code); };
if (!live) {
  if (value('--step') === 'check') { report('read-only'); process.stdout.write('\\n结果：检查通过\\n'); process.exit(0); }
  if (mode === '14') { process.stderr.write('已中止：没有保存账户\\n'); process.exit(1); }
  report('read-only');
  process.stdout.write('\\n只读检查完成，未发送任何委托。真实追价需加：--live --confirm ' + phrase + '（加 --allow-fill 会另发一笔）\\n');
  process.exit(0);
}
if (value('--confirm') !== phrase) { process.stderr.write('已中止：确认短语不符\\n'); process.exit(1); }
if (mode === '11') { process.on('SIGTERM', () => done(2, '已中断，请核对')); setInterval(() => {}, 1000); }
else if (mode === '15') setInterval(() => {}, 1000);
else done(mode === '12' ? 1 : mode === '13' ? 2 : 0, mode === '12' ? '未发送' : mode === '13' ? '有残留' : 'complete');
`;

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'contract-probes-'));
  const script = path.join(dataDir, 'fake-probe.mjs');
  await writeFile(script, FAKE);
  const holds = [];
  const f_probes = [];
  let clock = Date.UTC(2026, 10, 12, 3), maintenance = false, blocked = null, refuse = false;
  const create = () => createContractProbes({ dataDir, scripts: { bybit: script, aster: script, canary: script }, now: () => clock, readMaintenance: () => maintenance, liveBlocker: probe => (f_probes.push(probe), blocked), platform: 'linux',
    admit: () => { if (refuse) throw Object.assign(new Error('maintenance'), { status: 409 }); const hold = { released: false, abandoned: false, release() { hold.released = true; }, abandon() { hold.abandoned = true; } }; holds.push(hold); return hold; }, ...options });
  let probes = create();
  t.after(async () => { await probes.idle(); probes.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, holds, options, blockerCalls: f_probes, get probes() { return probes; }, reopen() { probes.close(); probes = create(); return probes; },
    advance(ms) { clock += ms; }, set maintenance(value) { maintenance = value; }, set blocked(value) { blocked = value; }, set refuse(value) { refuse = value; },
    async readOnly(params = { symbol: 'CLUSDT' }, probe = 'bybit') { probes.start({ probe, params }); await probes.idle(); return probes.state().runs[0]; } };
}
const status = (action, code) => assert.throws(action, error => error.status === code, `expected HTTP ${code}`);

test('只读运行给出确认短语、进度与报告；路径由服务端固定，子进程环境不带工作台的环境变量', async t => {
  const f = await fixture(t, { environment: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, DATA_DIR: 'leak', INITIAL_PASSWORD: 'leak' } });
  const run = await f.readOnly({ symbol: 'BZUSDT', maxNotional: '120.5', allowFill: true });
  assert.equal(run.status, 'completed'); assert.equal(run.mode, 'read-only'); assert.equal(run.exitCode, 0); assert.equal(run.phrase, 'fake-BZUSDT');
  assert.deepEqual(run.params, { symbol: 'BZUSDT', maxNotional: '120.5', passiveBps: 200, allowFill: true, settleTimeoutS: 60 });
  assert.ok(run.log.some(line => line.includes('读取账户')) && run.hasReport);
  const { report } = f.probes.report(run.id), directory = path.join(f.dataDir, 'contract-probes');
  assert.deepEqual(report.argv, ['--symbol', 'BZUSDT', '--data-dir', f.dataDir, '--max-notional', '120.5', '--passive-bps', '200', '--settle-timeout-s', '60', '--out', path.join(directory, `${run.id}.json`), '--allow-fill']);
  assert.equal(report.cwd, directory);
  assert.ok(!report.env.includes('DATA_DIR') && !report.env.includes('INITIAL_PASSWORD'));
  assert.equal(f.holds.length, 0, 'a read-only run takes no update hold');
  assert.ok(!JSON.stringify(f.probes.state()).includes(directory), 'the page never sees server paths');
});

test('请求参数只接受白名单：标的、金额上限、路径与确认短语都不能由请求指定', async t => {
  const f = await fixture(t);
  for (const body of [{ probe: 'okx', params: {} }, { probe: 'bybit' }, { probe: 'bybit', params: { symbol: 'BTCUSDT' } }, { probe: 'bybit', params: { symbol: 'CLUSDT', maxNotional: '200.01' } },
    { probe: 'bybit', params: { symbol: 'CLUSDT', maxNotional: 50 } }, { probe: 'bybit', params: { symbol: 'CLUSDT', settleTimeoutS: 301 } }, { probe: 'bybit', params: { symbol: 'CLUSDT', passiveBps: 49 } },
    { probe: 'bybit', params: { symbol: 'CLUSDT', dataDir: '/tmp' } }, { probe: 'bybit', params: { symbol: 'CLUSDT', out: '/tmp/x' } }, { probe: 'bybit', params: { symbol: 'CLUSDT', confirm: 'x' } },
    { probe: 'bybit', params: { symbol: 'CLUSDT', live: true } }, { probe: 'bybit', params: { symbol: 'CLUSDT' }, live: true }, { probe: 'bybit', params: { symbol: 'CLUSDT', allowFill: 'yes' } }])
    status(() => f.probes.start(body), 400);
  assert.equal(f.probes.state().runs.length, 0);
});

test('ASTER 账户只能从模块 .env 已配置齐全的前缀里选；状态里只有前缀名，没有任何取值', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.probes.state().options.aster.prefixes, []);
  status(() => f.probes.start({ probe: 'aster', params: { masterPrefix: 'MA', aPrefix: 'SA', bPrefix: 'SB' } }), 400);
  await mkdir(path.join(f.dataDir, 'modules', 'aster'), { recursive: true });
  const secret = '0x' + 'ab'.repeat(32);
  await writeFile(path.join(f.dataDir, 'modules', 'aster', '.env'), ['MA', 'SA', 'SB'].map(prefix => `${prefix}_USER=0x${'1'.repeat(40)}\n${prefix}_SIGNER=0x${'2'.repeat(40)}\nexport ${prefix}_PRIVATE_KEY=${secret}`).join('\n')
    + `\nHALF_USER=0x${'3'.repeat(40)}\nHALF_SIGNER=0x${'4'.repeat(40)}\nOTHER=1\n`);
  const state = f.probes.state();
  assert.deepEqual(state.options.aster.prefixes, ['MA', 'SA', 'SB']);
  assert.ok(!JSON.stringify(state).includes(secret) && !JSON.stringify(state).includes('1'.repeat(40)));
  const base = { masterPrefix: 'MA', aPrefix: 'SA', bPrefix: 'SB' };
  for (const params of [{ ...base, aPrefix: 'HALF' }, { ...base, bPrefix: 'SA' }, { ...base, amount: '5.01' }, { ...base, probeNonce: [0] }, { ...base, probeNonce: [601] }, { ...base, probeNonce: [-30, -30] },
    { ...base, probeNonce: [1, 2, 3, 4, 5, 6, 7, 8, 9] }, { ...base, probeNonce: '-30' }, { ...base, settleTimeoutS: 901 }, { ...base, envFile: '/etc/passwd' }])
    status(() => f.probes.start({ probe: 'aster', params }), 400);
  const run = await f.readOnly({ ...base, amount: '1.5', probeNonce: [-30, 61], balancerPaused: true }, 'aster');
  assert.equal(run.status, 'completed'); assert.equal(run.phrase, 'fake-SA');
  assert.deepEqual(f.probes.report(run.id).report.argv, ['--env-file', path.join(f.dataDir, 'modules', 'aster', '.env'), '--master-prefix', 'MA', '--a-prefix', 'SA', '--b-prefix', 'SB', '--amount', '1.5',
    '--settle-timeout-s', '300', '--history-minutes', '30', '--out', path.join(f.dataDir, 'contract-probes', `${run.id}.json`), '--probe-nonce=-30,61', '--balancer-paused']);
});

test('真实运行只能来自最近一次成功的只读检查：需要勾选确认与页面显示的短语，沿用同一组参数并占用更新', async t => {
  const f = await fixture(t);
  const failed = await f.readOnly({ symbol: 'CLUSDT', settleTimeoutS: 14 });
  assert.equal(failed.status, 'failed'); assert.equal(failed.phrase, null); assert.equal(failed.error, '没有保存账户');
  status(() => f.probes.live(failed.id, { confirmLive: true, phrase: 'fake-CLUSDT' }), 409);
  const source = await f.readOnly({ symbol: 'CLUSDT', maxNotional: '80' });
  status(() => f.probes.live(source.id, { phrase: source.phrase }), 400);
  status(() => f.probes.live(source.id, { confirmLive: true, phrase: source.phrase, params: { symbol: 'BZUSDT' } }), 400);
  status(() => f.probes.live(source.id, { confirmLive: true, phrase: 'fake-BZUSDT' }), 409);
  status(() => f.probes.live('00000000-0000-4000-8000-000000000000', { confirmLive: true, phrase: source.phrase }), 404);
  f.blocked = '有未结束的实盘执行任务';
  assert.throws(() => f.probes.live(source.id, { confirmLive: true, phrase: source.phrase }), error => error.status === 409 && error.message === '有未结束的实盘执行任务');
  f.blocked = null; f.refuse = true;
  status(() => f.probes.live(source.id, { confirmLive: true, phrase: source.phrase }), 409);
  f.refuse = false;
  assert.equal(f.probes.state().runs.length, 2, 'no refused request started a run'); assert.equal(f.holds.length, 0);

  f.probes.live(source.id, { confirmLive: true, phrase: source.phrase });
  assert.equal(f.holds.length, 1); assert.equal(f.holds[0].released, false);
  await f.probes.idle();
  const [live, used] = f.probes.state().runs;
  assert.equal(live.mode, 'live'); assert.equal(live.status, 'completed'); assert.equal(live.outcome, 'complete'); assert.equal(used.usedForLive, true);
  assert.deepEqual(f.probes.report(live.id).report.argv.slice(-3), ['--live', '--confirm', 'fake-CLUSDT']);
  assert.deepEqual(f.probes.report(live.id).report.argv.slice(0, 6), ['--symbol', 'CLUSDT', '--data-dir', f.dataDir, '--max-notional', '80']);
  assert.equal(f.holds[0].released, true, 'the update hold ends with the probe');
  status(() => f.probes.live(source.id, { confirmLive: true, phrase: source.phrase }), 409);

  // A newer run of the same probe, or a check older than the window, voids the confirmation.
  const older = await f.readOnly({ symbol: 'CLUSDT' });
  await f.readOnly({ symbol: 'BZUSDT' });
  status(() => f.probes.live(older.id, { confirmLive: true, phrase: older.phrase }), 409);
  const stale = await f.readOnly({ symbol: 'CLUSDT' });
  f.advance(LIVE_WINDOW_MS + 1);
  status(() => f.probes.live(stale.id, { confirmLive: true, phrase: stale.phrase }), 409);
  assert.equal(f.holds.length, 1);
});

test('真实运行的退出码决定结论：1 为未发送，2 为须到交易所核对', async t => {
  const f = await fixture(t);
  for (const [settleTimeoutS, expected, outcome] of [[12, 'not-sent', '未发送'], [13, 'needs-check', '有残留']]) {
    const source = await f.readOnly({ symbol: 'CLUSDT', settleTimeoutS });
    f.probes.live(source.id, { confirmLive: true, phrase: source.phrase }); await f.probes.idle();
    const run = f.probes.state().runs[0];
    assert.equal(run.status, expected); assert.equal(run.outcome, outcome); assert.equal(f.holds.at(-1).released, true);
  }
});

test('真实运行被信号结束而没有退出码时记为须核对；探测进程无法启动时记为未发送并释放占用', async t => {
  const f = await fixture(t);
  const source = await f.readOnly({ symbol: 'CLUSDT', settleTimeoutS: 15 });
  f.probes.live(source.id, { confirmLive: true, phrase: source.phrase });
  f.probes.stop(f.probes.state().running, {});
  await f.probes.idle();
  const killed = f.probes.state().runs[0];
  assert.equal(killed.exitCode, null); assert.equal(killed.status, 'needs-check'); assert.equal(f.holds[0].released, true);

  const again = await f.readOnly({ symbol: 'CLUSDT' });
  f.options.execPath = path.join(f.dataDir, 'no-such-node');
  f.reopen().live(again.id, { confirmLive: true, phrase: again.phrase });
  await f.probes.idle();
  const unstarted = f.probes.state().runs[0];
  assert.equal(unstarted.mode, 'live'); assert.equal(unstarted.status, 'not-sent'); assert.equal(unstarted.exitCode, null);
  assert.match(unstarted.error, /无法启动探测进程/);
  assert.equal(f.holds.length, 2); assert.equal(f.holds[1].released, true);
});

test('运行环境关闭时不向运行中的真实测试发信号，只停止续期占用；之后不再接受新测试', async t => {
  const f = await fixture(t);
  const source = await f.readOnly({ symbol: 'CLUSDT', settleTimeoutS: 11 });
  f.probes.live(source.id, { confirmLive: true, phrase: source.phrase });
  for (let waited = 0; waited < 5000 && !f.probes.state().runs[0].log?.length; waited += 50) await new Promise(resolve => setTimeout(resolve, 50));
  f.probes.close();
  await new Promise(resolve => setTimeout(resolve, 300));
  const state = f.probes.state();
  assert.equal(state.runs[0].status, 'running', 'the probe was not signalled');
  assert.deepEqual([f.holds[0].abandoned, f.holds[0].released], [true, false]);
  status(() => f.probes.start({ probe: 'bybit', params: { symbol: 'CLUSDT' } }), 503);
  f.probes.stop(state.running, {});
  await f.probes.idle();
  assert.equal(f.probes.state().runs[0].status, 'needs-check');
});

test('同一时刻只有一项测试；停止先请求收尾，再次才可强制结束；维护期间不能开始', async t => {
  const f = await fixture(t);
  f.maintenance = true;
  status(() => f.probes.start({ probe: 'bybit', params: { symbol: 'CLUSDT' } }), 409);
  f.maintenance = false;
  const source = await f.readOnly({ symbol: 'CLUSDT', settleTimeoutS: 11 });
  f.probes.live(source.id, { confirmLive: true, phrase: source.phrase });
  const running = f.probes.state();
  assert.equal(running.running, running.runs[0].id); assert.equal(running.runs[0].status, 'running');
  status(() => f.probes.start({ probe: 'bybit', params: { symbol: 'BZUSDT' } }), 409);
  status(() => f.probes.start({ probe: 'aster', params: {} }), 400);
  status(() => f.probes.stop(source.id, {}), 409);
  status(() => f.probes.stop(running.running, { force: true }), 409);
  // Let the stand-in install its signal handler before it is asked to stop.
  for (let waited = 0; waited < 5000 && !f.probes.state().runs[0].log?.length; waited += 50) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(f.probes.stop(running.running, {}).runs[0].stopRequestedAt);
  await f.probes.idle();
  const ended = f.probes.state().runs[0];
  assert.equal(ended.status, 'needs-check', 'a live run that was stopped is never reported as clean');
  assert.equal(f.holds[0].released, true); assert.equal(f.probes.state().running, null);
  status(() => f.probes.stop(ended.id, {}), 409);
});

test('运行环境重启后，未结束的测试记为中断并保留；只保留最近十次及其文件', async t => {
  const f = await fixture(t);
  const first = await f.readOnly();
  const stateFile = path.join(f.dataDir, 'contract-probes', 'state.json');
  const saved = JSON.parse(await readFile(stateFile, 'utf8'));
  saved.runs.unshift({ ...saved.runs[0], id: '11111111-1111-4111-8111-111111111111', mode: 'live', status: 'running', endedAt: null, exitCode: null, phrase: null },
    { id: '../../escape', probe: 'bybit', mode: 'live', status: 'running' });
  await writeFile(stateFile, JSON.stringify(saved));
  const reopened = f.reopen().state();
  assert.deepEqual(reopened.runs.map(run => [run.id, run.status]), [['11111111-1111-4111-8111-111111111111', 'interrupted'], [first.id, 'completed']]);
  assert.equal(reopened.running, null);
  status(() => f.probes.live(first.id, { confirmLive: true, phrase: first.phrase }), 409);
  for (let index = 0; index < 10; index++) await f.readOnly();
  assert.deepEqual(f.probes.state().runs.map(run => run.status), [...Array(9).fill('completed'), 'interrupted'], 'a live run that may have left something outlives the ordinary ones');
  assert.equal(existsSync(path.join(f.dataDir, 'contract-probes', `${first.id}.json`)), false);
  status(() => f.probes.report(first.id), 404);
  // Nothing is dropped when every kept run still needs checking.
  const kept = JSON.parse(await readFile(stateFile, 'utf8'));
  kept.runs = kept.runs.map(run => ({ ...run, mode: 'live', status: 'needs-check', phrase: null }));
  await writeFile(stateFile, JSON.stringify(kept));
  f.reopen(); await f.readOnly();
  assert.equal(f.probes.state().runs.length, 11);

  // On Windows a stop cannot reach the probe's wind-down, so no live run starts there.
  f.options.platform = 'win32';
  const source = await (f.reopen(), f.readOnly());
  assert.match(f.probes.state().liveBlocked.bybit, /Linux/);
  assert.throws(() => f.probes.live(source.id, { confirmLive: true, phrase: source.phrase }), error => error.status === 409 && /Linux/.test(error.message));
  assert.equal(f.holds.length, 0);
});

test('长时间占用的执行入口在释放前一直挡住更新，维护期间拒绝，过期后自动失效', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'probe-hold-'));
  const db = openHubDatabase(path.join(dir, 'hub.sqlite')), control = createControlStore(db);
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  t.mock.timers.enable({ apis: ['setInterval'] });
  let clock = 1000;
  const entries = createExecutionEntries({ db, now: () => clock, readMaintenance: () => control.getSetting('updates-maintenance') === '1', refuse: () => { throw Object.assign(new Error('maintenance'), { status: 409 }); } });
  const reader = createExecutionJobsReader(db, { now: () => clock });
  const updates = createUpdateCoordinator({ client: { status: async () => unavailableUpdateState(), apply: async () => { throw new Error('not reached'); } }, execution: reader,
    readMaintenance: () => control.getSetting('updates-maintenance') === '1', writeMaintenance: value => control.setSetting('updates-maintenance', value ? '1' : '0'),
    readPendingPlanId: () => control.getSetting('updates-pending-plan') || null, writePendingPlanId: value => control.setSetting('updates-pending-plan', value || ''), releasePollMs: 0 });
  t.after(() => updates.close());
  const refused = () => assert.rejects(async () => updates.apply('plan-0123456789abcdef', () => {}), error => error.status === 409 && /停止所有实盘任务/.test(error.message));
  const hold = entries.hold({ holdMs: 120_000, renewMs: 30_000 });
  assert.equal(reader.openEntries(), 1);
  await refused();
  for (let step = 0; step < 20; step++) { clock += 30_000; t.mock.timers.tick(30_000); assert.equal(reader.openEntries(), 1, 'renewed while the probe runs'); }
  await refused();
  assert.equal(control.getSetting('updates-maintenance') === '1', false);
  hold.release(); hold.release();
  assert.equal(reader.openEntries(), 0);
  // Abandoned (the runtime is closing) or never renewed (it died): the entry stops counting after holdMs.
  entries.hold({ holdMs: 120_000, renewMs: 30_000 }).abandon();
  clock += 119_999; t.mock.timers.tick(119_999); assert.equal(reader.openEntries(), 1);
  await refused();
  clock += 1; assert.equal(reader.openEntries(), 0);
  control.setSetting('updates-maintenance', '1');
  assert.throws(() => entries.hold(), error => error.status === 409);
});

test('接口实测的 HTTP 接口需要登录、同源与 CSRF；真实探测脚本可由工作台启动并如实报告缺少账户', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'contract-probes-http-'));
  const app = await createApp({ dataDir, initialPassword: 'contract-probe-http-fixture', logger: () => {}, refreshInterval: 0, assetSyncIntervalMs: 0, tradingRefreshIntervalMs: 0, executionIntervalMs: 0, warmupEnabled: false, baselineIntervalMs: 0 });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`, route = '/api/system/contract-probes';
  let auth = null;
  async function request(target, { method = 'GET', data, headers = {}, signed = true } = {}) {
    const response = await fetch(origin + target, { method, headers: { Origin: origin, ...(data ? { 'Content-Type': 'application/json' } : {}), ...(signed && auth ? { Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf } : {}), ...headers }, ...(data ? { body: JSON.stringify(data) } : {}) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  const settle = async () => { for (let waited = 0; waited < 20_000; waited += 100) { const state = await request(route); if (state.data.running === null) return state.data; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('probe did not end'); };
  t.after(async () => { await settle().catch(() => {}); await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const start = { probe: 'bybit', params: { symbol: 'CLUSDT' } };
  assert.equal((await request(route)).status, 401);
  assert.equal((await request(`${route}/runs`, { method: 'POST', data: start })).status, 401);
  const login = await request('/api/login', { method: 'POST', data: { password: 'contract-probe-http-fixture' } });
  auth = { cookie: login.headers.get('set-cookie').split(';')[0], csrf: login.data.csrfToken };
  const idle = await request(route);
  assert.equal(idle.status, 200); assert.deepEqual(idle.data.runs, []); assert.deepEqual(idle.data.options.bybit.symbols, ['CLUSDT', 'BZUSDT', 'SKHYUSDT', 'SKHYNIXUSDT']);
  if (process.platform === 'win32') assert.match(idle.data.liveBlocked.bybit, /Linux/); else assert.deepEqual(idle.data.liveBlocked, { bybit: null, aster: null, canary: null });
  assert.equal((await request(`${route}?x=1`)).status, 400);
  assert.equal((await request(route, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await request(route, { headers: { 'Sec-Fetch-Site': 'same-site', Origin: '' } })).status, 403);
  assert.equal((await request(`${route}/runs`, { method: 'POST', data: start, headers: { 'X-CSRF-Token': 'wrong' } })).status, 403);
  assert.equal((await request(`${route}/runs`, { method: 'POST', data: start, headers: { Origin: 'https://foreign.invalid' } })).status, 403);
  assert.equal((await request(`${route}/runs`, { method: 'POST', data: { probe: 'bybit', params: { symbol: 'BTCUSDT' } } })).status, 400);
  assert.equal((await request(`${route}/runs/00000000-0000-4000-8000-000000000000/live`, { method: 'POST', data: { confirmLive: true, phrase: 'x' } })).status, 404);
  assert.equal((await request(`${route}/runs/00000000-0000-4000-8000-000000000000/report`)).status, 404);
  assert.equal((await request(`${route}/unknown`)).status, 404);
  assert.equal((await request(route)).data.runs.length, 0);

  const accepted = await request(`${route}/runs`, { method: 'POST', data: start });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.data)); assert.equal(accepted.data.runs[0].status, 'running');
  const ended = await settle();
  assert.equal(ended.runs[0].status, 'failed'); assert.equal(ended.runs[0].exitCode, 1);
  assert.match(ended.runs[0].error, /没有保存 Bybit 执行账户/, 'the packaged probe ran and read the workbench data directory');
  const refused = await request(`${route}/runs/${ended.runs[0].id}/live`, { method: 'POST', data: { confirmLive: true, phrase: 'bybit-chase-CLUSDT-1-bps200' } });
  assert.equal(refused.status, 409);
  assert.equal((await request(route)).data.runs.length, 1);
});

test('原油金丝雀：参数白名单与上限；检查只读完成且不提供真实运行；开仓预览给出短语后按同一参数真实运行，受实盘守卫约束', async t => {
  const f = await fixture(t);
  const base = { step: 'open', symbol: 'CLUSDT', lead: 'binance', leadSide: 'long', quantity: '1' };
  for (const params of [{ ...base, perJob: '200.01' }, { ...base, totalOpen: '500.5' }, { ...base, perJob: '150', totalOpen: '100' }, { ...base, leadOrder: 'chase' },
    { ...base, symbol: 'SKHYUSDT' }, { ...base, quantity: undefined }, { ...base, timeoutS: 601 }, { ...base, timeoutS: '60' }, { ...base, maxSlippageBps: 201 }, { ...base, step: 'adl' },
    { ...base, dataDir: '/tmp' }, { ...base, confirm: 'x' }, { ...base, quantity: 1 }, { ...base, strategy: 'release' }, { ...base, step: 'settle', strategy: 'adopt' },
    { ...base, step: 'settle', strategy: 'adopt', strategyId: 'a b' }, { ...base, step: 'settle', strategy: 'keep' }])
    status(() => f.probes.start({ probe: 'canary', params }), 400);
  assert.deepEqual(f.probes.state().options.canary.symbols, ['CLUSDT', 'BZUSDT']);

  const check = await f.readOnly({ step: 'check', symbol: 'BZUSDT', lead: 'bybit', leadSide: 'short', leadOrder: 'chase' }, 'canary');
  assert.equal(check.status, 'completed', JSON.stringify(check)); assert.equal(check.phrase, null); assert.equal(check.outcome, '检查通过');
  assert.deepEqual(check.params, { step: 'check', symbol: 'BZUSDT', lead: 'bybit', leadSide: 'short', leadOrder: 'chase', quantity: '1', perJob: '100', totalOpen: '300', timeoutS: 120, maxSlippageBps: null, strategy: 'auto', strategyId: null });
  status(() => f.probes.live(check.id, { confirmLive: true, phrase: 'fake-BZUSDT' }), 409);
  const adopt = await f.readOnly({ step: 'settle', symbol: 'CLUSDT', lead: 'binance', leadSide: 'long', strategy: 'adopt', strategyId: ' abc_1 ' }, 'canary');
  assert.deepEqual(f.probes.report(adopt.id).report.argv.slice(-6, -2), ['--strategy', 'adopt', '--strategy-id', 'abc_1']);

  const preview = await f.readOnly({ ...base, quantity: '2.5', perJob: '150', totalOpen: '400', timeoutS: 90, maxSlippageBps: 40 }, 'canary');
  assert.equal(preview.status, 'completed'); assert.equal(preview.phrase, 'fake-CLUSDT');
  const argv = ['--data-dir', f.dataDir, '--step', 'open', '--symbol', 'CLUSDT', '--lead', 'binance', '--lead-side', 'long', '--lead-order', 'market', '--quantity', '2.5',
    '--per-job', '150', '--total-open', '400', '--timeout-s', '90', '--max-slippage-bps', '40', '--out', path.join(f.dataDir, 'contract-probes', `${preview.id}.json`)];
  assert.deepEqual(f.probes.report(preview.id).report.argv, argv);
  f.blocked = '有未结束的实盘执行任务，结束后再做原油金丝雀真实测试';
  status(() => f.probes.live(preview.id, { confirmLive: true, phrase: preview.phrase }), 409);
  assert.equal(f.blockerCalls.at(-1), 'canary');
  f.blocked = null;
  f.probes.live(preview.id, { confirmLive: true, phrase: preview.phrase });
  await f.probes.idle();
  const run = f.probes.state().runs[0];
  assert.equal(run.mode, 'live'); assert.equal(run.status, 'completed');
  assert.deepEqual(f.probes.report(run.id).report.argv, [...argv.slice(0, -1), path.join(f.dataDir, 'contract-probes', `${run.id}.json`), '--live', '--confirm', 'fake-CLUSDT']);
  assert.equal(f.holds.length, 1); assert.ok(f.holds[0].released);
});
