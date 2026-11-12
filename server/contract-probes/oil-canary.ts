// Plan 3.0d: the oil two-leg live canary, one step per run, started from the workbench's contract probe page. It drives the
// new executor (platform/executor) with the real Binance and Bybit connectors and the accounts the trading center saved.
//
// Every run takes the per-account host locks and passes the key and identity checks first. Without `--live` nothing is
// sent: `check` reads both accounts and the canary's own records, `open` and `close` preview and print the phrase,
// `settle` lists the jobs that are left. With `--live --confirm <phrase>` an open or close confirms its job and ticks it to
// a final status; settle ticks unfinished jobs to a final status and acknowledges the ones waiting for a person.
// The executor database lives in <data dir>/executor-canary, apart from the workbench's own databases.
// Exit codes: 0 done as asked, 1 nothing sent, 2 sent and not confirmed settled (check at the venues).
import { isAbsolute, join } from 'node:path';
import { ContractError, parseBinding, type AccountBinding } from '../../platform/executor/src/contracts.ts';
import { CanaryRefusal, parseCanaryParams, prepareCanary, type PreparedCanary } from '../../platform/executor/src/live/canary.ts';
import { createLiveConnectors, holdAccountLocks, preflightLive } from '../../platform/executor/src/live/setup.ts';
import type { LiveCredentials } from '../../platform/executor/src/live/values.ts';
import { NotSent, ProbeAbort, createReport, interruptRequested, liveAllowed, readFlags, registerSecrets, reserveReport, safeText, saveReport, step, watchSignals } from './lib/common.ts';
import { readWorkbenchAccounts } from './lib/workbench-accounts.ts';

const CANARY_DIR = 'executor-canary';
const VENUES = ['binance', 'bybit'] as const;
const STRINGS = ['data-dir', 'step', 'symbol', 'lead', 'lead-side', 'lead-order', 'quantity', 'per-job', 'total-open', 'timeout-s', 'max-slippage-bps', 'strategy', 'strategy-id', 'out', 'confirm'] as const;

async function main(): Promise<number> {
  const flags = readFlags(process.argv.slice(2), STRINGS, ['live', 'help']);
  if (flags.help) {
    process.stdout.write('用法：node server/contract-probes/oil-canary.ts --data-dir <工作台数据目录> --step <check|open|close|settle> --symbol <CLUSDT|BZUSDT>\n'
      + '  --lead <binance|bybit> --lead-side <long|short> --lead-order <market|chase> --quantity <每腿数量>\n'
      + '  --per-job <单笔上限 USDT，≤200> --total-open <累计开仓上限 USDT，≤500> --timeout-s <30–600> [--max-slippage-bps <1–200>] --out <报告文件> [--live --confirm <短语>]\n'
      + '  收尾时处理创建结果未知的追价策略：[--strategy <auto|adopt|release>] [--strategy-id <策略编号，仅 adopt>]\n');
    return 0;
  }
  const dataDir = flags['data-dir'], out = flags.out;
  if (typeof dataDir !== 'string' || !isAbsolute(dataDir)) throw new ProbeAbort('--data-dir 必须是工作台数据目录的绝对路径');
  if (typeof out !== 'string' || !out) throw new ProbeAbort('需要 --out <报告文件>');
  const text = (name: typeof STRINGS[number]): string | undefined => typeof flags[name] === 'string' ? flags[name] as string : undefined;
  let params;
  try {
    params = parseCanaryParams({ step: text('step'), symbol: text('symbol'), lead: text('lead'), leadSide: text('lead-side'), leadOrder: text('lead-order'), quantity: text('quantity'),
      perJob: text('per-job'), totalOpen: text('total-open'), timeoutS: text('timeout-s'), maxSlippageBps: text('max-slippage-bps'),
      strategy: text('strategy'), strategyId: text('strategy-id') });
  } catch (error) { throw new ProbeAbort(safeText(error)); }
  const live = flags.live === true;
  const report = createReport('oil-canary', live ? 'live' : 'read-only', { ...params });
  reserveReport(out);
  watchSignals();
  let exitCode = 1, prepared: PreparedCanary | null = null, locks: { release(): void } | null = null;
  try {
    const saved = readWorkbenchAccounts(dataDir, VENUES);
    // The account id goes too: a failed preflight names it, and the page shows only its last four digits elsewhere.
    for (const account of saved) registerSecrets(account.apiKey, account.apiSecret, account.identity ?? '');
    const accounts: AccountBinding[] = saved.map(account => {
      if (!account.identity) throw new ProbeAbort(`交易中心尚未核验 ${account.exchange} 账户的真实身份，请先在交易中心重新保存该账户`);
      try { return parseBinding({ venue: account.exchange, environment: 'mainnet', accountId: account.identity, accountMode: account.accountMode, credentialVersion: account.revision }); }
      catch (error) { throw new ProbeAbort(`${account.exchange} 执行账户不能用于金丝雀：${error instanceof ContractError ? error.message : safeText(error)}`); }
    });
    const keys = new Map(saved.map(account => [account.exchange, { apiKey: account.apiKey, apiSecret: account.apiSecret } as LiveCredentials]));
    // Its message names the full account id; the page and the report show only the venue.
    try { locks = await holdAccountLocks(accounts); }
    catch { throw new ProbeAbort('其中一个账户已被本机另一个实盘执行器或金丝雀占用，请等它结束'); }
    const connectors = createLiveConnectors({ accounts }, keys as never);
    step(report, '启动检查：密钥权限、IP 绑定、账户可交易与身份', null);
    await preflightLive({ accounts }, connectors);
    prepared = await prepareCanary(params, { dir: join(dataDir, CANARY_DIR), accounts, connectors, log: line => step(report, line, null),
      wait: ms => new Promise(resolve => setTimeout(resolve, ms)), stopRequested: interruptRequested });
    report.findings.plan = prepared.findings;
    if (!live) {
      if (prepared.phrase) process.stdout.write(`\n真实运行需要：--live --confirm ${prepared.phrase}\n`);
      report.outcome = prepared.summary;
      exitCode = 0;
      return exitCode;
    }
    if (!prepared.phrase) throw new NotSent(`这一步没有可真实运行的内容：${prepared.summary}`);
    liveAllowed(flags, prepared.phrase);
    const outcome = await prepared.execute();
    report.findings.result = outcome.findings;
    report.outcome = outcome.summary;
    if (outcome.sent) report.writes.push({ name: params.step, at: new Date().toISOString(), outcome: outcome.settled ? 'settled' : 'unsettled' });
    exitCode = outcome.settled ? 0 : outcome.sent ? 2 : 1;
    return exitCode;
  } catch (error) {
    report.outcome = safeText(error);
    // Nothing throws once a job is confirmed (execute reports that as sent), so a failure here sent nothing.
    exitCode = 1;
    throw error instanceof CanaryRefusal ? new ProbeAbort(error.message) : error;
  } finally {
    try { prepared?.close(); } catch (error) { report.outcome += '；关闭金丝雀数据库失败：' + safeText(error); }
    locks?.release();
    process.exitCode = exitCode;
    process.stdout.write(`\n结果：${safeText(report.outcome)}\n报告已写入 ${saveReport(report, out)}（已隐去密钥、签名与账户编号）\n`);
  }
}

main().then(code => { process.exitCode = process.exitCode || code; }, error => {
  process.stderr.write((error instanceof ProbeAbort ? '已中止：' : '运行失败：') + safeText(error) + '\n');
  process.exitCode = process.exitCode || 1;
});
