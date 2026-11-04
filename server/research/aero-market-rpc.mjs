// Aero 市场扫描的链上读取：JSON-RPC over fetch（自动协商 gzip/br，减少流量）+ Multicall3 批量 eth_call。
// 只读，不签名；每次请求有超时，瞬态失败只重试一次，失败带上链、方法与原因交给调度层保留旧数据。
import { Interface } from 'ethers';
import { AERO_VOTER, MULTICALL3 } from './aero-market-chains.mjs';

const RPC_TIMEOUT_MS = 20_000;
const RETRY_DELAY_MS = 800;
const CHUNK = 120; // 每个 aggregate3 的子调用数：公共 RPC 的单次 eth_call gas 上限内留足余量
const PARALLEL = 3; // 同一链同时在途的 eth_call 数
const MAX_BODY_BYTES = 8 * 1024 * 1024; // 单个 JSON-RPC 响应上限：正常一批 aggregate3 只有几十 KB

const MC = new Interface([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
  'function getCurrentBlockTimestamp() view returns (uint256)',
]);
const FACTORY = new Interface(['function allPoolsLength() view returns (uint256)', 'function allPools(uint256) view returns (address)']);
const POOL = new Interface([
  'function token0() view returns (address)', 'function token1() view returns (address)', 'function tickSpacing() view returns (int24)', 'function gauge() view returns (address)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, bool)',
  'function liquidity() view returns (uint128)', 'function stakedLiquidity() view returns (uint128)', 'function fee() view returns (uint24)', 'function unstakedFee() view returns (uint24)',
]);
const ERC20 = new Interface(['function symbol() view returns (string)', 'function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)']);
const ERC20_BYTES32 = new Interface(['function symbol() view returns (bytes32)']);
const VOTER = new Interface(['function projectedCumulativeRewardShare(address) view returns (uint256)']);

export class RpcError extends Error {
  constructor(message, { kind = 'rpc', method = '' } = {}) { super(message); this.kind = kind; this.method = method; }
}

const transient = (error) => error?.kind === 'timeout' || error?.kind === 'network' || (error?.kind === 'http' && /^(5\d\d|429)$/.test(String(error.status)));

export function createRpc({ url, chainId, fetchImpl = fetch, timeoutMs = RPC_TIMEOUT_MS, retryDelayMs = RETRY_DELAY_MS, signal } = {}) {
  let id = 0, verified = false;
  async function once(method, params) {
    let response;
    try {
      response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw Object.assign(new RpcError(timedOut ? `${method} 超过 ${timeoutMs / 1000} 秒未响应` : `${method} 连接失败`, { kind: timedOut ? 'timeout' : 'network', method }), { cause: error });
    }
    if (!response.ok) { await response.body?.cancel?.().catch(() => {}); throw Object.assign(new RpcError(`${method} HTTP ${response.status}`, { kind: 'http', method }), { status: response.status }); }
    let body;
    const length = Number(response.headers.get('content-length'));
    if (length > MAX_BODY_BYTES) { await response.body?.cancel?.().catch(() => {}); throw new RpcError(`${method} 响应超过 ${MAX_BODY_BYTES / 1024 / 1024} MB`, { kind: 'format', method }); }
    try {
      const text = await response.text();
      if (text.length > MAX_BODY_BYTES) throw new RpcError(`${method} 响应超过 ${MAX_BODY_BYTES / 1024 / 1024} MB`, { kind: 'format', method });
      body = JSON.parse(text);
    } catch (error) { if (error instanceof RpcError) throw error; throw new RpcError(`${method} 响应不是 JSON`, { kind: 'format', method }); }
    if (body?.error) throw Object.assign(new RpcError(`${method} 节点错误：${String(body.error.message || body.error.code).slice(0, 160)}`, { kind: 'node', method }), { code: body.error.code });
    if (!Object.hasOwn(body ?? {}, 'result')) throw new RpcError(`${method} 响应缺少 result`, { kind: 'format', method });
    return body.result;
  }
  async function send(method, params) {
    try { return await once(method, params); } catch (error) {
      if (!transient(error) || signal?.aborted) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      return once(method, params);
    }
  }
  async function verify() {
    if (verified) return;
    const actual = Number.parseInt(await send('eth_chainId', []), 16);
    if (actual !== chainId) throw new RpcError(`RPC 链 ID 为 ${actual}，应为 ${chainId}`, { kind: 'chain', method: 'eth_chainId' });
    verified = true;
  }
  return {
    verify,
    async blockNumber() { await verify(); return Number.parseInt(await send('eth_blockNumber', []), 16); },
    async blockTimestamp(number) { const block = await send('eth_getBlockByNumber', [`0x${number.toString(16)}`, false]); if (!block) throw new RpcError(`区块 ${number} 不存在`, { kind: 'format', method: 'eth_getBlockByNumber' }); return Number.parseInt(block.timestamp, 16); },
    // calls: [{ target, iface, fn, args }] → [{ ok, value }]，单个子调用失败不影响其它；整批失败抛错。
    async multicall(calls, blockTag = 'latest') {
      await verify();
      const tag = typeof blockTag === 'number' ? `0x${blockTag.toString(16)}` : blockTag;
      const chunks = [];
      for (let i = 0; i < calls.length; i += CHUNK) chunks.push(calls.slice(i, i + CHUNK));
      const results = new Array(chunks.length);
      let next = 0;
      const worker = async () => {
        while (next < chunks.length) {
          const index = next++;
          const chunk = chunks[index];
          const data = MC.encodeFunctionData('aggregate3', [chunk.map((c) => ({ target: c.target, allowFailure: true, callData: c.iface.encodeFunctionData(c.fn, c.args ?? []) }))]);
          const raw = await send('eth_call', [{ to: MULTICALL3, data }, tag]);
          const [rows] = MC.decodeFunctionResult('aggregate3', raw);
          results[index] = rows.map((row, i) => {
            if (!row.success || row.returnData === '0x') return { ok: false, value: null };
            try { const out = chunk[i].iface.decodeFunctionResult(chunk[i].fn, row.returnData); return { ok: true, value: out.length === 1 ? out[0] : out }; }
            catch { return { ok: false, value: null }; }
          });
        }
      };
      await Promise.all(Array.from({ length: Math.min(PARALLEL, chunks.length) }, worker));
      return results.flat();
    },
  };
}

