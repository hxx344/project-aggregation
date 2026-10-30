import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatEther, getAddress, Wallet } from 'ethers';
import { PRIVATE_KEY_PATTERN, SETTING_KEYS, parseLedger, summarizeLedger, validateSettings } from '../../tools/aero-lp/core.mjs';
import { atomicJson } from '../../tools/entropy-lighter-lab/core.mjs';
import { HttpError } from '../http-common.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tool = path.join(root, 'tools/aero-lp');
const example = JSON.parse(readFileSync(path.join(tool, 'config.example.json'), 'utf8'));
export const AERO_LP_DEFAULTS = Object.freeze(Object.fromEntries(SETTING_KEYS.map((key) => [key, example[key]])));
const EVENT_LIMIT = 50;
const LEDGER_LIMIT = 16 * 1024 * 1024;

function readBounded(file, limit) {
  if (!existsSync(file)) return null;
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error('invalid_aero_lp_file');
  return JSON.parse(readFileSync(file, 'utf8'));
}

const ADDRESS_KEYS = ['pool', 'factory', 'nft', 'gauge', 'token', 'token1'];

export function strictAeroLpConfig(value) {
  let next;
  try { next = structuredClone(validateSettings(value)); }
  catch (error) { throw new HttpError(400, `LP 参数无效：${error.message}`); }
  // A mixed-case address with a wrong checksum would pass the shape check but fail every cycle in the child.
  for (const key of ADDRESS_KEYS) {
    try { getAddress(next[key]); } catch { throw new HttpError(400, `LP 参数无效：config.${key} 地址校验和错误`); }
  }
  return next;
}

// Settings saved before these keys were pinned get them only for the default
// pool, whose values are known; any other pool must be saved again with its own.
const PINNED_KEYS = ['gauge', 'token1', 'tickSpacing'];
function withPinnedKeys(saved) {
  if (!saved || typeof saved !== 'object' || typeof saved.pool !== 'string' || saved.pool.toLowerCase() !== AERO_LP_DEFAULTS.pool.toLowerCase()) return saved;
  return { ...Object.fromEntries(PINNED_KEYS.map((key) => [key, AERO_LP_DEFAULTS[key]])), ...saved };
}

const RECOVERY_HOLD = '账户写入处于隔离恢复状态，LP 调仓暂停，恢复正常后自动启动';

