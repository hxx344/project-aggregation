// Oil two-leg live canary, driven step by step from the workbench page (plan 3.0d). Each step is one short process: the
// caller takes the account locks and hands over connectors whose keys passed preflight; this module opens the canary's own
// executor database, does one thing and gives the lease back. A live step keeps ticking its job until the executor calls
// it final, because the next process is a new writer and never sends anything new for an earlier job (takeover recovery).
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { add, cmp, sub } from '../decimal.ts';
import { ContractError, OIL_SYMBOLS, accountKey, type AccountBinding, type NotionalLimits } from '../contracts.ts';
import { STRATEGY_ID, type VenueConnector } from '../connector.ts';
import { DATABASE_FILES, claimDataDirEnvironment } from '../data-dir.ts';
import { createExecutor, type Executor } from '../executor.ts';
import { openStore, type Store } from '../store.ts';
import { describe } from './values.ts';

export const CANARY_STEPS = ['check', 'open', 'close', 'settle'] as const;
export type CanaryStep = typeof CANARY_STEPS[number];
type CanaryVenue = 'binance' | 'bybit';
const CANARY_VENUES: readonly CanaryVenue[] = ['binance', 'bybit'];
/** Ceilings in USDT, whatever the page or the command line asks for. The open total counts for the life of the database. */
export const CANARY_PER_JOB_CEILING = '200';
export const CANARY_TOTAL_OPEN_CEILING = '500';
const MAX_SLIPPAGE_BPS = 200;
const SESSION = 'workbench-canary';
const ACCOUNT_READ_MS = 15_000;
const TICK_MS = 1_000;
const MAX_TICK_FAILURES = 5;
/** After a job's own deadline: time for the hedge, the cancels and a chase's children to settle. */
const SETTLE_GRACE_MS = 180_000;
const RECENT_JOBS = 100;
const FINAL = new Set(['completed', 'failed', 'stopped', 'attention']);

/** Refused before anything left this process. */
export class CanaryRefusal extends Error {}

/** How a settle resolves a chase whose create got no answer: prove it absent, claim it by id, or release it as possibly executed. */
export const STRATEGY_RECOVERY = ['auto', 'adopt', 'release'] as const;
export type StrategyRecovery = typeof STRATEGY_RECOVERY[number];

export interface CanaryParams {
  step: CanaryStep; symbol: string; lead: CanaryVenue; leadSide: 'long' | 'short'; leadOrder: 'market' | 'chase';
  quantity: string; perJob: string; totalOpen: string; timeoutS: number; maxSlippageBps: number | null;
  strategy: StrategyRecovery; strategyId: string | null;
}

const oneOf = <T extends string>(value: string | undefined, allowed: readonly T[], name: string): T => {
  if (!allowed.includes(value as T)) throw new CanaryRefusal(`${name}须为 ${allowed.join('、')} 之一`);
  return value as T;
};
const amount = (value: string | undefined, name: string, ceiling: string | null): string => {
  if (typeof value !== 'string' || !/^\d{1,9}(?:\.\d{1,8})?$/.test(value) || cmp(value, '0') <= 0) throw new CanaryRefusal(`${name}须为正的十进制数`);
  if (ceiling !== null && cmp(value, ceiling) > 0) throw new CanaryRefusal(`${name}不得超过 ${ceiling}`);
  return add(value);
};
const whole = (value: string | undefined, name: string, low: number, high: number): number => {
  const parsed = Number(value);
  if (typeof value !== 'string' || !/^\d{1,6}$/.test(value) || parsed < low || parsed > high) throw new CanaryRefusal(`${name}须为 ${low} 至 ${high} 的整数`);
  return parsed;
};