// 工厂池子列表只增不减：从 known 起读新增地址。
export async function readPoolAddresses(rpc, factory, known = 0) {
  const [length] = await rpc.multicall([{ target: factory, iface: FACTORY, fn: 'allPoolsLength' }]);
  if (!length.ok) throw new RpcError('读取工厂池子数量失败', { kind: 'format', method: 'allPoolsLength' });
  const total = Number(length.value);
  const calls = [];
  for (let i = known; i < total; i++) calls.push({ target: factory, iface: FACTORY, fn: 'allPools', args: [i] });
  const rows = await rpc.multicall(calls);
  if (rows.some((r) => !r.ok)) throw new RpcError('读取工厂池子地址不完整', { kind: 'format', method: 'allPools' });
  return { total, added: rows.map((r) => r.value.toLowerCase()) };
}

// 池子静态信息（token、tickSpacing）与 gauge（可能后来才创建，所以没有 gauge 的池子会被重复检查）。
export async function readPoolStatics(rpc, pools) {
  const fns = ['token0', 'token1', 'tickSpacing', 'gauge'];
  const rows = await rpc.multicall(pools.flatMap((pool) => fns.map((fn) => ({ target: pool, iface: POOL, fn }))));
  return pools.map((pool, i) => {
    const [t0, t1, spacing, gauge] = rows.slice(i * 4, i * 4 + 4);
    if (!t0.ok || !t1.ok || !spacing.ok) return null;
    const g = gauge.ok ? gauge.value.toLowerCase() : null;
    return { address: pool, token0: t0.value.toLowerCase(), token1: t1.value.toLowerCase(), tickSpacing: Number(spacing.value), gauge: g && !/^0x0{40}$/.test(g) ? g : null };
  });
}

export async function readGauges(rpc, pools) {
  const rows = await rpc.multicall(pools.map((pool) => ({ target: pool, iface: POOL, fn: 'gauge' })));
  return rows.map((r) => (r.ok && !/^0x0{40}$/i.test(r.value) ? r.value.toLowerCase() : null));
}

