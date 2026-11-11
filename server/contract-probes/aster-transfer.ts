// Stage 2.6b: contract probe of the real ASTER sub-account transfer (inventory items 38 and 39).
// It measures what the executor's transfer slice only assumes: whether the receipt carries a
// transaction id, whether both sides' income rows share one, how `endTime` bounds an income
// query, how long a transfer takes to show in balances and income, and (optionally) how old or
// how far ahead a nonce may be.
//
// Without `--live` every request is a signed read. With `--live --confirm <phrase>` it moves
// `--amount` USD1 (at most 5) from sub-account A to B and back; `--probe-nonce` adds one
// transfer attempt per listed nonce offset and returns whatever was accepted. A transfer whose
// outcome is unknown is never resent: the run stops sending, labels it from income and exits 2.
// Endpoints, parameters and signing follow modules/aster/trading (exchange.py, margin_balance.py).
import { addressOf, pythonUrlencode, signAsterMessage } from './lib/eip712.ts';
import { HttpFailure, NotSent, ProbeAbort, boundedInteger, createReport, environment, exchange, ignoreInterrupt, liveAllowed, positiveDecimal, readFlags, registerSecrets, reserveReport, safeText, saveReport, sleep, step, watchSignals } from './lib/common.ts';
import type { HttpResult, Report } from './lib/common.ts';
import { add, cmp, mul, sub } from './lib/decimal.ts';

const BASE = 'https://fapi.asterdex.com';
const ASSET = 'USD1';
const MAX_AMOUNT = '5';
const MAX_NONCE_PROBES = 8;
/** Each nonce probe moves a different amount, so its income rows can be told apart from every other transfer. */
const NONCE_PROBE_STEP = '0.01';
const READ_TIMEOUT_MS = 8_000;
const WRITE_TIMEOUT_MS = 15_000;
/** Reads pause once the venue reports this much request weight used in the current minute. */
const WEIGHT_PAUSE_AT = 1_200;
const WEIGHT_PAUSE_MS = 5_000;
const TRANSFER_TYPES = new Set(['TRANSFER', 'SUBUSER_ASSET_TRANSFER']);
const ADDRESS_FIELDS = ['address', 'sourceAddr', 'subSourceAddr', 'walletAddress'] as const;
const BALANCE_FIELDS = ['walletBalance', 'crossWalletBalance', 'availableBalance', 'maxWithdrawAmount', 'marginBalance'] as const;
/** The codes modules/aster/trading/exchange.py treats as a definite refusal; any other failure may have executed. */
const REJECTION_CODES = new Set([-1002, -1003, -1011, -1015, -1020, -1022, -1100, -1101, -1102, -1103, -1104, -1105, -1106, -1111, -1130, -2014, -2015, -2019]);
const RATE_LIMIT_CODES = new Set([-1003, -1015]);
/** Codes after which the old module does not know whether a write ran (exchange.py UNCERTAIN_ORDER_CODES). */
const UNCERTAIN_CODES = new Set([-1000, -1001, -1006, -1007]);
/** Assumed nonce validity (L092, not verified live) plus clock slack: how long a refused probe could still run. */
const NONCE_HORIZON_MS = 75_000;
interface Credentials { prefix: string; user: string; signer: string; privateKey: string }
type Row = Record<string, unknown>;

function credentialsFor(env: Record<string, string>, prefix: string | undefined, role: string): Credentials {
  if (typeof prefix !== 'string' || !/^[A-Z][A-Z0-9_]{1,40}$/.test(prefix)) throw new ProbeAbort(`${role} 的凭据变量前缀无效`);
  const user = env[prefix + '_USER'] ?? '', signer = env[prefix + '_SIGNER'] ?? '', privateKey = env[prefix + '_PRIVATE_KEY'] ?? '';
  if (!user || !signer || !privateKey) throw new ProbeAbort(`${role}（${prefix}）缺少 _USER、_SIGNER 或 _PRIVATE_KEY`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(user) || !/^0x[0-9a-fA-F]{40}$/.test(signer)) throw new ProbeAbort(`${role}（${prefix}）的 user 或 signer 地址无效`);
  let derived: string;
  try { derived = addressOf(privateKey); } catch { throw new ProbeAbort(`${role}（${prefix}）的签名私钥无效`); }
  if (derived !== signer.toLowerCase()) throw new ProbeAbort(`${role}（${prefix}）的签名私钥与 signer 不匹配`);
  return { prefix, user, signer, privateKey };
}

let lastNonce = 0n;
/** Highest nonce each signer has sent in this run, in epoch milliseconds. */
const highestNonceMs = new Map<string, number>();
/** Microsecond nonce: strictly increasing within this run, or the clock shifted by an offset for a probe. */
function nonce(offsetSeconds = 0): bigint {
  const now = BigInt(Date.now()) * 1000n;
  if (offsetSeconds !== 0) return now + BigInt(offsetSeconds) * 1_000_000n;
  lastNonce = now > lastNonce ? now : lastNonce + 1n;
  return lastNonce;
}