/** Command-line values (strings); the page's whitelist is checked again here. */
export function parseCanaryParams(raw: Record<string, string | undefined>): CanaryParams {
  const lead = oneOf(raw.lead, CANARY_VENUES, '首腿交易所'), leadOrder = oneOf(raw.leadOrder, ['market', 'chase'] as const, '首腿下单方式');
  if (leadOrder === 'chase' && lead !== 'bybit') throw new CanaryRefusal('只有 Bybit 首腿可以用原生追价');
  const perJob = amount(raw.perJob, '单笔名义金额上限', CANARY_PER_JOB_CEILING), totalOpen = amount(raw.totalOpen, '累计开仓名义金额上限', CANARY_TOTAL_OPEN_CEILING);
  if (cmp(perJob, totalOpen) > 0) throw new CanaryRefusal('单笔名义金额上限不得大于累计开仓上限');
  const step = oneOf(raw.step, CANARY_STEPS, '步骤'), strategy = raw.strategy === undefined ? 'auto' : oneOf(raw.strategy, STRATEGY_RECOVERY, '追价策略处理方式');
  if (strategy !== 'auto' && step !== 'settle') throw new CanaryRefusal('认领或强制释放追价策略只在「收尾」里做');
  if ((strategy === 'adopt') !== (raw.strategyId !== undefined)) throw new CanaryRefusal(strategy === 'adopt' ? '认领追价策略须填写策略编号' : '只有认领追价策略时填写策略编号');
  if (raw.strategyId !== undefined && !STRATEGY_ID.test(raw.strategyId)) throw new CanaryRefusal('策略编号只能是字母、数字、下划线或连字符，最长 100 位');
  return {
    step, symbol: oneOf(raw.symbol, OIL_SYMBOLS, '合约'), lead, leadSide: oneOf(raw.leadSide, ['long', 'short'] as const, '首腿方向'), leadOrder,
    quantity: amount(raw.quantity, '每腿数量', null), perJob, totalOpen, timeoutS: whole(raw.timeoutS, '最长执行秒数', 30, 600),
    maxSlippageBps: raw.maxSlippageBps === undefined ? null : whole(raw.maxSlippageBps, '价格保护基点', 1, MAX_SLIPPAGE_BPS),
    strategy, strategyId: raw.strategyId ?? null,
  };
}

export interface CanaryDeps {
  /** The canary's own executor directory. */
  dir: string;
  /** One account per venue, each of which passed preflight with the connectors below. */
  accounts: readonly AccountBinding[];
  connectors: readonly VenueConnector[];
  log(line: string): void;
  wait(ms: number): Promise<void>;
  /** The operator asked to stop: no new job, and a running one is asked to stop. */
  stopRequested(): boolean;
  now?: () => number;
}

export interface CanaryOutcome {
  /** A job was confirmed, so orders may have left. */
  sent: boolean;
  /** Every job this step touched is final and acknowledged where needed, and the step completed as asked. */
  settled: boolean;
  summary: string;
  findings: Record<string, unknown>;
}

export interface PreparedCanary {
  /** What the live run must be confirmed with; null when the step has nothing to send. */
  phrase: string | null;
  summary: string;
  findings: Record<string, unknown>;
  execute(): Promise<CanaryOutcome>;
  close(): void;
}

type JobView = ReturnType<Executor['jobView']>;
const VENUE_NAMES: Record<CanaryVenue, string> = { binance: 'Binance', bybit: 'Bybit' };
const STATUS_NAMES: Record<string, string> = { accepted: '已接受', running: '执行中', completed: '已完成', failed: '失败', stopped: '已停止', attention: '待人工确认' };
const mask = (id: string): string => id.length > 4 ? `***${id.slice(-4)}` : '***';
const neg = (value: string): string => sub('0', value);
const abs = (value: string): string => cmp(value, '0') < 0 ? neg(value) : value;
const other = (venue: CanaryVenue): CanaryVenue => venue === 'binance' ? 'bybit' : 'binance';
const opposite = (side: 'long' | 'short'): 'long' | 'short' => side === 'long' ? 'short' : 'long';
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 10);

/** Full account key of each leg; the page view masks the account, so it is read from the job record. */
function legAccounts(store: Store, jobId: string): string[] {
  const row = store.db.prepare('SELECT json FROM jobs WHERE id = ?').get(jobId) as { json: string } | undefined;
  const legs: unknown = row ? (JSON.parse(row.json) as { legs?: unknown }).legs : undefined;
  return Array.isArray(legs) ? legs.map(leg => typeof (leg as { accountKey?: unknown })?.accountKey === 'string' ? (leg as { accountKey: string }).accountKey : '') : [];
}
/**
 * Signed quantity per venue that the canary's own jobs filled on this symbol in the accounts bound now: long positive,
 * short negative. A leg on an account the workbench no longer uses is not the canary's to close here.
 */
