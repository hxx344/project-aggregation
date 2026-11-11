// Offline checks of the real-venue contract probes' local parts: signing against independent
// implementations, the write guard and report redaction. No test here opens a network connection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TypedDataEncoder, Wallet, keccak256 as ethersKeccak, recoverAddress } from 'ethers';
import { bybitAuthHeaders } from '../../../server/exchange-transport/bybit.mjs';
import { addressOf, asterDigest, keccak256, pythonUrlencode, signAsterMessage } from '../../../server/contract-probes/lib/eip712.ts';
import { bybitHeaders } from '../../../server/contract-probes/lib/bybit-sign.ts';
import { ProbeAbort, liveAllowed, parseEnvFile, positiveDecimal, redact, sleep } from '../../../server/contract-probes/lib/common.ts';

const hex = (bytes: Uint8Array): string => '0x' + Buffer.from(bytes).toString('hex');
const DOMAIN = { name: 'AsterSignTransaction', version: '1', chainId: 1666, verifyingContract: '0x0000000000000000000000000000000000000000' };
const TYPES = { Message: [{ name: 'msg', type: 'string' }] };

test('契约探测：keccak-256 在各个分组边界上与 ethers 一致', () => {
  for (const length of [0, 1, 31, 32, 55, 135, 136, 137, 271, 272, 273, 1000]) {
    const input = randomBytes(length);
    assert.equal(hex(keccak256(input)), ethersKeccak(input), `长度 ${length}`);
  }
});

test('契约探测：私钥推导地址、EIP-712 摘要与签名与 ethers 逐字节一致，签名可恢复出签名地址', async () => {
  for (let round = 0; round < 12; round++) {
    const wallet = Wallet.createRandom(), message = pythonUrlencode({ toAccountAddress: wallet.address.toLowerCase(), asset: 'USD1', amount: String(round + 1) + '.5', nonce: String(1_700_000_000_000_000 + round), signer: wallet.address });
    assert.equal(addressOf(wallet.privateKey), wallet.address.toLowerCase());
    assert.equal(hex(asterDigest(message)), TypedDataEncoder.hash(DOMAIN, TYPES, { msg: message }));
    const signature = signAsterMessage(message, wallet.privateKey);
    assert.equal(signature, await wallet.signTypedData(DOMAIN, TYPES, { msg: message }));
    assert.equal(recoverAddress(asterDigest(message), signature), wallet.address);
  }
});

test('契约探测：参数编码与 Python urlencode 相同（空格为加号，~ 不转义，其余按 UTF-8 百分号转义）', () => {
  assert.equal(pythonUrlencode({ a: '1', kindType: 'FUTURE_FUTURE', note: 'a b~c*d/é', 'k&': 'v=1' }), 'a=1&kindType=FUTURE_FUTURE&note=a+b~c%2Ad%2F%C3%A9&k%26=v%3D1');
});

test('契约探测：Bybit 请求头签名与工作台现有实现一致', () => {
  const credentials = { apiKey: 'key-' + randomBytes(6).toString('hex'), apiSecret: randomBytes(16).toString('hex') };
  const payload = JSON.stringify({ category: 'UTA_USDT', symbol: 'CLUSDT', size: '0.1' });
  assert.deepEqual(bybitHeaders(credentials, '1700000000000', '5000', payload), bybitAuthHeaders(credentials, { timestamp: '1700000000000', recvWindow: '5000', payload }));
});

test('契约探测：不带 --live 不允许写；--live 必须带与本次参数一致的确认短语', () => {
  assert.equal(liveAllowed({}, 'aster-transfer-1-USD1-nonce0'), false);
  assert.throws(() => liveAllowed({ confirm: 'aster-transfer-1-USD1-nonce0' }, 'aster-transfer-1-USD1-nonce0'), ProbeAbort);
  assert.throws(() => liveAllowed({ live: true }, 'aster-transfer-1-USD1-nonce0'), ProbeAbort);
  assert.throws(() => liveAllowed({ live: true, confirm: 'aster-transfer-1-USD1-nonce0' }, 'aster-transfer-2-USD1-nonce0'), ProbeAbort);
  assert.equal(liveAllowed({ live: true, confirm: 'aster-transfer-1-USD1-nonce0' }, 'aster-transfer-1-USD1-nonce0'), true);
});