/**
 * Waits until a nonce `offsetSeconds` from now is newer than every nonce this signer already sent,
 * so a refusal cannot be blamed on nonce ordering. Returns how far ahead (ms) the next nonce will be.
 */
async function clearOfEarlierNonces(credentials: Credentials, offsetSeconds: number): Promise<number | null> {
  const highest = highestNonceMs.get(credentials.signer);
  if (highest === undefined) return null;
  const short = highest + 1_500 - (Date.now() + offsetSeconds * 1000);
  if (short > 0) await sleep(short);
  return Date.now() + offsetSeconds * 1000 - highest;
}

/** The venue refused to serve: rate limit or gateway block. `refused` is true when the body carried a definite refusal code. */
class Throttled extends ProbeAbort {
  readonly refused: boolean;
  constructor(message: string, refused: boolean) { super(message); this.refused = refused; }
}

const weight = { peak: 0, last: 0, pauses: 0 };

async function signedCall(credentials: Credentials, method: 'GET' | 'POST', path: string, parameters: Record<string, string>,
  options: { signerOnly?: boolean; nonceOffsetSeconds?: number; timeoutMs?: number } = {}): Promise<HttpResult> {
  // Income queries weigh 30 each; pausing reads keeps the probe from pushing the shared IP into a ban.
  if (method === 'GET' && weight.last >= WEIGHT_PAUSE_AT) { weight.pauses++; weight.last = 0; await sleep(WEIGHT_PAUSE_MS); }
  const sent = nonce(options.nonceOffsetSeconds);
  highestNonceMs.set(credentials.signer, Math.max(highestNonceMs.get(credentials.signer) ?? 0, Number(sent / 1000n)));
  const data = { ...parameters, nonce: String(sent), ...(options.signerOnly ? {} : { user: credentials.user }), signer: credentials.signer };
  const message = pythonUrlencode(data), encoded = message + '&signature=' + signAsterMessage(message, credentials.privateKey);
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'AsterAccountDesk/1.0' };
  const result = await exchange(BASE + path + (method === 'GET' ? '?' + encoded : ''), { method, headers, ...(method === 'POST' ? { body: encoded } : {}) }, options.timeoutMs ?? READ_TIMEOUT_MS);
  const used = Math.max(0, ...Object.entries(result.headers).filter(([name]) => name.startsWith('x-mbx-used-weight')).map(([, value]) => Number(value)).filter(Number.isFinite));
  weight.last = used;
  weight.peak = Math.max(weight.peak, used);
  // The old module backs off 30 s, 180 s and a day on these; a probe that keeps going could extend a ban.
  if (isRow(result.body) && typeof result.body.code === 'number' && RATE_LIMIT_CODES.has(result.body.code)) throw new Throttled(`ASTER 返回限流错误码 ${result.body.code}，已停止后续请求`, true);
  if ([403, 418, 429].includes(result.status)) throw new Throttled(`ASTER 返回 HTTP ${result.status}（限流或网关拦截），已停止后续请求`, false);
  return result;
}
const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
const decimalText = (value: unknown): string | null => { const raw = text(value); return raw !== null && /^-?\d+(\.\d{1,18})?$/.test(raw) ? raw : null; };

function readOk(result: HttpResult, what: string): unknown {
  if (result.status !== 200 || result.raw || isRow(result.body) && typeof result.body.code === 'number' && result.body.code < 0)
    throw new ProbeAbort(`${what} 读取失败：HTTP ${result.status}，${JSON.stringify(result.body).slice(0, 200)}`);
  return result.body;
}

interface Balance { sentAt: number; receivedAt: number; serverDate: number | null; accountId: string | null; row: Row; values: Record<string, string | null>; timeFields: Record<string, unknown>; openPositions: number | null }

async function balance(credentials: Credentials): Promise<Balance> {
  const result = await signedCall(credentials, 'GET', '/fapi/v3/accountWithJoinMargin', {});
  const body = readOk(result, `${credentials.prefix} 余额`);
  if (!isRow(body) || !Array.isArray(body.assets)) throw new ProbeAbort(`${credentials.prefix} 余额应答没有 assets`);
  const rows = body.assets.filter((asset): asset is Row => isRow(asset) && asset.asset === ASSET);
  if (rows.length !== 1) throw new ProbeAbort(`${credentials.prefix} 的 ${ASSET} 资产行数为 ${rows.length}，应为 1`);
  const row = rows[0]!, values: Record<string, string | null> = {};
  for (const field of BALANCE_FIELDS) values[field] = decimalText(row[field]);
  const timeFields: Record<string, unknown> = {};
  for (const [scope, source] of [['account', body], ['asset', row]] as const) for (const [key, value] of Object.entries(source)) if (/time/i.test(key) && (typeof value === 'number' || typeof value === 'string')) timeFields[`${scope}.${key}`] = value;
  // Null when the reply has no readable position list: the caller must then not assume the account is flat.
  const openPositions = Array.isArray(body.positions) && body.positions.every(position => isRow(position) && decimalText(position.positionAmt) !== null)
    ? body.positions.filter(position => cmp(decimalText((position as Row).positionAmt)!, '0') !== 0).length : null;
  return { sentAt: result.sentAt, receivedAt: result.receivedAt, serverDate: result.serverDate, accountId: text(body.accountId), row, values, timeFields, openPositions };
}