function ownNet(jobs: readonly JobView[], symbol: string, keysOf: (jobId: string) => string[], current: ReadonlySet<string>): Record<CanaryVenue, string> {
  const net: Record<CanaryVenue, string> = { binance: '0', bybit: '0' };
  for (const job of jobs) for (const [index, leg] of job.legs.entries()) {
    if (leg.symbol !== symbol || !CANARY_VENUES.includes(leg.venue as CanaryVenue) || !current.has(keysOf(job.id)[index])) continue;
    const signed = leg.side === 'long' ? leg.filledQuantity : neg(leg.filledQuantity);
    net[leg.venue as CanaryVenue] = job.action === 'open' ? add(net[leg.venue as CanaryVenue], signed) : sub(net[leg.venue as CanaryVenue], signed);
  }
  return net;
}
const jobLine = (job: JobView): string => `${job.action === 'open' ? '开仓' : '平仓'} ${STATUS_NAMES[job.status] ?? job.status}${job.reason ? `（${job.reason}）` : ''}：`
  + job.legs.map(leg => `${VENUE_NAMES[leg.venue as CanaryVenue] ?? leg.venue} ${leg.side === 'long' ? '多' : '空'} 成交 ${leg.filledQuantity}/${leg.plannedQuantity}${leg.operation?.averagePrice ? ` 均价 ${leg.operation.averagePrice}` : ''}`).join('，');
const jobFinding = (job: JobView) => ({ status: job.status, action: job.action, reason: job.reason, createdAt: new Date(job.createdAt).toISOString(), acknowledged: job.acknowledgedAt !== null,
  strategyPending: job.strategyPending, legs: job.legs.map(leg => ({ venue: leg.venue, side: leg.side, orderType: leg.orderType, planned: leg.plannedQuantity, filled: leg.filledQuantity,
    state: leg.operation?.state ?? null, averagePrice: leg.operation?.averagePrice ?? null, note: leg.operation?.note ?? null })), lastEvents: job.events.slice(-5).map(event => event.type) });

export async function prepareCanary(params: CanaryParams, deps: CanaryDeps): Promise<PreparedCanary> {
  const now = deps.now ?? Date.now;
  const accounts = CANARY_VENUES.map(venue => {
    const found = deps.accounts.filter(account => account.venue === venue);
    if (found.length !== 1 || found[0].environment !== 'mainnet') throw new CanaryRefusal(`金丝雀需要恰好一个 ${VENUE_NAMES[venue]} 实盘账户`);
    return found[0];
  });
  const limits: NotionalLimits = { perJob: params.perJob, totalOpen: params.totalOpen };
  mkdirSync(deps.dir, { recursive: true, mode: 0o700 });
  claimDataDirEnvironment(deps.dir, 'mainnet');
  const store: Store = openStore(join(deps.dir, DATABASE_FILES.mainnet));
  let executor: Executor | null = null, heartbeat: ReturnType<typeof setInterval> | null = null;
  const close = () => { if (heartbeat) clearInterval(heartbeat); executor?.close(); store.close(); };
  try {
    const ex = executor = createExecutor({ store, connectors: [...deps.connectors], environment: 'mainnet', notionalLimits: limits, now });
    // A step that ended cleanly handed the lease back; one that was killed holds it until it lapses.
    for (const until = now() + ex.budgets.leaseTtlMs + 5_000; !ex.acquire();) {
      if (now() > until) throw new CanaryRefusal('另一个进程持有金丝雀执行器的写入租约');
      await deps.wait(TICK_MS);
    }
    // Renewal runs apart from the ticks, as in main.ts, so a slow venue call cannot let the lease lapse; a lost lease is
    // seen by drive, which checks it before every pass.
    heartbeat = setInterval(() => { try { ex.acquire(); } catch { /* drive reports it */ } }, Math.floor(ex.budgets.leaseTtlMs / 3));
    heartbeat.unref();
    for (const account of accounts) {
      try { ex.registerAccount(account); }
      catch (error) {
        // The workbench switched accounts while a canary job still holds the old one: only the old binding can settle it.
        if (error instanceof ContractError && error.code === 'account_busy') throw new CanaryRefusal(`此前绑定的 ${VENUE_NAMES[account.venue as CanaryVenue]} 执行账户上还有未收尾的金丝雀任务：请先在交易中心换回原账户，做完收尾再换`);
        throw error;
      }
    }
    const plan = await planStep(ex, store, params, accounts, deps, now);
    return { ...plan, close };
  } catch (error) { close(); throw error; }
}

