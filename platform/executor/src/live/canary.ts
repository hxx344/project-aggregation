// Oil two-leg live canary, driven step by step from the workbench page (plan 3.0d). Each step is one short process: the
// caller takes the account locks and hands over connectors whose keys passed preflight; this module opens the canary's own
// executor database, does one thing and gives the lease back. A live step keeps ticking its job until the executor calls
// it final, because the next process is a new writer and never sends anything new for an earlier job (takeover recovery).
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { add, cmp, sub } from '../decimal.ts';
import { OIL_SYMBOLS, type AccountBinding, type NotionalLimits } from '../contracts.ts';
import type { VenueConnector } from '../connector.ts';
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

export interface CanaryParams {
  step: CanaryStep; symbol: string; lead: CanaryVenue; leadSide: 'long' | 'short'; leadOrder: 'market' | 'chase';
  quantity: string; perJob: string; totalOpen: string; timeoutS: number; maxSlippageBps: number | null;
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
  return {
    step: oneOf(raw.step, CANARY_STEPS, '步骤'), symbol: oneOf(raw.symbol, OIL_SYMBOLS, '合约'), lead, leadSide: oneOf(raw.leadSide, ['long', 'short'] as const, '首腿方向'), leadOrder,
    quantity: amount(raw.quantity, '每腿数量', null), perJob, totalOpen, timeoutS: whole(raw.timeoutS, '最长执行秒数', 30, 600),
    maxSlippageBps: raw.maxSlippageBps === undefined ? null : whole(raw.maxSlippageBps, '价格保护基点', 1, MAX_SLIPPAGE_BPS),
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

/** Signed quantity per venue that the canary's own jobs filled on this symbol: long positive, short negative. */
function ownNet(jobs: readonly JobView[], symbol: string): Record<CanaryVenue, string> {
  const net: Record<CanaryVenue, string> = { binance: '0', bybit: '0' };
  for (const job of jobs) for (const leg of job.legs) {
    if (leg.symbol !== symbol || !CANARY_VENUES.includes(leg.venue as CanaryVenue)) continue;
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
  let executor: Executor | null = null;
  const close = () => { executor?.close(); store.close(); };
  try {
    const ex = executor = createExecutor({ store, connectors: [...deps.connectors], environment: 'mainnet', notionalLimits: limits, now });
    // A step that ended cleanly handed the lease back; one that was killed holds it until it lapses.
    for (const until = now() + ex.budgets.leaseTtlMs + 5_000; !ex.acquire();) {
      if (now() > until) throw new CanaryRefusal('另一个进程持有金丝雀执行器的写入租约');
      await deps.wait(TICK_MS);
    }
    for (const account of accounts) ex.registerAccount(account);
    const plan = await planStep(ex, params, accounts, deps, now);
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

async function planStep(ex: Executor, params: CanaryParams, accounts: readonly AccountBinding[], deps: CanaryDeps, now: () => number): Promise<Omit<PreparedCanary, 'close'>> {
  const jobs = ex.recentJobs(RECENT_JOBS);
  if (jobs.length >= RECENT_JOBS) throw new CanaryRefusal(`金丝雀任务记录已达 ${RECENT_JOBS} 条，无法可靠汇总自有持仓；请换用新的金丝雀目录`);
  const net = ownNet(jobs, params.symbol);
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
  const refuseNew = (): void => { if (pending) throw new CanaryRefusal(`有 ${pending} 个未结束或待人工确认的金丝雀任务，请先做「收尾」`); };

  if (params.step === 'check') {
    const problems = [
      ...venues.filter(venue => cmp(venue.position, net[venue.venue]) !== 0).map(venue => `${VENUE_NAMES[venue.venue]} 账户持仓 ${venue.position} 与金丝雀记录 ${net[venue.venue]} 不一致（可能含旧系统或人工仓位）`),
      ...venues.filter(venue => venue.openOrders).map(venue => `${VENUE_NAMES[venue.venue]} 该合约有 ${venue.openOrders} 笔挂单，开平仓会被拒绝`),
      ...(pending ? [`有 ${pending} 个未结束或待人工确认的金丝雀任务，请先做「收尾」`] : []),
    ];
    const summary = problems.length ? `检查完成，有待处理事项：${problems.join('；')}` : `检查通过：两个账户的密钥权限、IP 绑定与身份核对通过，账户持仓与金丝雀记录一致（${netText}）`;
    return { phrase: null, summary, findings: { ...base, problems }, execute: () => Promise.reject(new CanaryRefusal('检查只读，没有真实运行')) };
  }

  if (params.step === 'settle') {
    if (!pending) return { phrase: null, summary: '没有未结束或待人工确认的金丝雀任务', findings: base, execute: () => Promise.reject(new CanaryRefusal('没有需要收尾的任务')) };
    for (const job of [...unfinished, ...attention]) deps.log(`待收尾：${jobLine(job)}`);
    const ids = [...unfinished, ...attention].map(job => job.id);
    const phrase = `oil-canary-settle-${pending}-${digest({ ids, fingerprint })}`;
    const summary = `可收尾：${unfinished.length} 个未结束任务继续核对到终态（首腿不再新发、撤其挂单，首腿已成交部分补发对冲腿），${attention.length} 个待人工确认任务将标记为已确认（请先到交易所处理剩余敞口）`;
    return { phrase, summary, findings: base, execute: async () => {
      const deadline = Math.max(now(), ...unfinished.map(job => job.deadlineAt)) + SETTLE_GRACE_MS;
      let driven: JobView[] = [];
      try { driven = unfinished.length ? await drive(ex, unfinished.map(job => job.id), deps, deadline, now) : []; }
      catch (error) { return { sent: unfinished.length > 0, settled: false, summary: `收尾中断，请到交易所核对：${describe(error)}`, findings: base }; }
      const errors: string[] = [];
      for (const job of attention) {
        try { ex.acknowledge(job.id, randomUUID(), SESSION); }
        catch (error) { errors.push(`${jobLine(job)} 确认失败：${describe(error)}`); }
      }
      const after = ids.map(id => ex.jobView(id));
      const left = after.filter(job => !FINAL.has(job.status) || (job.status === 'attention' && job.acknowledgedAt === null));
      const lines = [...after.map(jobLine), ...errors];
      return { sent: driven.length > 0, settled: left.length === 0 && errors.length === 0,
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
    phrase, summary: `${action}预览通过：${describePreview(preview)}`, findings: { ...base, preview: ex.publicPreview(preview) },
    execute: async () => {
      if (deps.stopRequested()) throw new CanaryRefusal('收到停止请求，未发送');
      const fresh = await ex.preview(intent, SESSION);
      deps.log(`${action}发送前重新预览：${describePreview(fresh)}`);
      if (deps.stopRequested()) throw new CanaryRefusal('收到停止请求，未发送');
      const { job } = ex.confirm({ previewId: fresh.id, requestId: randomUUID(), confirmLive: true }, SESSION);
      deps.log(`${action}任务已确认，开始执行`);
      let view: JobView;
      // From here orders may have left: every failure is reported as sent and unsettled, never thrown as not sent.
      try { [view] = await drive(ex, [job.id], deps, job.deadlineAt + SETTLE_GRACE_MS, now); }
      catch (error) { return { sent: true, settled: false, summary: `${action}执行中断，请到交易所核对：${describe(error)}`, findings: { ...base, preview: ex.publicPreview(fresh), jobId: job.id } }; }
      const after = ownNet(ex.recentJobs(RECENT_JOBS), params.symbol);
      const used = ex.notionalLimits()!;
      const done = view.status === 'completed';
      return { sent: true, settled: done,
        summary: `${done ? `${action}完成` : `${action}未正常完成，请到交易所核对`}：${jobLine(view)}；金丝雀自有持仓 ${CANARY_VENUES.map(venue => `${VENUE_NAMES[venue]} ${after[venue]}`).join('、')}；累计开仓已用 ${used.openUsed} / ${used.totalOpen} USDT`,
        findings: { ...base, preview: ex.publicPreview(fresh), job: jobFinding(view), canaryNetAfter: after, openUsedAfter: used.openUsed } };
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