interface Income { sentAt: number; receivedAt: number; total: number; transfers: Row[] }

const INCOME_PAGE = 1000;

async function income(credentials: Credentials, startTime: number, endTime: number | null): Promise<Income> {
  const result = await signedCall(credentials, 'GET', '/fapi/v3/income', { startTime: String(startTime), ...(endTime === null ? {} : { endTime: String(endTime) }), limit: String(INCOME_PAGE) });
  const body = readOk(result, `${credentials.prefix} 流水`);
  if (!Array.isArray(body)) throw new ProbeAbort(`${credentials.prefix} 流水应答不是数组`);
  // A full page may have cut rows off; nothing may be concluded from it.
  if (body.length >= INCOME_PAGE) throw new ProbeAbort(`${credentials.prefix} 流水返回满页（${INCOME_PAGE} 行），结果可能不完整；请缩小 --history-minutes 后重试`);
  const transfers = body.filter((row): row is Row => isRow(row) && row.asset === ASSET && typeof row.incomeType === 'string' && TRANSFER_TYPES.has(row.incomeType));
  return { sentAt: result.sentAt, receivedAt: result.receivedAt, total: body.length, transfers };
}
const wallet = (state: Balance): string | null => state.values.walletBalance ?? state.values.crossWalletBalance;
const tranId = (row: Row): string | null => text(row.tranId);

/** `answered`: the venue replied with a structured error code, as opposed to a timeout, a 5xx or an unreadable body. */
interface TransferResult { outcome: 'accepted' | 'rejected' | 'unknown'; answered: boolean; sentAt: number; receivedAt: number | null; status: number | null; code: unknown; message: unknown; tranId: string | null; keys: string[] }

async function transfer(report: Report, name: string, master: Credentials, source: Credentials, destination: Credentials, amount: string, nonceOffsetSeconds = 0): Promise<TransferResult> {
  const parameters = { toAccountAddress: destination.user.toLowerCase(), asset: ASSET, amount, kindType: 'FUTURE_FUTURE', fromAccountAddress: source.user.toLowerCase() };
  const entry = { name, at: new Date().toISOString(), outcome: 'sending' };
  report.writes.push(entry);
  const sentAt = Date.now();
  let result: HttpResult;
  try { result = await signedCall(master, 'POST', '/fapi/v3/subAccountTransfer', parameters, { signerOnly: true, nonceOffsetSeconds, timeoutMs: WRITE_TIMEOUT_MS }); }
  catch (error) {
    // A gateway block (403/418/429) says nothing about whether the transfer ran.
    if (!(error instanceof HttpFailure)) { entry.outcome = error instanceof NotSent ? 'not-sent' : error instanceof Throttled && error.refused ? 'rejected' : 'unknown'; throw error; }
    entry.outcome = 'unknown';
    return { outcome: 'unknown', answered: false, sentAt, receivedAt: null, status: null, code: null, message: error.message, tranId: null, keys: [] };
  }
  const body = result.body, code = isRow(body) ? body.code : null, message = isRow(body) ? body.msg : body;
  const accepted = isRow(body) && [0, 200, '0', '200'].includes(code as number | string) && typeof message === 'string' && message.trim().toLowerCase() === 'success';
  const rejected = !accepted && result.status < 500 && result.status !== 408 && typeof code === 'number' && REJECTION_CODES.has(code);  const outcome = accepted ? 'accepted' : rejected ? 'rejected' : 'unknown';
  entry.outcome = outcome;
  const answered = !accepted && result.status < 500 && result.status !== 408 && typeof code === 'number' && code < 0 && !UNCERTAIN_CODES.has(code);
  return { outcome, answered, sentAt: result.sentAt, receivedAt: result.receivedAt, status: result.status, code, message, tranId: isRow(body) ? text(body.tranId) : null, keys: isRow(body) ? Object.keys(body) : [] };
}

interface Seen { pollSentAfterMs: number; pollReceivedAfterMs: number; polls: number }
interface Observation {
  timedOut: boolean;
  waitedMs: number;
  /** Polls that failed to read; a throttle still aborts the run. */
  readErrors: number;
  balance: Record<'source' | 'destination', { walletExact: Seen | null; firstChange: Record<string, Seen & { from: string | null; to: string | null }> }>;
  income: Record<'source' | 'destination', { seen: Seen | null; rows: Row[] }>;
}