test('契约探测：报告隐去密钥、签名与账户编号，地址只保留首尾', () => {
  const secret = randomBytes(32).toString('hex'), address = '0x' + 'ab'.repeat(20);
  const cleaned = JSON.stringify(redact({ signature: '0xdead', userID: 12345, apiKey: 'k', nested: [{ msg: `bad key ${secret} for ${address}`, [address]: 1 }], amount: '1.5' }, [secret]));
  assert.ok(!cleaned.includes(secret) && !cleaned.includes(address) && !cleaned.includes('0xdead') && !cleaned.includes('12345'));
  assert.ok(cleaned.includes('0xabab…abab') && cleaned.includes('"amount":"1.5"'));
});

test('契约探测：env 文件解析与金额校验', () => {
  assert.deepEqual(parseEnvFile('# c\nA_USER=0x1\nexport B="x y"\n\nbad line\nC=\'q\'\n'), { A_USER: '0x1', B: 'x y', C: 'q' });
  assert.equal(positiveDecimal('1.50', '--amount', 8), '1.5');
  for (const bad of ['0', '-1', '1e3', '1.123456789', '', undefined]) assert.throws(() => positiveDecimal(bad, '--amount', 8), ProbeAbort);
});

const run = (script: string, args: string[], env: Record<string, string> = {}): { status: number | null; output: string } => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../../server/contract-probes/' + script, import.meta.url)), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env }, timeout: 30_000 });
  return { status: result.status, output: result.stdout + result.stderr };
};