export async function readTokens(rpc, tokens) {
  const rows = await rpc.multicall(tokens.flatMap((token) => [{ target: token, iface: ERC20, fn: 'symbol' }, { target: token, iface: ERC20, fn: 'decimals' }]));
  const retry = tokens.filter((_, i) => !rows[i * 2].ok);
  const fallback = retry.length ? await rpc.multicall(retry.map((token) => ({ target: token, iface: ERC20_BYTES32, fn: 'symbol' }))) : [];
  const bytes32 = new Map(retry.map((token, i) => [token, fallback[i]]));
  return tokens.map((token, i) => {
    const decimals = rows[i * 2 + 1];
    if (!decimals.ok || Number(decimals.value) > 36) return null;
    let symbol = rows[i * 2].ok ? String(rows[i * 2].value) : null;
    if (symbol === null) { const b = bytes32.get(token); symbol = b?.ok ? Buffer.from(b.value.slice(2), 'hex').toString('utf8').replace(/\0+$/, '') : '?'; }
    return { address: token, symbol: symbol.replace(/[^\p{L}\p{N}._+\- ]/gu, '').slice(0, 24) || '?', decimals: Number(decimals.value) };
  });
}

// 当前完整状态（含余额与排放累计）。block 为固定区块号，保证同一轮的所有读数来自同一区块。
export async function readPoolStates(rpc, pools, block) {
  const per = 8;
  const calls = [{ target: MULTICALL3, iface: MC, fn: 'getCurrentBlockTimestamp' }];
  for (const p of pools) {
    calls.push(
      { target: p.address, iface: POOL, fn: 'slot0' }, { target: p.address, iface: POOL, fn: 'liquidity' }, { target: p.address, iface: POOL, fn: 'stakedLiquidity' },
      { target: p.address, iface: POOL, fn: 'fee' }, { target: p.address, iface: POOL, fn: 'unstakedFee' },
      { target: p.token0, iface: ERC20, fn: 'balanceOf', args: [p.address] }, { target: p.token1, iface: ERC20, fn: 'balanceOf', args: [p.address] },
      p.gauge ? { target: AERO_VOTER, iface: VOTER, fn: 'projectedCumulativeRewardShare', args: [p.gauge] } : { target: MULTICALL3, iface: MC, fn: 'getCurrentBlockTimestamp' },
    );
  }
  const rows = await rpc.multicall(calls, block);
  if (!rows[0].ok) throw new RpcError('读取区块时间失败', { kind: 'format', method: 'getCurrentBlockTimestamp' });
  const timestamp = Number(rows[0].value);
  const states = pools.map((p, i) => {
    const r = rows.slice(1 + i * per, 1 + (i + 1) * per);
    if (!r[0].ok || !r[1].ok) return null;
    return {
      sqrtPriceX96: String(r[0].value[0]), tick: Number(r[0].value[1]), liquidity: String(r[1].value), stakedLiquidity: r[2].ok ? String(r[2].value) : '0',
      fee: r[3].ok ? Number(r[3].value) : null, unstakedFee: r[4].ok ? Number(r[4].value) : null,
      balance0: r[5].ok ? String(r[5].value) : null, balance1: r[6].ok ? String(r[6].value) : null,
      rewardShare: p.gauge && r[7].ok ? String(r[7].value) : null,
    };
  });
  return { block, timestamp, states };
}

// 历史小时点：full 时同时读排放累计（最近 25 小时，算排放速率），否则只读 tick（波动率用）。
export async function readPoolHistory(rpc, pools, block, full = true) {
  const per = full ? 2 : 1;
  const calls = [{ target: MULTICALL3, iface: MC, fn: 'getCurrentBlockTimestamp' }];
  for (const p of pools) {
    calls.push({ target: p.address, iface: POOL, fn: 'slot0' });
    if (full) calls.push(p.gauge ? { target: AERO_VOTER, iface: VOTER, fn: 'projectedCumulativeRewardShare', args: [p.gauge] } : { target: MULTICALL3, iface: MC, fn: 'getCurrentBlockTimestamp' });
  }
  const rows = await rpc.multicall(calls, block);
  if (!rows[0].ok) throw new RpcError('读取历史区块时间失败', { kind: 'format', method: 'getCurrentBlockTimestamp' });
  return {
    block, timestamp: Number(rows[0].value),
    states: pools.map((p, i) => {
      const r = rows.slice(1 + i * per, 1 + (i + 1) * per);
      if (!r[0].ok) return null;
      const tick = Number(r[0].value[1]);
      return full ? { tick, rewardShare: p.gauge && r[1].ok ? String(r[1].value) : null } : { tick };
    }),
  };
}