/**
 * Polls both balances and both income feeds after a send until the transfer shows on all four,
 * or `limitMs`. Times are relative to `origin` (receipt time, or send time when there is none).
 * Balances are read every second for 30 s and then every 5 s; income (weight 30) every 5 s and then every 15 s.
 */
async function observe(source: Credentials, destination: Credentials, amount: string, origin: number, historyFrom: number,
  baseline: Record<'source' | 'destination', Balance>, knownIds: Record<'source' | 'destination', Set<string>>, limitMs: number): Promise<Observation> {
  const sides = { source, destination }, expected = { source: '-' + amount, destination: amount };
  const result: Observation = { timedOut: false, waitedMs: 0, readErrors: 0,
    balance: { source: { walletExact: null, firstChange: {} }, destination: { walletExact: null, firstChange: {} } },
    income: { source: { seen: null, rows: [] }, destination: { seen: null, rows: [] } } };
  let balancePolls = 0, incomePolls = 0, nextBalance = 0, nextIncome = 0;
  // One failed read must not end an observation that follows a real transfer.
  const attempt = async <T>(read: () => Promise<T>): Promise<T | null> => {
    try { return await read(); }
    catch (error) { if (error instanceof Throttled || !(error instanceof HttpFailure || error instanceof ProbeAbort)) throw error; result.readErrors++; return null; }
  };
  for (;;) {
    const elapsed = Date.now() - origin;
    if (elapsed >= nextBalance) {
      balancePolls++;
      nextBalance = elapsed + (elapsed < 30_000 ? 1_000 : 5_000);
      for (const side of ['source', 'destination'] as const) {
        const state = await attempt(() => balance(sides[side]));
        if (!state) continue;
        const seen = { pollSentAfterMs: state.sentAt - origin, pollReceivedAfterMs: state.receivedAt - origin, polls: balancePolls };
        const before = wallet(baseline[side]), now = wallet(state);
        if (!result.balance[side].walletExact && before !== null && now !== null && cmp(sub(now, before), expected[side]) === 0) result.balance[side].walletExact = seen;
        for (const field of BALANCE_FIELDS) {
          const from = baseline[side].values[field], to = state.values[field];
          if (!(field in result.balance[side].firstChange) && from !== to) result.balance[side].firstChange[field] = { ...seen, from, to };
        }
      }
    }
    if (elapsed >= nextIncome) {
      incomePolls++;
      nextIncome = elapsed + (elapsed < 30_000 ? 5_000 : 15_000);      for (const side of ['source', 'destination'] as const) {
        if (result.income[side].seen) continue;
        const page = await attempt(() => income(sides[side], historyFrom, null));
        if (!page) continue;
        const fresh = page.transfers.filter(row => { const id = tranId(row); return id === null || !knownIds[side].has(id); });
        const matching = fresh.filter(row => { const value = decimalText(row.income); return value !== null && cmp(value, expected[side]) === 0; });
        if (matching.length) { result.income[side].seen = { pollSentAfterMs: page.sentAt - origin, pollReceivedAfterMs: page.receivedAt - origin, polls: incomePolls }; result.income[side].rows = fresh; }
      }
    }
    result.waitedMs = Date.now() - origin;
    if (result.balance.source.walletExact && result.balance.destination.walletExact && result.income.source.seen && result.income.destination.seen) return result;
    if (result.waitedMs >= limitMs) { result.timedOut = true; return result; }
    await sleep(250);
  }
}

/** Queries around one known row's `time` to show whether `startTime` and `endTime` include their own millisecond. */
async function endTimeProbe(credentials: Credentials, row: Row): Promise<unknown> {
  const id = tranId(row), at = Number(text(row.time));
  if (id === null || !Number.isSafeInteger(at)) return { skipped: '流水行缺少 tranId 或 time' };
  const windows: [string, number, number | null][] = [
    ['startTime = T, endTime = T', at, at], ['startTime = T - 1000, endTime = T', at - 1000, at], ['startTime = T - 1000, endTime = T - 1', at - 1000, at - 1],
    ['startTime = T + 1, endTime = T + 1000', at + 1, at + 1000], ['startTime = T, 不传 endTime', at, null], ['startTime = T, endTime = 一小时后', at, Date.now() + 3_600_000],
  ];
  const results = [];
  for (const [window, start, end] of windows) {
    const page = await income(credentials, start, end);
    results.push({ window, rowPresent: page.transfers.some(candidate => tranId(candidate) === id), transferRows: page.transfers.length, totalRows: page.total });
  }
  return { rowTime: at, results };
}