test('契约探测：参数不合格时在发出任何请求前中止', () => {
  const wallet = Wallet.createRandom(), other = Wallet.createRandom();
  const master = { MA_USER: other.address, MA_SIGNER: wallet.address, MA_PRIVATE_KEY: wallet.privateKey };
  // The sub-account key does not match its signer.
  let result = run('aster-transfer.ts', ['--master-prefix', 'MA', '--a-prefix', 'SA', '--b-prefix', 'SB'], { ...master, SA_USER: wallet.address, SA_SIGNER: other.address, SA_PRIVATE_KEY: wallet.privateKey, SB_USER: wallet.address, SB_SIGNER: wallet.address, SB_PRIVATE_KEY: wallet.privateKey });
  assert.equal(result.status, 1);
  assert.match(result.output, /已中止：.*signer 不匹配/);
  // Amount over the hard cap.
  const subs = Object.fromEntries(['SA', 'SB'].flatMap(prefix => { const sub = Wallet.createRandom(), signer = Wallet.createRandom(); return [[prefix + '_USER', sub.address], [prefix + '_SIGNER', signer.address], [prefix + '_PRIVATE_KEY', signer.privateKey]]; }));
  result = run('aster-transfer.ts', ['--master-prefix', 'MA', '--a-prefix', 'SA', '--b-prefix', 'SB', '--amount', '5.01'], { ...master, ...subs });
  assert.equal(result.status, 1);
  assert.match(result.output, /不能超过 5 USD1/);
  // --live needs the phrase, and the phrase names the nonce offsets.
  result = run('aster-transfer.ts', ['--master-prefix', 'MA', '--a-prefix', 'SA', '--b-prefix', 'SB', '--probe-nonce=-30', '--live'], { ...master, ...subs });
  assert.equal(result.status, 1);
  assert.match(result.output, /--live 需要 --confirm aster-transfer-1-USD1-SA-SB-nonce-30（/);
  // A refused probe is watched until its nonce should have expired, which must fit in the settle limit.
  result = run('aster-transfer.ts', ['--master-prefix', 'MA', '--a-prefix', 'SA', '--b-prefix', 'SB', '--probe-nonce=300', '--live'], { ...master, ...subs });
  assert.equal(result.status, 1);
  assert.match(result.output, /--settle-timeout-s 调到至少 375/);

  result = run('bybit-chase.ts', ['--symbol', 'BTCUSDT'], { BYBIT_API_KEY: 'k', BYBIT_API_SECRET: 's' });
  assert.equal(result.status, 1);
  assert.match(result.output, /--symbol 必须是/);
  result = run('bybit-chase.ts', ['--symbol', 'CLUSDT', '--max-notional', '201'], { BYBIT_API_KEY: 'k', BYBIT_API_SECRET: 's' });
  assert.equal(result.status, 1);
  assert.match(result.output, /不能超过 200 USDT/);
  result = run('bybit-chase.ts', ['--symbol', 'CLUSDT']);
  assert.equal(result.status, 1);
  assert.match(result.output, /缺少 BYBIT_API_KEY/);
});
// The flows below run against test/contract-stub.ts, which replaces fetch in the child process.
const stubbed = (script: string, args: string[], env: Record<string, string>): { status: number | null; output: string; requests: string[]; report: string } => {
  const directory = mkdtempSync(join(tmpdir(), 'pa-contract-')), log = join(directory, 'requests.log'), out = join(directory, 'report.json');
  try {
    writeFileSync(log, '');
    const result = spawnSync(process.execPath, ['--import', new URL('./contract-stub.ts', import.meta.url).href, fileURLToPath(new URL('../../../server/contract-probes/' + script, import.meta.url)), ...args, '--out', out],
      { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', CONTRACT_STUB_LOG: log, ...env }, timeout: 150_000 });
    return { status: result.status, output: result.stdout + result.stderr, requests: readFileSync(log, 'utf8').split('\n').filter(Boolean), report: existsSync(out) ? readFileSync(out, 'utf8') : '' };
  } finally { rmSync(directory, { recursive: true, force: true }); }
};
const phraseOf = (output: string): string => / --confirm (\S+?)(?:（|\s|$)/.exec(output)?.[1] ?? '';
const count = (requests: string[], line: string): number => requests.filter(request => request === line).length;

const asterEnv = (): { env: Record<string, string>; secrets: string[] } => {
  const [master, masterSigner, a, aSigner, b, bSigner] = Array.from({ length: 6 }, () => Wallet.createRandom());
  return { env: { MA_USER: master!.address, MA_SIGNER: masterSigner!.address, MA_PRIVATE_KEY: masterSigner!.privateKey, SA_USER: a!.address, SA_SIGNER: aSigner!.address, SA_PRIVATE_KEY: aSigner!.privateKey,
    SB_USER: b!.address, SB_SIGNER: bSigner!.address, SB_PRIVATE_KEY: bSigner!.privateKey, CONTRACT_STUB_ACCOUNTS: JSON.stringify({ master: master!.address, a: a!.address, b: b!.address }) },
  secrets: [masterSigner!.privateKey, aSigner!.privateKey.slice(2), a!.address, a!.address.toLowerCase(), master!.address.toLowerCase()] };
};
const ASTER_BASE = ['--master-prefix', 'MA', '--a-prefix', 'SA', '--b-prefix', 'SB', '--amount', '1.5'];
const ASTER_PHRASE = 'aster-transfer-1.5-USD1-SA-SB-noncenone';

test('契约探测（ASTER，替身接口）：只读运行不发任何 POST；真实划转来回各一笔，nonce 探测每笔金额不同、逐笔划回已入账的部分，净额为零，报告不含密钥', () => {
  const { env, secrets } = asterEnv();
  const dry = stubbed('aster-transfer.ts', ASTER_BASE, env);
  assert.equal(dry.status, 0, dry.output);
  assert.ok(dry.requests.length > 0 && dry.requests.every(line => line.startsWith('GET ')), dry.requests.join());
  assert.equal(phraseOf(dry.output), ASTER_PHRASE);
  // Offsets given to a read-only run only shape the phrase it prints; nothing is sent.
  const dryNonce = stubbed('aster-transfer.ts', [...ASTER_BASE, '--probe-nonce=-8,3'], env);
  assert.equal(dryNonce.status, 0, dryNonce.output);
  assert.ok(dryNonce.requests.length > 0 && dryNonce.requests.every(line => line.startsWith('GET ')), dryNonce.requests.join());
  assert.equal(phraseOf(dryNonce.output), 'aster-transfer-1.5-USD1-SA-SB-nonce-8_3');

  // A phrase for other parameters stops before the first request.
  const refused = stubbed('aster-transfer.ts', [...ASTER_BASE, '--probe-nonce=-8', '--live', '--confirm', ASTER_PHRASE], env);
  assert.equal(refused.status, 1);
  assert.deepEqual(refused.requests, []);

  // The stand-in accepts increasing nonces within 4 s: -2 and +3 execute, -8 is refused with an unlisted code.
  // Without the wait before each probe, -8 and -2 would not be newer than the signer's earlier nonces.
  const live = stubbed('aster-transfer.ts', [...ASTER_BASE, '--settle-timeout-s', '80', '--probe-nonce=-2,-8,3', '--live', '--confirm', 'aster-transfer-1.5-USD1-SA-SB-nonce-8_-2_3'], { ...env, CONTRACT_STUB_NONCE_WINDOW_MS: '4000' });
  assert.equal(live.status, 0, live.output);
  assert.equal(count(live.requests, 'POST /fapi/v3/subAccountTransfer'), 7);
  assert.equal(live.requests.filter(line => line.startsWith('POST ')).length, 7);
  const report = JSON.parse(live.report);
  assert.equal(report.outcome, 'complete');
  assert.deepEqual(report.findings.net, { a: '0', b: '0' });
  const probes = report.findings.nonce.probes as { offsetSeconds: number; amount: string; outcome: string; landed: boolean; nonceAheadOfEarlierMs: number }[];
  assert.deepEqual(probes.map(probe => [probe.offsetSeconds, probe.amount, probe.outcome, probe.landed]), [[-8, '1.51', 'refused-unlisted', false], [-2, '1.52', 'accepted', true], [3, '1.53', 'accepted', true]]);
  assert.ok(probes.every(probe => probe.nonceAheadOfEarlierMs > 0), JSON.stringify(probes));
  // Waits run on the stand-in's clock, not shortened: the refused probe was still watched for the whole 75 s nonce horizon.
  assert.ok((report.findings.nonce.probes[0].watchedMs as number) >= 75_000, JSON.stringify(probes));
  assert.ok('划回 nonce 探测 1.52 B→A' in report.findings.transfers && '划回 nonce 探测 1.53 B→A' in report.findings.transfers);
  assert.deepEqual(report.writes.map((write: { outcome: string }) => write.outcome), ['accepted', 'accepted', 'refused-unlisted', 'accepted', 'accepted', 'accepted', 'accepted']);
  const first = report.findings.transfers['划转 A→B'];
  assert.deepEqual([first.receipt.tranIdPresent, first.tranIds.bothSidesEqual, first.tranIds.receiptMatchesSource, first.visibleAfterReceiptMs.timedOut], [true, true, true, false]);
  // The stand-in's income window includes both ends.
  assert.deepEqual(report.findings.endTime.results.map((item: { rowPresent: boolean }) => item.rowPresent), [true, true, false, false, true, true]);
  for (const secret of secrets) assert.ok(!live.report.includes(secret) && !live.output.includes(secret));
});

test('契约探测（ASTER，替身接口）：划转应答丢失或被网关拦截时不重发并以退出码 2 结束；账户有持仓时不发送', () => {
  const { env } = asterEnv(), live = [...ASTER_BASE, '--live', '--confirm', ASTER_PHRASE];
  const lost = stubbed('aster-transfer.ts', live, { ...env, CONTRACT_STUB_FAULT: 'aster-lost-transfer' });
  assert.equal(lost.status, 2, lost.output);
  assert.equal(lost.requests.filter(line => line.startsWith('POST ')).length, 1);
  const report = JSON.parse(lost.report);
  assert.match(report.outcome, /结果未知/);
  // The transfer did run: the watch found it and the net amount is left for the operator.
  assert.deepEqual([report.findings.transfers['划转 A→B'].tranIds.bothSidesEqual, report.findings.net.a, report.writes[0].outcome], [true, '-1.5', 'unknown']);

  const blocked = stubbed('aster-transfer.ts', live, { ...env, CONTRACT_STUB_FAULT: 'aster-429' });
  assert.equal(blocked.status, 2, blocked.output);
  assert.equal(blocked.requests.filter(line => line.startsWith('POST ')).length, 1);
  assert.equal(JSON.parse(blocked.report).writes[0].outcome, 'unknown');

  const holding = stubbed('aster-transfer.ts', live, { ...env, CONTRACT_STUB_FAULT: 'aster-positions' });
  assert.equal(holding.status, 1, holding.output);
  assert.match(holding.output, /--balancer-paused/);
  assert.ok(holding.requests.every(line => line.startsWith('GET ')));
});

const bybitEnv = (): Record<string, string> => ({ BYBIT_API_KEY: 'stub-key-' + randomBytes(6).toString('hex'), BYBIT_API_SECRET: randomBytes(16).toString('hex') });
const BYBIT_PHRASE = 'bybit-chase-CLUSDT-0.1-bps200';
const bybitPosts = (requests: string[]): number[] => ['/v5/strategy/create', '/v5/strategy/stop', '/v5/order/create'].map(path => count(requests, 'POST ' + path));

test('契约探测（Bybit，替身接口）：只读运行不发任何 POST；真实运行创建并停止全部策略、成交一笔后平仓，收尾无残留，报告不含密钥与账户编号', () => {
  const env = bybitEnv(), base = ['--symbol', 'CLUSDT', '--allow-fill'];
  const dry = stubbed('bybit-chase.ts', base, env);
  assert.equal(dry.status, 0, dry.output);
  assert.ok(dry.requests.length > 0 && dry.requests.every(line => line.startsWith('GET ')), dry.requests.join());
  // 5 USDT minimum at the resting price 58.80 is 0.09 after rounding up, plus one step.
  assert.equal(phraseOf(dry.output), BYBIT_PHRASE + '-fill');

  // The phrase names the distance below the bid: another distance needs another phrase.
  const refused = stubbed('bybit-chase.ts', [...base, '--passive-bps', '300', '--live', '--confirm', BYBIT_PHRASE + '-fill'], env);
  assert.equal(refused.status, 1);
  assert.ok(refused.requests.every(line => line.startsWith('GET ')));

  const live = stubbed('bybit-chase.ts', [...base, '--live', '--confirm', BYBIT_PHRASE + '-fill'], env);
  assert.equal(live.status, 0, live.output);
  const report = JSON.parse(live.report);
  assert.equal(report.outcome, 'complete');
  // Creates: A, duplicate, below minimum, stale timestamp, C. Stops: A, duplicate, A again, unknown id. One closing order.
  assert.deepEqual(bybitPosts(live.requests), [5, 4, 1]);
  assert.deepEqual(report.findings.offsetSpelling, { tried: [{ spelling: 'chasePercentE4 0', outcome: 'accepted', retCode: 0, retMsg: 'OK' }], accepted: 'chasePercentE4 0' });

  // The next spelling is tried only after a parameter refusal; when none is accepted nothing was created and nothing is left.
  const plain = stubbed('bybit-chase.ts', ['--symbol', 'CLUSDT', '--live', '--confirm', BYBIT_PHRASE], { ...env, CONTRACT_STUB_FAULT: 'bybit-percent-refused' });
  assert.equal(plain.status, 0, plain.output);
  assert.equal(JSON.parse(plain.report).findings.offsetSpelling.accepted, '不带偏移参数');
  assert.deepEqual(bybitPosts(plain.requests), [5, 4, 0]);
  const none = stubbed('bybit-chase.ts', ['--symbol', 'CLUSDT', '--live', '--confirm', BYBIT_PHRASE], { ...env, CONTRACT_STUB_FAULT: 'bybit-percent-refused,bybit-plain-refused' });
  assert.equal(none.status, 2, none.output);
  assert.deepEqual(bybitPosts(none.requests), [3, 0, 0]);
  // A that rests above its cap could fill: without --allow-fill it is stopped and nothing else is created.
  const high = stubbed('bybit-chase.ts', ['--symbol', 'CLUSDT', '--live', '--confirm', BYBIT_PHRASE], { ...env, CONTRACT_STUB_FAULT: 'bybit-rests-at-bid' });
  assert.equal(high.status, 2, high.output);
  assert.deepEqual(bybitPosts(high.requests), [1, 1, 0]);
  assert.match(JSON.parse(high.report).outcome, /没有停在最高追价/);
  assert.equal(JSON.parse(high.report).findings.cleanup.clean, true);
  const refusedAll = JSON.parse(none.report);
  assert.deepEqual([refusedAll.findings.offsetSpelling.accepted, refusedAll.findings.offsetSpelling.tried.length, refusedAll.findings.cleanup.clean], [null, 3, true]);
  assert.deepEqual(report.findings.cleanup, { clean: true, readsComplete: true, positionSize: '0', openOrders: 0, runningStrategies: 0 });
  assert.equal(report.findings.duplicateCreate.distinctId, true);
  assert.deepEqual([report.findings.stopRefusals.endedStrategy.retCode, report.findings.stopRefusals.unknownStrategy.retCode, report.findings.createRefusals.staleTimestamp.retCode, report.findings.createRefusals.belowMinimum.outcome], [60066, 60065, 10002, 'rejected']);
  // The stand-in filters ended strategies by creation second: the windows around the update and the stop miss A.
  assert.deepEqual(report.findings.endedWindow.windows.map((item: { includesA: boolean }) => item.includesA), [false, true, false, true, true]);
  for (const secret of [env.BYBIT_API_KEY!, env.BYBIT_API_SECRET!, '7654321']) assert.ok(!live.report.includes(secret) && !live.output.includes(secret));
});

test('契约探测（Bybit，替身接口）：创建应答丢失时不重发，收尾只接管并停止与该请求相符的策略，不动数量不同或方向不同的外来策略', () => {
  const live = ['--symbol', 'CLUSDT', '--live', '--confirm', BYBIT_PHRASE];
  const lost = stubbed('bybit-chase.ts', live, { ...bybitEnv(), CONTRACT_STUB_FAULT: 'bybit-lost-create' });
  assert.equal(lost.status, 2, lost.output);
  assert.deepEqual(bybitPosts(lost.requests), [1, 1, 0]);
  let report = JSON.parse(lost.report);
  assert.deepEqual([report.findings.cleanup.clean, report.findings.cleanup.runningStrategies], [true, 0]);
  assert.match(report.outcome, /结果未知/);

  const foreign = stubbed('bybit-chase.ts', live, { ...bybitEnv(), CONTRACT_STUB_FAULT: 'bybit-lost-create,bybit-foreign-on-create' });
  assert.equal(foreign.status, 2, foreign.output);
  assert.deepEqual(bybitPosts(foreign.requests), [1, 1, 0]);
  report = JSON.parse(foreign.report);
  assert.deepEqual([report.findings.cleanup.clean, report.findings.cleanup.runningStrategies, report.findings.cleanup.openOrders], [false, 2, 2]);
});

test('契约探测（Bybit，替身接口）：创建被网关拦截时停止后续步骤，收尾接管并停止那笔其实已创建的策略；双向持仓按多头仓位下单与平仓；收尾列表读取失败不算无残留', () => {
  const blocked = stubbed('bybit-chase.ts', ['--symbol', 'CLUSDT', '--live', '--confirm', BYBIT_PHRASE], { ...bybitEnv(), CONTRACT_STUB_FAULT: 'bybit-429-create' });
  assert.equal(blocked.status, 2, blocked.output);
  // A and the blocked duplicate, which did run: both are stopped.
  assert.deepEqual(bybitPosts(blocked.requests), [2, 2, 0]);
  assert.equal(JSON.parse(blocked.report).findings.cleanup.clean, true);

  // The stand-in refuses any create or close that does not carry positionIdx 1 in hedge mode.
  const hedge = stubbed('bybit-chase.ts', ['--symbol', 'CLUSDT', '--allow-fill', '--live', '--confirm', BYBIT_PHRASE + '-fill'], { ...bybitEnv(), CONTRACT_STUB_FAULT: 'bybit-hedge,bybit-list-fail' });
  assert.equal(hedge.status, 2, hedge.output);
  assert.deepEqual(bybitPosts(hedge.requests), [5, 4, 1]);
  const report = JSON.parse(hedge.report);
  assert.deepEqual(report.findings.cleanup, { clean: false, readsComplete: false, positionSize: '0', openOrders: 0, runningStrategies: 0 });
  assert.match(report.outcome, /^complete；收尾后未能确认无残留.*有读取失败/);
});

test('契约探测（Bybit，替身接口）：停止后未确认结清时不再创建新策略，收尾再次停止并核对', () => {
  const stuck = stubbed('bybit-chase.ts', ['--symbol', 'CLUSDT', '--settle-timeout-s', '10', '--live', '--confirm', BYBIT_PHRASE], { ...bybitEnv(), CONTRACT_STUB_FAULT: 'bybit-stop-stuck' });
  assert.equal(stuck.status, 2, stuck.output);
  // A and its duplicate only; the wind-down stops A again and then the duplicate.
  assert.deepEqual(bybitPosts(stuck.requests), [2, 3, 0]);
  const report = JSON.parse(stuck.report);
  assert.match(report.outcome, /未确认策略已结束/);
  assert.equal(report.findings.cleanup.clean, true);
});

test('契约探测：等待替换只对测试替身生效，指向其他 fetch 时在发出请求前中止；没有替换时等待按真实时长', async () => {
  const { env } = asterEnv();
  for (const [script, args] of [['aster-transfer.ts', [...ASTER_BASE, '--live', '--confirm', ASTER_PHRASE]], ['bybit-chase.ts', ['--symbol', 'CLUSDT']], ['bybit-chase.ts', ['--symbol', 'CLUSDT', '--live', '--confirm', BYBIT_PHRASE]]] as const) {
    const result = stubbed(script, [...args], { ...(script === 'aster-transfer.ts' ? env : bybitEnv()), CONTRACT_STUB_FAULT: 'seam-unpaired' });
    assert.equal(result.status, 1, result.output);
    assert.deepEqual(result.requests, []);
    assert.match(result.output, /已中止：检测到测试用的等待替换，但请求不会发往测试替身/);
    assert.deepEqual(JSON.parse(result.report).writes, []);
  }
  // This process has no stand-in: three 200 ms-or-less timer waits.
  const started = performance.now();
  await sleep(450);
  assert.ok(performance.now() - started >= 400);
});

test('契约探测（Bybit）：--data-dir 只读解密工作台保存的执行账户，不在数据目录里留下任何新文件', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pa-contract-data-')), apiKey = 'stored-key-' + randomBytes(6).toString('hex'), key = randomBytes(32), iv = randomBytes(12);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv), body = Buffer.concat([cipher.update(JSON.stringify({ purpose: 'execution', exchange: 'bybit', apiKey, apiSecret: randomBytes(16).toString('hex') })), cipher.final()]);
    writeFileSync(join(directory, 'credentials.key'), key);
    const database = new DatabaseSync(join(directory, 'hub.sqlite'));
    database.exec('CREATE TABLE execution_accounts (exchange TEXT PRIMARY KEY, credentials TEXT NOT NULL)');
    database.prepare('INSERT INTO execution_accounts VALUES (?, ?)').run('bybit', Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64'));
    database.close();
    const dry = stubbed('bybit-chase.ts', ['--symbol', 'CLUSDT', '--data-dir', directory], {});
    assert.equal(dry.status, 0, dry.output);
    assert.ok(dry.requests.includes('GET /v5/user/query-api') && !dry.report.includes(apiKey));
    assert.deepEqual(readdirSync(directory).sort(), ['credentials.key', 'hub.sqlite']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('契约探测：随工作台发布的十进制运算与执行器的 src/decimal.ts 逐字节相同', () => {
  // server/ is what the release package ships; platform/ is not, so the probes carry their own copy.
  assert.equal(readFileSync(new URL('../../../server/contract-probes/lib/decimal.ts', import.meta.url), 'utf8'), readFileSync(new URL('../src/decimal.ts', import.meta.url), 'utf8'));
});