async function readAccounts(params: CanaryParams, accounts: readonly AccountBinding[], deps: CanaryDeps) {
  return Promise.all(accounts.map(async account => {
    const connector = deps.connectors.find(item => item.venue === account.venue);
    if (!connector) throw new CanaryRefusal(`没有 ${account.venue} 连接器`);
    const snapshot = await connector.account(account, [params.symbol], { signal: AbortSignal.timeout(ACCOUNT_READ_MS) });
    const position = snapshot.positions.filter(item => item.symbol === params.symbol).reduce((sum, item) => item.side === 'long' ? add(sum, item.quantity) : sub(sum, item.quantity), '0');
    return { venue: account.venue as CanaryVenue, accountId: mask(account.accountId), accountMode: account.accountMode, credentialVersion: account.credentialVersion,
      position, openOrders: snapshot.openOrders.filter(order => order.symbol === params.symbol).length };
  }));
}

async function planStep(ex: Executor, store: Store, params: CanaryParams, accounts: readonly AccountBinding[], deps: CanaryDeps, now: () => number): Promise<Omit<PreparedCanary, 'close'>> {
  const jobs = ex.recentJobs(RECENT_JOBS);
  if (jobs.length >= RECENT_JOBS) throw new CanaryRefusal(`金丝雀任务记录已达 ${RECENT_JOBS} 条，无法可靠汇总自有持仓；请换用新的金丝雀目录`);
  const keys = new Map<string, string[]>(), current = new Set(accounts.map(accountKey));
  const keysOf = (jobId: string): string[] => keys.get(jobId) ?? (keys.set(jobId, legAccounts(store, jobId)), keys.get(jobId)!);
  const netOf = (list: readonly JobView[]) => ownNet(list, params.symbol, keysOf, current);
  const net = netOf(jobs);
  // Rebinding is refused while a job holds the account (unfinished, or attention not yet acknowledged), so these jobs hold no lock.
  const foreign = jobs.filter(job => job.legs.some(leg => leg.symbol === params.symbol) && keysOf(job.id).some(key => !current.has(key)));
  const foreignNote = foreign.length ? `有 ${foreign.length} 个 ${params.symbol} 金丝雀任务做在此前绑定的执行账户上（执行账户已更换），自有持仓只统计当前账户，旧账户上的仓位请到交易所核对` : null;
  const unfinished = jobs.filter(job => !FINAL.has(job.status));
  const attention = jobs.filter(job => job.status === 'attention' && job.acknowledgedAt === null);
  const limits = ex.notionalLimits()!;
  const venues = await readAccounts(params, accounts, deps);
  const fingerprint = accounts.map(account => [account.venue, account.accountId, account.accountMode, account.credentialVersion]);
  const netText = CANARY_VENUES.map(venue => `${VENUE_NAMES[venue]} ${net[venue]}`).join('、');
  const base = { symbol: params.symbol, accounts: venues, canaryNet: net, limits, unfinished: unfinished.map(jobFinding), attention: attention.map(jobFinding), recentJobs: jobs.slice(0, 10).map(jobFinding) };
  const pending = unfinished.length + attention.length;
  for (const venue of venues) deps.log(`${VENUE_NAMES[venue.venue]} 账户 ${venue.accountId}（${venue.accountMode}）：${params.symbol} 持仓 ${venue.position}，该合约挂单 ${venue.openOrders} 笔`);
  deps.log(`金丝雀记录的自有持仓：${netText}；累计开仓已用 ${limits.openUsed} / ${limits.totalOpen} USDT，单笔上限 ${limits.perJob} USDT`);
  if (foreignNote) deps.log(foreignNote);
  const refuseNew = (): void => { if (pending) throw new CanaryRefusal(`有 ${pending} 个未结束或待人工确认的金丝雀任务，请先做「收尾」`); };

  if (params.step === 'check') {
    const problems = [
      ...venues.filter(venue => cmp(venue.position, net[venue.venue]) !== 0).map(venue => `${VENUE_NAMES[venue.venue]} 账户持仓 ${venue.position} 与金丝雀记录 ${net[venue.venue]} 不一致（可能含旧系统或人工仓位）`),
      ...venues.filter(venue => venue.openOrders).map(venue => `${VENUE_NAMES[venue.venue]} 该合约有 ${venue.openOrders} 笔挂单，开平仓会被拒绝`),
      ...(pending ? [`有 ${pending} 个未结束或待人工确认的金丝雀任务，请先做「收尾」`] : []),
      ...(foreignNote ? [foreignNote] : []),
    ];
    const summary = problems.length ? `检查完成，有待处理事项：${problems.join('；')}` : `检查通过：两个账户的密钥权限、IP 绑定与身份核对通过，账户持仓与金丝雀记录一致（${netText}）`;
    return { phrase: null, summary, findings: { ...base, problems }, execute: () => Promise.reject(new CanaryRefusal('检查只读，没有真实运行')) };
  }

  const orphans = attention.filter(job => job.strategyPending);
  if (params.step === 'settle') {
    if (!pending) return { phrase: null, summary: '没有未结束或待人工确认的金丝雀任务', findings: base, execute: () => Promise.reject(new CanaryRefusal('没有需要收尾的任务')) };
    if (params.strategy !== 'auto' && orphans.length !== 1) throw new CanaryRefusal(`认领或强制释放须恰好有一个追价策略创建结果未知的任务，现有 ${orphans.length} 个`);
    for (const job of [...unfinished, ...attention]) deps.log(`待收尾：${jobLine(job)}${job.strategyPending ? '（追价策略创建结果未知）' : ''}`);
    const ids = [...unfinished, ...attention].map(job => job.id);
    // The phrase changes when a job's state does, e.g. one that was running at the preview and waits on an unknown chase now.
    const states = [...unfinished, ...attention].map(job => [job.id, job.status, job.strategyPending]);
    const phrase = `oil-canary-settle-${pending}-${digest({ states, fingerprint, strategy: params.strategy, strategyId: params.strategyId })}`;
    // An adopted strategy the executor could not stop keeps trading after the job is acknowledged.
    const running = attention.filter(job => job.legs.some(leg => leg.operation?.adoptedAt && leg.operation.strategyStatus !== 'terminal'));
    const recovery = !orphans.length ? '' : params.strategy === 'adopt' ? `；追价策略按编号 ${params.strategyId} 认领（停掉仍在运行的部分），认领后的敞口处理完再做一次收尾确认`
      : params.strategy === 'release' ? '；追价策略强制释放（策略可能已成交，由人工在交易所处理），处理完再做一次收尾确认'
        : `；其中 ${orphans.length} 个追价策略创建结果未知，先自动核对未创建（创建请求已不可能送达、交易所无同时段策略、持仓与挂单与已知成交一致才通过）`;
    const stillRunning = running.length ? `；注意：${running.length} 个任务认领的追价策略最后记录仍未结束，确认前须已在 Bybit 停掉` : '';
    const summary = `可收尾：${unfinished.length} 个未结束任务继续核对到终态（首腿不再新发、撤其挂单，首腿已成交部分补发对冲腿），${attention.length} 个待人工确认任务将标记为已确认（请先到交易所处理剩余敞口）${recovery}${stillRunning}`;
    return { phrase, summary, findings: base, execute: async () => {
      const deadline = Math.max(now(), ...unfinished.map(job => job.deadlineAt)) + SETTLE_GRACE_MS;
      let driven: JobView[] = [];
      try { driven = unfinished.length ? await drive(ex, unfinished.map(job => job.id), deps, deadline, now) : []; }
      catch (error) { return { sent: unfinished.length > 0, settled: false, summary: `收尾中断，请到交易所核对：${describe(error)}`, findings: base }; }
      const errors: string[] = [], notes: string[] = [];
      let adopting = false;
      for (const job of attention) {
        try {
          if (job.strategyPending) {
            const request = { jobId: job.id, requestId: randomUUID() };
            // A claimed or released strategy may have traded: its exposure is seen and handled before the next settle acknowledges it.
            // Adoption stops a strategy still running, which is a write to the venue even when it then fails.
            if (params.strategy === 'adopt') { adopting = true; await ex.adoptStrategy({ ...request, strategyId: params.strategyId }, SESSION); notes.push('已认领追价策略，处理其敞口后再做一次收尾'); continue; }
            if (params.strategy === 'release') { ex.releaseStrategy({ ...request, acknowledgeRisk: true }, SESSION); notes.push('已强制释放追价策略，到交易所处理后再做一次收尾'); continue; }
            await ex.confirmNotCreated(request, SESSION);
          }
          ex.acknowledge(job.id, randomUUID(), SESSION);
        } catch (error) {
          errors.push(`任务 ${job.id.slice(0, 8)} 确认失败：${describe(error)}${job.strategyPending && params.strategy === 'auto' && !(error instanceof ContractError && error.code === 'create_window') ? '（可在 Bybit 查到策略编号后用收尾认领，或确认风险后强制释放）' : ''}`);
        }
      }
      const after = ids.map(id => ex.jobView(id));
      const left = after.filter(job => !FINAL.has(job.status) || (job.status === 'attention' && job.acknowledgedAt === null));
      const lines = [...after.map(jobLine), ...notes, ...errors];
      return { sent: driven.length > 0 || adopting, settled: left.length === 0 && errors.length === 0,
        summary: left.length || errors.length ? `收尾未完成：${lines.join('；')}` : `收尾完成：${lines.join('；')}`, findings: { ...base, after: after.map(jobFinding), errors } };
    } };
  }

  // open / close
  refuseNew();
  let leadSide = params.leadSide;
  if (params.step === 'close') {
    const leadNet = net[params.lead], otherNet = net[other(params.lead)];
    if (cmp(leadNet, '0') === 0) throw new CanaryRefusal(`金丝雀在 ${VENUE_NAMES[params.lead]} 没有可平的 ${params.symbol} 仓位`);
    leadSide = cmp(leadNet, '0') > 0 ? 'long' : 'short';
    // Only what the canary itself opened: the account may also hold the old system's position on this contract.
    if (cmp(otherNet, '0') === 0 || (cmp(otherNet, '0') > 0) === (leadSide === 'long')) throw new CanaryRefusal(`金丝雀在两家的 ${params.symbol} 仓位不是一多一空（${netText}），请先核对`);
    const room = cmp(abs(leadNet), abs(otherNet)) < 0 ? abs(leadNet) : abs(otherNet);
    if (cmp(params.quantity, room) > 0) throw new CanaryRefusal(`平仓数量 ${params.quantity} 超过金丝雀自有仓位 ${room}`);
    // The record can be wrong when someone closed by hand: the account must still hold the canary's side, at least this much.
    for (const venue of venues) {
      const own = net[venue.venue];
      if ((cmp(venue.position, '0') > 0) !== (cmp(own, '0') > 0) || cmp(venue.position, '0') === 0 || cmp(abs(venue.position), params.quantity) < 0) {
        throw new CanaryRefusal(`${VENUE_NAMES[venue.venue]} 账户持仓 ${venue.position} 不足以按金丝雀记录 ${own} 平 ${params.quantity}，请先核对`);
      }
    }
  }
  const intent = {
    market: 'oil', preset: 'cross-exchange', symbol: params.symbol, action: params.step, timeoutMs: params.timeoutS * 1000,
    ...(params.maxSlippageBps === null ? {} : { maxSlippageBps: params.maxSlippageBps }),
    legs: [{ venue: params.lead, side: leadSide, quantity: params.quantity, orderType: params.leadOrder },
      { venue: other(params.lead), side: opposite(leadSide), quantity: params.quantity, orderType: 'market' }],
  };
  const describePreview = (preview: Awaited<ReturnType<Executor['preview']>>): string => preview.legs.map(leg =>
    `${VENUE_NAMES[leg.venue as CanaryVenue]} ${leg.side === 'long' ? '多' : '空'} ${leg.quantity}（${leg.orderType === 'chase' ? '原生追价' : '市价'}，买一 ${leg.quote.bid} / 卖一 ${leg.quote.ask}，价格保护 ${leg.priceBound ?? '无'}）`).join('；')
    + `；名义金额约 ${preview.notional} USDT`;
  const preview = await ex.preview(intent, SESSION);
  const action = params.step === 'open' ? '开仓' : '平仓';
  deps.log(`${action}预览：${describePreview(preview)}`);
  for (const note of preview.notes) deps.log(`预览提示：${note}`);
  const phrase = `oil-canary-${params.step}-${params.symbol}-${params.lead}-${leadSide}-${params.leadOrder}-${params.quantity}-${digest({ params, leadSide, fingerprint, net: params.step === 'close' ? net : null })}`;
  return {
    phrase, summary: `${action}预览通过：${describePreview(preview)}${foreignNote ? `；${foreignNote}` : ''}`, findings: { ...base, preview: ex.publicPreview(preview) },
    execute: async () => {
      if (deps.stopRequested()) throw new CanaryRefusal('收到停止请求，未发送');
      const fresh = await ex.preview(intent, SESSION);
      deps.log(`${action}发送前重新预览：${describePreview(fresh)}`);
      if (deps.stopRequested()) throw new CanaryRefusal('收到停止请求，未发送');
      const { job } = ex.confirm({ previewId: fresh.id, requestId: randomUUID(), confirmLive: true }, SESSION);
      deps.log(`${action}任务已确认，开始执行`);
      // From here orders may have left: every failure is reported as sent and unsettled, never thrown as not sent.
      try {
        const [view] = await drive(ex, [job.id], deps, job.deadlineAt + SETTLE_GRACE_MS, now);
        const after = netOf(ex.recentJobs(RECENT_JOBS));
        const used = ex.notionalLimits()!;
        const done = view.status === 'completed';
        return { sent: true, settled: done,
          summary: `${done ? `${action}完成` : `${action}未正常完成，请到交易所核对`}：${jobLine(view)}；金丝雀自有持仓 ${CANARY_VENUES.map(venue => `${VENUE_NAMES[venue]} ${after[venue]}`).join('、')}；累计开仓已用 ${used.openUsed} / ${used.totalOpen} USDT`,
          findings: { ...base, preview: ex.publicPreview(fresh), job: jobFinding(view), canaryNetAfter: after, openUsedAfter: used.openUsed } };
      } catch (error) { return { sent: true, settled: false, summary: `${action}执行中断，请到交易所核对：${describe(error)}`, findings: { ...base, jobId: job.id } }; }
    },
  };
}