async function main(): Promise<number> {
  const flags = readFlags(process.argv.slice(2), ['env-file', 'master-prefix', 'a-prefix', 'b-prefix', 'amount', 'probe-nonce', 'settle-timeout-s', 'history-minutes', 'out', 'confirm'], ['live', 'balancer-paused', 'help']);
  if (flags.help) {
    process.stdout.write('用法：node server/contract-probes/aster-transfer.ts --master-prefix <前缀> --a-prefix <前缀> --b-prefix <前缀> [--env-file <.env>] [--amount 1]\n'
      + '      [--live --confirm <短语>] [--balancer-paused] [--probe-nonce=-30,-59,-61,-90,-121,61] [--settle-timeout-s 300] [--history-minutes 30] [--out 报告.json]\n'
      + '不带 --live 只做签名读取；确认短语由只读运行打印。A 或 B 有持仓时，须先暂停该配对的保证金平衡并加 --balancer-paused。\n');
    return 0;
  }
  const env = environment(flags['env-file'] as string | undefined);
  const master = credentialsFor(env, flags['master-prefix'] as string | undefined, '主账户');
  const a = credentialsFor(env, flags['a-prefix'] as string | undefined, '子账户 A'), b = credentialsFor(env, flags['b-prefix'] as string | undefined, '子账户 B');
  registerSecrets(...[master, a, b].flatMap(item => [item.privateKey, item.privateKey.replace(/^0x/, '')]));
  const users = [a.user.toLowerCase(), b.user.toLowerCase()];
  if (users[0] === users[1] || users.includes(master.user.toLowerCase())) throw new ProbeAbort('A、B 必须是主账户之外的两个不同子账户');
  if ([a.signer.toLowerCase(), b.signer.toLowerCase(), master.user.toLowerCase()].includes(master.signer.toLowerCase())) throw new ProbeAbort('划转必须使用独立授权的主账户 API signer');
  const amount = positiveDecimal((flags.amount as string | undefined) ?? '1', '--amount', 8);
  if (cmp(amount, MAX_AMOUNT) > 0) throw new ProbeAbort(`--amount 不能超过 ${MAX_AMOUNT} ${ASSET}`);
  const offsets = flags['probe-nonce'] === undefined ? [] : String(flags['probe-nonce']).split(',').map(item => item.trim());
  if (offsets.length > MAX_NONCE_PROBES || offsets.some(item => !/^-?\d{1,3}$/.test(item) || Number(item) === 0 || Math.abs(Number(item)) > 600) || new Set(offsets.map(Number)).size !== offsets.length)
    throw new ProbeAbort(`--probe-nonce 最多 ${MAX_NONCE_PROBES} 个、每个为 ±600 秒内互不相同的非零整数`);
  // Stale offsets first: a nonce accepted from the future may make the venue refuse every lower one after it.
  const nonceOffsets = offsets.map(Number).sort((left, right) => left - right);
  const probeAmounts = nonceOffsets.map((_, index) => add(amount, mul(NONCE_PROBE_STEP, String(index + 1))));
  const settleLimitMs = boundedInteger(flags['settle-timeout-s'] as string | undefined, '--settle-timeout-s', 300, 10, 900) * 1000;
  const historyMs = boundedInteger(flags['history-minutes'] as string | undefined, '--history-minutes', 30, 1, 1440) * 60_000;
  // A probe refused with an unlisted code is watched until its nonce should have expired; the watch must be allowed that long.
  const horizonMs = NONCE_HORIZON_MS + Math.max(0, ...nonceOffsets) * 1000;
  if (nonceOffsets.length && horizonMs > settleLimitMs) throw new ProbeAbort(`--probe-nonce 的最大正偏移加 ${NONCE_HORIZON_MS / 1000} 秒超过 --settle-timeout-s：请把 --settle-timeout-s 调到至少 ${Math.ceil(horizonMs / 1000)}（上限 900）或减小偏移`);
  const phrase = `aster-transfer-${amount}-${ASSET}-${a.prefix}-${b.prefix}-nonce${nonceOffsets.length ? nonceOffsets.join('_') : 'none'}`;
  // Without --live the offsets only shape the phrase: a read-only run sends no transfer.
  const live = liveAllowed(flags, phrase);

  const report = createReport('aster-transfer', live ? 'live' : 'read-only', { amount, asset: ASSET, nonceOffsets, probeAmounts, settleLimitMs, historyMs, balancerPaused: flags['balancer-paused'] === true, prefixes: { master: master.prefix, a: a.prefix, b: b.prefix } });
  const out = (flags.out as string | undefined) ?? `contract-aster-transfer-${report.startedAt.replace(/[:.]/g, '-')}.json`;
  reserveReport(out);
  watchSignals();
  const startedAt = Date.now();
  let exitCode = 1;
  try {
    const timeResult = await exchange(BASE + '/fapi/v3/time', { method: 'GET', headers: { 'User-Agent': 'AsterAccountDesk/1.0' } }, READ_TIMEOUT_MS).catch(error => { if (error instanceof HttpFailure) return { error: error.message }; throw error; });
    const serverTime = 'body' in timeResult && isRow(timeResult.body) && typeof timeResult.body.serverTime === 'number' ? timeResult.body.serverTime : null;
    const clockOffsetMs = serverTime === null || !('sentAt' in timeResult) ? null : Math.round(serverTime - (timeResult.sentAt + timeResult.receivedAt) / 2);
    step(report, '服务器时间', 'error' in timeResult ? timeResult : { status: timeResult.status, body: timeResult.body, roundTripMs: timeResult.receivedAt - timeResult.sentAt, clockOffsetMs });
    report.findings.clock = { serverTimeEndpointUsable: serverTime !== null, exchangeMinusLocalMs: clockOffsetMs };

    const listing = readOk(await signedCall(master, 'GET', '/fapi/v3/getSubAccountList', {}), '子账户列表');
    const balances = { a: await balance(a), b: await balance(b) };
    const rows = Array.isArray(listing) ? listing.filter(isRow) : [];
    const locate = (credentials: Credentials, accountId: string | null): Row | null => {
      const byAddress = rows.filter(row => ADDRESS_FIELDS.some(field => typeof row[field] === 'string' && (row[field] as string).toLowerCase() === credentials.user.toLowerCase()));
      const matches = byAddress.length ? byAddress : accountId === null ? [] : rows.filter(row => text(row.accountId) === accountId);
      return matches.length === 1 ? matches[0]! : null;
    };
    const members = { a: locate(a, balances.a.accountId), b: locate(b, balances.b.accountId) };
    const usable = (row: Row | null): boolean => row !== null && row.parentAccount === false && !['FROZEN', 'FREEZE'].includes(String(row.status ?? row.subAccountStatus));
    const ownershipVerified = rows.filter(row => row.parentAccount === true).length === 1 && usable(members.a) && usable(members.b) && members.a !== members.b;
    // Only the fields the check uses are kept: the venue's rows may carry names or remarks.
    const shown = (row: Row | null): unknown => row && { parentAccount: row.parentAccount, status: row.status ?? row.subAccountStatus ?? null };
    step(report, '子账户列表（主账户读取）', { rows: rows.length, rowKeys: [...new Set(rows.flatMap(row => Object.keys(row)))], a: shown(members.a), b: shown(members.b), ownershipVerified });
    report.findings.ownership = { verified: ownershipVerified, addressFieldsPresent: ADDRESS_FIELDS.filter(field => rows.some(row => typeof row[field] === 'string')) };
    for (const side of ['a', 'b'] as const) step(report, `余额基线 ${side.toUpperCase()}`, { sentAt: balances[side].sentAt, receivedAt: balances[side].receivedAt, serverDate: balances[side].serverDate, values: balances[side].values, openPositions: balances[side].openPositions, assetRowKeys: Object.keys(balances[side].row), timeFields: balances[side].timeFields });
    report.findings.balanceTimeFields = { a: balances.a.timeFields, b: balances.b.timeFields };
    report.findings.openPositions = { a: balances.a.openPositions, b: balances.b.openPositions };

    const historyFrom = startedAt - historyMs;
    const history = { a: await income(a, historyFrom, null), b: await income(b, historyFrom, null) };
    for (const side of ['a', 'b'] as const) step(report, `流水基线 ${side.toUpperCase()}`, { totalRows: history[side].total, transferRows: history[side].transfers });
    const idsOf = (page: Income): Set<string> => new Set(page.transfers.map(tranId).filter((id): id is string => id !== null));
    const known = { a: idsOf(history.a), b: idsOf(history.b) };

    if (!live) {
      const sample = history.a.transfers[0] ?? null;
      if (sample) { report.findings.endTime = await endTimeProbe(a, sample); step(report, 'endTime 边界（用 A 的已有流水）', report.findings.endTime); }
      else step(report, 'endTime 边界', { skipped: `A 在最近 ${historyMs / 60_000} 分钟没有 ${ASSET} 划转流水；--live 运行会用新产生的流水测` });
      report.outcome = 'read-only-complete';
      process.stdout.write(`\n只读检查完成，未发送任何划转。真实划转需加：--live --confirm ${phrase}\n`);
      exitCode = 0;
      return exitCode;
    }

    if (!ownershipVerified) throw new ProbeAbort('无法从主账户的子账户列表核实 A、B 的归属与状态，不发送划转');
    // The production margin balancer moves funds between paired accounts; with positions open it could
    // transfer at the same moment and the probe would misread its rows, or the probe could thin margin.
    if (flags['balancer-paused'] !== true && !(balances.a.openPositions === 0 && balances.b.openPositions === 0))
      throw new ProbeAbort('A 或 B 有持仓（或应答无法确认没有持仓）：请先暂停该配对的保证金平衡，再加 --balancer-paused 运行');
    const needed = nonceOffsets.length ? add('0', ...probeAmounts) : amount;
    const withdrawable = balances.a.values.maxWithdrawAmount;
    if (withdrawable === null || cmp(withdrawable, cmp(needed, amount) > 0 ? needed : amount) < 0) throw new ProbeAbort(`A 的可划转额度不足 ${needed} ${ASSET}，不发送划转`);

    type Side = 'a' | 'b';
    const accounts = { a, b };
    let slowestSettledMs = 0;
    // How long to watch after the venue answered with an error code outside the old refusal list: past the point
    // where the request's nonce should have expired, which the argument check keeps within --settle-timeout-s.
    const quietLimitMs = (nonceOffsetSeconds: number): number => Math.max(NONCE_HORIZON_MS + Math.max(0, nonceOffsetSeconds) * 1000, Math.min(settleLimitMs, 3 * slowestSettledMs));
    // Sends one transfer and, unless it was definitely refused, watches both sides for it.
    const sendAndWatch = async (name: string, sourceSide: Side, value: string, nonceOffsetSeconds: number) => {
      const destinationSide: Side = sourceSide === 'a' ? 'b' : 'a', source = accounts[sourceSide], destination = accounts[destinationSide];
      const nonceAheadOfEarlierMs = await clearOfEarlierNonces(master, nonceOffsetSeconds);
      const before = { source: await balance(source), destination: await balance(destination) };
      const receipt = await transfer(report, name, master, source, destination, value, nonceOffsetSeconds);
      step(report, `${name}：回执`, { ...receipt, nonceAheadOfEarlierMs });
      if (receipt.outcome === 'rejected') return { receipt, nonceAheadOfEarlierMs, seen: null, sourceRow: null, landed: false, summary: null };
      const origin = receipt.receivedAt ?? receipt.sentAt;
      const seen = await observe(source, destination, value, origin, receipt.sentAt - 60_000, before, { source: known[sourceSide], destination: known[destinationSide] },
        receipt.outcome === 'unknown' && receipt.answered ? quietLimitMs(nonceOffsetSeconds) : settleLimitMs);
      if (receipt.outcome === 'accepted' && !seen.timedOut) slowestSettledMs = Math.max(slowestSettledMs, seen.waitedMs);
      const sourceRow = seen.income.source.rows.find(row => cmp(decimalText(row.income) ?? '0', '-' + value) === 0) ?? null;
      const destinationRow = seen.income.destination.rows.find(row => cmp(decimalText(row.income) ?? '0', value) === 0) ?? null;
      const ids = { receipt: receipt.tranId, source: sourceRow && tranId(sourceRow), destination: destinationRow && tranId(destinationRow) };
      const summary = {
        receipt: { outcome: receipt.outcome, tranIdPresent: receipt.tranId !== null, keys: receipt.keys, roundTripMs: receipt.receivedAt === null ? null : receipt.receivedAt - receipt.sentAt },
        tranIds: { ...ids, bothSidesEqual: ids.source !== null && ids.source === ids.destination, receiptMatchesSource: ids.receipt !== null && ids.receipt === ids.source },
        incomeTypes: { source: sourceRow?.incomeType ?? null, destination: destinationRow?.incomeType ?? null },
        rowTimeMinusLocalSendMs: { source: sourceRow ? Number(text(sourceRow.time)) - receipt.sentAt : null, destination: destinationRow ? Number(text(destinationRow.time)) - receipt.sentAt : null },
        visibleAfterReceiptMs: seen,
      };
      step(report, `${name}：入账观察`, summary);
      for (const row of seen.income.source.rows) { const id = tranId(row); if (id !== null) known[sourceSide].add(id); }
      for (const row of seen.income.destination.rows) { const id = tranId(row); if (id !== null) known[destinationSide].add(id); }
      const landed = receipt.outcome === 'accepted' || sourceRow !== null || destinationRow !== null || seen.balance.source.walletExact !== null || seen.balance.destination.walletExact !== null;
      return { receipt, nonceAheadOfEarlierMs, seen, sourceRow, landed, summary };
    };

    // A leg that must succeed and settle; false stops every later write.
    const leg = async (name: string, sourceSide: Side, value: string): Promise<boolean> => {
      const sent = await sendAndWatch(name, sourceSide, value, 0);
      if (sent.receipt.outcome === 'rejected') { report.outcome = `${name} 被明确拒绝`; return false; }
      (report.findings.transfers ??= {} as Record<string, unknown>);
      (report.findings.transfers as Record<string, unknown>)[name] = sent.summary;
      if (sent.receipt.outcome === 'unknown') { report.outcome = `${name} 结果未知：不重发，已按流水观察`; return false; }
      if (sent.seen!.timedOut) { report.outcome = `${name} 已回执，但 ${settleLimitMs / 1000} 秒内未在两侧余额与流水全部可见`; return false; }
      if (sent.sourceRow && !report.findings.endTime) { report.findings.endTime = await endTimeProbe(accounts[sourceSide], sent.sourceRow); step(report, 'endTime 边界（用本次转出流水）', report.findings.endTime); }
      return true;
    };

    let proceed = await leg('划转 A→B', 'a', amount);
    if (proceed) proceed = await leg('划回 B→A', 'b', amount);

    if (proceed && nonceOffsets.length) {
      const probes = [];
      const landed: string[] = [];
      let stopped: string | null = null;
      for (const [index, offset] of nonceOffsets.entries()) {
        const value = probeAmounts[index]!;
        const sent = await sendAndWatch(`nonce 偏移 ${offset} 秒 A→B ${value}`, 'a', value, offset);
        // The venue answered with an unlisted error code and nothing showed on either side while watching.
        const refusedUnlisted = sent.receipt.outcome === 'unknown' && sent.receipt.answered && !sent.landed && sent.seen?.readErrors === 0;
        probes.push({ offsetSeconds: offset, amount: value, outcome: refusedUnlisted ? 'refused-unlisted' : sent.receipt.outcome, watchedMs: sent.seen?.waitedMs ?? null, landed: sent.landed, status: sent.receipt.status, code: sent.receipt.code, message: sent.receipt.message,
          tranIdPresent: sent.receipt.tranId !== null, nonceAheadOfEarlierMs: sent.nonceAheadOfEarlierMs, timedOut: sent.seen?.timedOut ?? null });
        if (sent.landed) landed.push(value);
        if (refusedUnlisted) { report.writes[report.writes.length - 1]!.outcome = 'refused-unlisted'; continue; }
        if (sent.receipt.outcome === 'unknown') { stopped = 'nonce 探测中有一笔结果未知：不重发、不自动划回，请按流水核对'; break; }
        if (sent.seen?.timedOut) { stopped = 'nonce 探测中有一笔已回执但未在限时内全部可见：不继续、不自动划回，请按流水核对'; break; }
      }
      const finding = { exchangeMinusLocalMs: clockOffsetMs, probes,
        note: '每笔探测前都等到其 nonce 晚于主账户 signer 此前发出的全部 nonce（nonceAheadOfEarlierMs 为正），拒绝不应来自 nonce 递增要求；偏移按升序发送，未来 nonce 被接受后更小的 nonce 是否仍可用不在本探测范围。refused-unlisted 表示交易所返回了旧实现拒绝码清单之外的错误码（不含旧实现视为结果不确定的 -1000、-1001、-1006、-1007），且观察 watchedMs 内两侧余额与流水每次都读取成功、均无变化' };
      step(report, 'nonce 有效期探测', finding);
      report.findings.nonce = finding;
      if (stopped) { report.outcome = stopped; proceed = false; }
      // Returned one by one, so no single transfer exceeds a probe's own amount.
      else for (const value of landed) { proceed = await leg(`划回 nonce 探测 ${value} B→A`, 'b', value); if (!proceed) break; }
    }

    const finalIncome = { a: await income(a, startedAt - 60_000, null), b: await income(b, startedAt - 60_000, null) };
    const initial = { a: idsOf(history.a), b: idsOf(history.b) };
    const net = (page: Income, before: Set<string>): string => add('0', ...page.transfers.filter(row => { const id = tranId(row); return id === null || !before.has(id); }).map(row => decimalText(row.income) ?? '0'));
    const netTransfers = { a: net(finalIncome.a, initial.a), b: net(finalIncome.b, initial.b) };
    const finalBalances = { a: await balance(a), b: await balance(b) };
    step(report, '收尾核对', { netTransferIncome: netTransfers, walletBefore: { a: wallet(balances.a), b: wallet(balances.b) }, walletAfter: { a: wallet(finalBalances.a), b: wallet(finalBalances.b) } });
    report.findings.net = netTransfers;
    const balanced = cmp(netTransfers.a, '0') === 0 && cmp(netTransfers.b, '0') === 0;
    if (proceed && balanced) { report.outcome = 'complete'; exitCode = 0; }
    else { if (proceed) report.outcome = '划转流水净额不为零，请核对两侧余额'; exitCode = 2; }
    return exitCode;
  } catch (error) {
    report.outcome = (error instanceof Error ? error.message : String(error));
    exitCode = report.writes.some(entry => entry.outcome !== 'not-sent') ? 2 : 1;
    process.exitCode = exitCode;
    throw error;
  } finally {
    ignoreInterrupt();
    process.exitCode = exitCode;
    report.findings.requestWeight = { peakUsedWeight: weight.peak, readPauses: weight.pauses };
    process.stdout.write(`\n结果：${safeText(report.outcome)}\n报告已写入 ${saveReport(report, out)}（已隐去密钥与签名，地址只保留首尾）\n`);
    if (exitCode === 2) process.stdout.write('已发送过划转且未正常收尾：请在交易所核对 A、B 两侧余额与划转流水，脚本不会重发或自动补划。\n');
  }
}

main().then(code => { process.exitCode = code; }, error => {
  process.stderr.write((error instanceof ProbeAbort ? '已中止：' : '运行失败：') + safeText(error) + '\n');
  process.exitCode = process.exitCode || 1;
});