// The private key is write-only: it is stored encrypted with the credential
// key, decrypted only to hand it to the child over IPC, and never returned.
// readAdmission mirrors the trading recovery gate: only an admitted writer may
// start the signer, and losing admission holds it like maintenance does.
export function createAeroLp({ dataDir, encrypt, decrypt, readMaintenance = () => false, readAdmission = () => true, log = console,
  launch = spawn, now = Date.now, stopGraceMs = 90000, killWaitMs = 2000, maintenancePollMs = 5000,
  retryDelays = [1000, 2000, 4000, 8000, 16000] } = {}) {
  const directory = path.join(dataDir, 'aero-lp');
  const configPath = path.join(directory, 'config.json'), controlPath = path.join(directory, 'control.json'), walletPath = path.join(directory, 'wallet.json');
  const ledgerPath = path.join(directory, 'txs.jsonl');
  let config = structuredClone(AERO_LP_DEFAULTS), configValid = true, enabled = false, address = null, child = null, closed = false, initialized = false;
  let stopping = null, failure = null, retry = 0, retryTimer = null, generationStarted = 0, phase = null, lastCycle = null, paused = false, maintenanceTimer = null;
  // hold: why signing is held (maintenance / recovery); childPaused: the hold the child last confirmed.
  // Every hold message carries a new holdSeq; only the child's echo of the latest one counts.
  let hold = null, holdSeq = 0, childPaused = false, keyHanded = false, heldByRecovery = false;
  // False until the saved wallet file has been read (or replaced/cleared): before that, address null is not "no wallet".
  let walletKnown = false;
  const events = [];
  let ledgerCache = null;
  let operation = Promise.resolve();
  const cleared = () => { clearTimeout(retryTimer); retryTimer = null; };
  const serial = (fn) => {
    const next = operation.then(() => { if (closed) throw new HttpError(503, 'LP 服务正在关闭'); return fn(); });
    operation = next.catch(() => {}); return next;
  };
  const persistWanted = () => atomicJson(controlPath, { schema: 1, enabled });
  const send = (message) => { try { if (child?.connected) child.send(message); } catch {} };
  function readKey() {
    const saved = readBounded(walletPath, 16 * 1024);
    if (!saved) return null;
    const key = decrypt(saved.key);
    if (typeof key !== 'string' || !PRIVATE_KEY_PATTERN.test(key) || new Wallet(key).address !== saved.address) throw new Error('invalid_wallet');
    return key;
  }
  // The child appends txs.jsonl; re-parse only when its size or mtime changes.
  function ledger() {
    if (!address) return null;
    try {
      if (!existsSync(ledgerPath)) return { txs: 0, failed: 0, gasEth: '0', reward: '0', since: null };
      const info = lstatSync(ledgerPath);
      if (!info.isFile() || info.size > LEDGER_LIMIT) return null;
      const stamp = `${info.size}:${info.mtimeMs}:${address}`;
      if (ledgerCache?.stamp !== stamp) {
        const sum = summarizeLedger(parseLedger(readFileSync(ledgerPath, 'utf8')), address);
        ledgerCache = { stamp, value: { txs: sum.txs, failed: sum.failed, gasEth: formatEther(sum.fee), reward: formatEther(sum.reward), since: sum.since } };
      }
      return structuredClone(ledgerCache.value);
    } catch { return null; }
  }
  function state() {
    return { schema: 1, enabled, state: stopping ? 'stopping' : child ? phase ? 'running' : 'starting' : failure && !retryTimer ? 'fault' : enabled ? 'starting' : 'stopped',
      error: failure, wallet: address, paused, pauseReason: hold, phase: phase && structuredClone(phase), lastCycle: lastCycle && structuredClone(lastCycle),
      events: structuredClone(events), ledger: ledger(), config: structuredClone(config), defaults: structuredClone(AERO_LP_DEFAULTS), serverNow: now() };
  }
  function record(entry) {
    if (!entry || typeof entry !== 'object' || typeof entry.event !== 'string') return;
    if (entry.event === 'cycle') lastCycle = entry;
    else { events.push(entry); if (events.length > EVENT_LIMIT) events.splice(0, events.length - EVENT_LIMIT); }
  }
  function startChild() {
    if (closed || !enabled || child) return;
    cleared(); failure = null; phase = null;
    if (readHold() === 'recovery') { heldByRecovery = true; failure = RECOVERY_HOLD; return; }
    heldByRecovery = false; childPaused = false; keyHanded = false;
    let key;
    try { key = readKey(); } catch { failure = '已保存的私钥无法读取，请重新填写'; enabled = false; persistWanted(); return; }
    if (!key) { failure = '请先填写钱包私钥'; enabled = false; persistWanted(); return; }
    const env = { ...process.env, NODE_ENV: 'production' };
    delete env.NODE_OPTIONS; delete env.NODE_PATH; delete env.AERO_LP_PRIVATE_KEY;
    generationStarted = now();
    let current;
    try { current = launch(process.execPath, [path.join(tool, 'cli.mjs'), 'run', '--managed', '--config', configPath, '--data', directory], {
      cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    }); } catch { handleExit(); return; }
    child = current;
    let stderr = '';
    current.stdout?.on('data', () => {});
    current.stderr?.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-2000); });
    current.on('message', (message) => {
      if (child !== current || !message || typeof message !== 'object') return;
      if (message.type === 'aero-lp-ready' && key) { pollHold(); childPaused = false; send({ type: 'aero-lp-key', key, paused, seq: ++holdSeq }); key = null; keyHanded = true; }
      else if (message.type === 'aero-lp-hold' && message.seq === holdSeq) childPaused = message.paused === true;
      else if (message.type === 'aero-lp-event') record(message.entry);
      else if (message.type === 'aero-lp-phase' && typeof message.phase === 'string') phase = { name: message.phase, at: now(), nextAt: typeof message.nextAt === 'string' ? message.nextAt : null };
    });
    current.once('error', () => { failure = 'LP 进程启动失败'; });
    current.once('close', () => {
      if (child !== current) return;
      child = null; phase = null;
      if (closed || !enabled) return;
      log.warn?.({ type: 'aero-lp', detail: stderr, attempt: retry }, 'LP 调仓进程已退出');
      handleExit();
    });
  }
  function handleExit() {
    if (closed || !enabled) return;
    if (now() - generationStarted > 120000) retry = 0;
    failure = 'LP 调仓进程已中断，正在重启';
    if (retry >= retryDelays.length) { failure = 'LP 调仓进程多次退出，请查看事件后重新启动'; return; }
    retryTimer = setTimeout(() => { retryTimer = null; startChild(); }, retryDelays[retry++]);
    retryTimer.unref?.();
  }
  // Graceful stop lets the current cycle finish its transactions.
  async function halt() {
    cleared();
    const current = child;
    if (!current) return;
    await new Promise((resolve) => {
      let killTimer, doneTimer, settled = false;
      const done = () => { if (settled) return; settled = true; clearTimeout(killTimer); clearTimeout(doneTimer); current.removeListener('close', done); resolve(); };
      current.once('close', done);
      killTimer = setTimeout(() => {
        try { current.kill('SIGKILL'); } catch {}
        doneTimer = setTimeout(done, killWaitMs);
      }, stopGraceMs);
      try {
        if (current.connected) current.send({ type: 'aero-lp-stop' }, (error) => { if (error) { try { current.kill('SIGTERM'); } catch { done(); } } });
        else current.kill('SIGTERM');
      } catch { done(); }
    });
    if (child === current) {
      // Never spawn a second signer for the same wallet while the first one's death was not proven.
      failure = 'LP 进程停止结果尚未确认，请稍后核对';
      throw new HttpError(503, failure);
    }
  }
  // The stop request returns at once; the page shows 'stopping' until the child exits.
  function beginHalt() {
    if (!child) { cleared(); return Promise.resolve(); }
    stopping ||= halt().catch(() => {}).finally(() => { stopping = null; });
    return stopping;
  }
  const requireStopped = () => { if (child || retryTimer || stopping) throw new HttpError(409, '请先停止 LP 调仓，再更换或清除私钥'); };
  // An unreadable flag holds signing: maintenance first, then recovery admission.
  function readHold() {
    try { if (readMaintenance() === true) return 'maintenance'; } catch { return 'maintenance'; }
    try { return readAdmission() === true ? null : 'recovery'; } catch { return 'recovery'; }
  }
  function pollHold() {
    hold = readHold();
    const next = hold !== null;
    if (next !== paused) { paused = next; childPaused = false; send({ type: 'aero-lp-pause', paused, seq: ++holdSeq }); }
    // Resume only with no hold at all, so the update stop check never starts a signer.
    if (heldByRecovery && hold === null && enabled && !child && !retryTimer && !stopping && !closed) startChild();
  }
  // Update stop check: hold the child now, wait for it to confirm, and refuse
  // while it is inside a transaction step. The child signs nothing once it has
  // confirmed the hold, so only an 'executing' phase seen before the
  // confirmation can still have a transaction in flight.
  async function prepareStop({ confirmMs = 5000, stepMs = 50 } = {}) {
    pollHold();
    if (!child || !keyHanded) return;
    if (!paused) throw new HttpError(503, 'LP 调仓未进入维护暂停，暂不能更新');
    const current = child;
    for (let waited = 0; child === current && !childPaused && waited < confirmMs; waited += stepMs) await new Promise((r) => setTimeout(r, stepMs));
    if (child !== current) return;
    if (!childPaused) throw new HttpError(503, '无法确认 LP 调仓已暂停交易，暂不能更新');
    if (phase?.name === 'executing') throw new HttpError(409, 'LP 调仓正在执行链上交易，尚未满足安全停机条件，请稍后重试');
  }
  return {
    state,
    walletKnown: () => walletKnown,
    async initialize() {
      if (initialized) return;
      initialized = true;
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      pollHold();
      maintenanceTimer = setInterval(pollHold, maintenancePollMs);
      maintenanceTimer.unref?.();
      try {
        const savedWallet = readBounded(walletPath, 16 * 1024);
        address = typeof savedWallet?.address === 'string' ? savedWallet.address : null;
        // A file that exists but holds no address is damaged, not an absent wallet.
        walletKnown = savedWallet === null || address !== null;
        const saved = readBounded(configPath, 64 * 1024);
        if (saved) {
          config = validateSettings(withPinnedKeys(saved));
          if (PINNED_KEYS.some((key) => !Object.hasOwn(saved, key))) atomicJson(configPath, config);
        } else atomicJson(configPath, config);
        const prior = readBounded(controlPath, 4096);
        if (prior) {
          if (prior.schema !== 1 || typeof prior.enabled !== 'boolean' || Object.keys(prior).some((k) => !['schema', 'enabled'].includes(k))) throw new Error('invalid_control');
          enabled = prior.enabled;
        } else persistWanted();
        if (enabled) startChild();
      } catch {
        configValid = false; enabled = false; failure = 'LP 配置或运行设置无效，原文件已保留，请检查后重新保存';
      }
    },
    start: (authorize = () => {}) => serial(() => {
      authorize();
      if (!configValid) throw new HttpError(409, '请先重新保存有效的 LP 参数');
      if (!existsSync(walletPath)) throw new HttpError(409, '请先填写钱包私钥');
      if (stopping) throw new HttpError(409, '上一次停止尚未完成，请稍候');
      if (readHold() === 'recovery') throw new HttpError(409, '账户写入处于隔离恢复状态，暂不能启动 LP 调仓');
      enabled = true; persistWanted(); retry = 0; startChild(); return state();
    }),
    // Halt first: a failed control.json write must never keep the signer running.
    stop: (authorize = () => {}) => serial(() => {
      authorize(); enabled = false; failure = null; heldByRecovery = false; void beginHalt();
      try { persistWanted(); } catch (error) {
        log.warn?.({ type: 'aero-lp', err: error }, 'LP 启停设置保存失败');
        failure = '已停止，但启停设置保存失败，工作台重启后可能自动启动，请检查数据目录权限';
      }
      return state();
    }),
    // Takes effect at once: the child re-reads the file at the start of every cycle.
    save: (value, authorize = () => {}) => serial(() => {
      authorize();
      const next = strictAeroLpConfig(value);
      atomicJson(configPath, next); config = next; configValid = true;
      send({ type: 'aero-lp-reload' });
      return state();
    }),
    setKey: (privateKey, authorize = () => {}) => serial(() => {
      authorize();
      if (typeof privateKey !== 'string' || !PRIVATE_KEY_PATTERN.test(privateKey.trim())) throw new HttpError(400, '私钥须为 64 位十六进制字符（可带 0x 前缀）');
      requireStopped();
      const key = privateKey.trim();
      const wallet = new Wallet(key).address;
      atomicJson(walletPath, { schema: 1, address: wallet, key: encrypt(key) });
      // A fault leaves enabled=true without a child; a new key must not auto-start on the next restart.
      enabled = false; persistWanted();
      address = wallet; walletKnown = true; failure = null; lastCycle = null;
      return state();
    }),
    clearKey: (authorize = () => {}) => serial(() => {
      authorize();
      requireStopped();
      enabled = false; persistWanted();
      rmSync(walletPath, { force: true });
      address = null; walletKnown = true; failure = null; lastCycle = null; return state();
    }),
    async close() {
      closed = true; cleared(); clearInterval(maintenanceTimer);
      await operation;
      try { await stopping; await halt(); } catch (error) { log.warn?.({ type: 'aero-lp', err: error }, 'LP 进程关闭未确认'); }
    },
    prepareStop,
    get directory() { return directory; },
  };
}