/** Ticks until every job is final; a stop request is passed on once. Returns the views as they stand at the end. */
async function drive(ex: Executor, ids: readonly string[], deps: CanaryDeps, deadline: number, now: () => number): Promise<JobView[]> {
  let failures = 0, stopAsked = false;
  for (;;) {
    if (!ex.acquire()) throw new Error('金丝雀执行器失去写入租约，任务停在中途：请到交易所核对');
    try { await ex.tick(); failures = 0; }
    catch (error) {
      failures += 1;
      deps.log(`执行轮次失败（${failures}/${MAX_TICK_FAILURES}）：${describe(error)}`);
    }
    const views = ids.map(id => ex.jobView(id));
    if (views.every(view => FINAL.has(view.status))) return views;
    if (failures >= MAX_TICK_FAILURES || now() > deadline) {
      deps.log(failures >= MAX_TICK_FAILURES ? '连续执行失败，停止等待' : '超过等待上限，停止等待');
      return views;
    }
    if (!stopAsked && deps.stopRequested()) {
      for (const view of views) if (!FINAL.has(view.status)) ex.requestStop(view.id, randomUUID(), SESSION);
      stopAsked = true;
      deps.log('已请求停止任务，等待执行器收尾');
    }
    await deps.wait(TICK_MS);
  }
}

