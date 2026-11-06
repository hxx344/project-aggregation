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

// 正文按解压后的字节边读边数，超限立即取消：Content-Length 可能缺失、低报，或只是压缩后的长度。
async function readBody(response, method) {
  const tooLarge = () => new RpcError(`${method} 响应超过 ${MAX_BODY_BYTES / 1024 / 1024} MB`, { kind: 'format', method });
  if (!response.body) return '';
  const reader = response.body.getReader(), chunks = [];
  let total = 0;
  for (;;) {
    let next;
    try { next = await reader.read(); } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw new RpcError(timedOut ? `${method} 读取响应超时` : `${method} 读取响应中断`, { kind: timedOut ? 'timeout' : 'network', method });
    }
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_BODY_BYTES) { await reader.cancel().catch(() => {}); throw tooLarge(); }
    chunks.push(next.value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks, total));
}

// 某一段含无效 % 转义或 UTF-8 时仍解码其余字节，不能让一个坏片段跳过后续凭据。
function decodeFragment(value) {
  try { return decodeURIComponent(value); } catch {
    return value.replace(/(?:%[0-9a-f]{2})+/gi, (bytes) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(Uint8Array.from(bytes.match(/[0-9a-f]{2}/gi), (hex) => parseInt(hex, 16))));
  }
}

// RPC 诊断统一入口：先去密钥再裁剪/归一空白，兼容原文、解码回显和大小写混用的百分号转义。
// 路径段和查询值均可能是短密钥，不按长度猜测；URL 无法解析或诊断过长时只保留固定类别。
// 短片段（不足 SHORT_SECRET_LENGTH）只在前后不紧邻字母数字时按独立片段替换；
// 嵌在更长单词里（如 /e 命中 trie）既不能逐处打星号也不能放过，整条改为固定类别。
const SHORT_SECRET_LENGTH = 8;
const isWordChar = (char) => /[A-Za-z0-9]/.test(char ?? '');
function embeddedIn(text, secret) {
  for (let at = text.indexOf(secret); at !== -1; at = text.indexOf(secret, at + 1)) {
    if (isWordChar(text[at - 1]) || isWordChar(text[at + secret.length])) return true;
  }
  return false;
}
export function scrubRpcMessage(text, url, limit = 240) {
  let out = String(text), parsed;
  if (out.length > 8192) return 'RPC 错误（诊断内容过长）';
  try { parsed = new URL(url); } catch { return 'RPC 错误（地址无效）'; }
  const normalize = (value) => value.replace(/%[0-9a-f]{2}/gi, (hex) => hex.toUpperCase());
  const secrets = new Set();
  const add = (value) => {
    if (!value) return;
    const decoded = decodeFragment(value);
    // 诊断也会解码一次；若实际密钥含字面的 %xx，已解码回显会因此再展开一层。
    for (const variant of [value, decoded, decodeFragment(decoded)]) secrets.add(normalize(variant));
  };
  parsed.pathname.split('/').forEach(add);
  for (const part of parsed.search.slice(1).split('&')) {
    const value = part.slice(part.indexOf('=') + 1);
    add(value); add(value.replace(/\+/g, ' '));
  }
  add(parsed.username); add(parsed.password);
  // 先统一回显的编码形式，再从长到短匹配，避免 /v2 等短路由片段提前打断完整密钥。
  out = normalize(decodeFragment(out));
  const ordered = [...secrets].sort((a, b) => b.length - a.length);
  for (const secret of ordered) if (secret.length >= SHORT_SECRET_LENGTH) out = out.split(secret).join('***');
  // 回显的地址整段去掉后再查短片段：地址内的命中已随地址消失，剩余命中才需要处理。
  out = out.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>()]+/gi, '<地址>');
  const short = ordered.filter((secret) => secret.length < SHORT_SECRET_LENGTH);
  if (short.some((secret) => embeddedIn(out, secret))) return 'RPC 错误（诊断原文含配置地址片段，已隐藏）';
  for (const secret of short) out = out.split(secret).join('***');
  return out.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function createRpc({ url, chainId, fetchImpl = fetch, timeoutMs = RPC_TIMEOUT_MS, retryDelayMs = RETRY_DELAY_MS, signal } = {}) {
  let id = 0, verified = false;
  async function once(method, params) {
    let response;
    try {
      // 不跟随跳转：可信边界是所配的地址本身，公网节点的 3xx 不能把请求带到本机或内网服务。
      response = await fetchImpl(url, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw new RpcError(timedOut ? `${method} 超过 ${timeoutMs / 1000} 秒未响应` : `${method} 连接失败`, { kind: timedOut ? 'timeout' : 'network', method });
    }
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel?.().catch(() => {});
      throw Object.assign(new RpcError(`${method} 节点返回跳转（HTTP ${response.status}），已拒绝；请填写跳转后的最终地址`, { kind: 'redirect', method }), { status: response.status });
    }
    if (!response.ok) { await response.body?.cancel?.().catch(() => {}); throw Object.assign(new RpcError(`${method} HTTP ${response.status}`, { kind: 'http', method }), { status: response.status }); }
    let body;
    const length = Number(response.headers.get('content-length'));
    const encoded = !/^(identity)?$/i.test(response.headers.get('content-encoding') ?? '');
    if (!encoded && length > MAX_BODY_BYTES) { await response.body?.cancel?.().catch(() => {}); throw new RpcError(`${method} 响应超过 ${MAX_BODY_BYTES / 1024 / 1024} MB`, { kind: 'format', method }); }
    const text = await readBody(response, method);
    try { body = JSON.parse(text); } catch { throw new RpcError(`${method} 响应不是 JSON`, { kind: 'format', method }); }
    if (body?.error) throw Object.assign(new RpcError(`${method} 节点错误：${scrubRpcMessage(body.error.message || body.error.code, url, 160)}`, { kind: 'node', method }), { code: Number.isSafeInteger(body.error.code) ? body.error.code : undefined });
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
          try {
            const [rows] = MC.decodeFunctionResult('aggregate3', raw);
            results[index] = rows.map((row, i) => {
              if (!row.success || row.returnData === '0x') return { ok: false, value: null };
              try { const out = chunk[i].iface.decodeFunctionResult(chunk[i].fn, row.returnData); return { ok: true, value: out.length === 1 ? out[0] : out }; }
              catch { return { ok: false, value: null }; }
            });
          } catch {
            // ethers 的解码异常会在 message/value/stack 中回显原始结果，不将该对象带出 RPC 边界。
            throw new RpcError('eth_call 响应无法解码', { kind: 'format', method: 'eth_call' });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(PARALLEL, chunks.length) }, worker));
      return results.flat();
    },
  };
}

// 工厂池子列表只增不减：从 known 起读新增地址，最多 limit 个（分批读，慢节点上进度可以跨轮保留）。
export async function readPoolAddresses(rpc, factory, known = 0, limit = Infinity) {
  const [length] = await rpc.multicall([{ target: factory, iface: FACTORY, fn: 'allPoolsLength' }]);
  if (!length.ok) throw new RpcError('读取工厂池子数量失败', { kind: 'format', method: 'allPoolsLength' });
  const total = Number(length.value);
  const calls = [];
  for (let i = known; i < Math.min(total, known + limit); i++) calls.push({ target: factory, iface: FACTORY, fn: 'allPools', args: [i] });
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

const TICKS = new Interface([
  'function tickBitmap(int16) view returns (uint256)',
  // Slipstream Tick.Info：比 Uniswap v3 多出 stakedLiquidityNet 与 rewardGrowthOutsideX128（2026-11-04 Base 池子实测返回 10 个字段）。
  'function ticks(int24) view returns (uint128 liquidityGross, int128 liquidityNet, int128 stakedLiquidityNet, uint256, uint256, uint256, int56, uint160, uint32, bool initialized)',
]);
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
// 详情页默认读取当前价 ÷4 至 ×4（ln4 / ln1.0001 ≈ 13864 个 tick）；已初始化 tick 过多时只留离当前价最近的这么多个。
export const LIQUIDITY_SPAN_TICKS = 13_864;
export const LIQUIDITY_MAX_TICKS = 1500;

// 单个池子当前价附近的 tick 流动性，全部读数取自同一区块。from/to 为实际覆盖的 tick 范围（截断时收窄到最远保留的 tick）。
export async function readPoolLiquidity(rpc, pool, { span = LIQUIDITY_SPAN_TICKS, maxTicks = LIQUIDITY_MAX_TICKS } = {}) {
  const block = await rpc.blockNumber();
  const head = await rpc.multicall([{ target: pool.address, iface: POOL, fn: 'slot0' }, { target: pool.address, iface: POOL, fn: 'liquidity' }, { target: pool.address, iface: POOL, fn: 'stakedLiquidity' }], block);
  if (!head[0].ok || !head[1].ok) throw new RpcError('读取池子当前状态失败', { kind: 'format', method: 'slot0' });
  const tick = Number(head[0].value[1]), spacing = pool.tickSpacing;
  let from = Math.max(tick - span, MIN_TICK), to = Math.min(tick + span, MAX_TICK);
  // 与合约 TickBitmap 一致：compressed = floor(tick / spacing)，word = compressed >> 8，bit = compressed & 255。
  const wordOf = (t) => Math.floor(Math.floor(t / spacing) / 256);
  const words = [];
  for (let w = wordOf(from); w <= wordOf(to); w++) words.push(w);
  const maps = await rpc.multicall(words.map((w) => ({ target: pool.address, iface: TICKS, fn: 'tickBitmap', args: [w] })), block);
  let found = [];
  words.forEach((w, i) => {
    if (!maps[i].ok) throw new RpcError('读取 tick 位图失败', { kind: 'format', method: 'tickBitmap' });
    let bits = BigInt(maps[i].value);
    for (let b = 0; bits; b++, bits >>= 1n) if (bits & 1n) { const t = (w * 256 + b) * spacing; if (t >= from && t <= to) found.push(t); }
  });
  if (found.length > maxTicks) {
    // 范围收窄到第一个舍弃的 tick 之内：范围内的已初始化 tick 必须全部读到，否则跨过缺失 tick 后的流动性是错的。
    const cut = found.map((t) => Math.abs(t - tick)).sort((a, b) => a - b)[maxTicks];
    from = Math.max(from, tick - cut + 1); to = Math.min(to, tick + cut - 1);
    found = found.filter((t) => t >= from && t <= to);
  }
  found.sort((a, b) => a - b);
  const rows = await rpc.multicall(found.map((t) => ({ target: pool.address, iface: TICKS, fn: 'ticks', args: [t] })), block);
  const ticks = found.map((t, i) => {
    if (!rows[i].ok) throw new RpcError('读取 tick 流动性失败', { kind: 'format', method: 'ticks' });
    return [t, String(rows[i].value[1]), String(rows[i].value[2])];
  });
  return { block, tick, sqrtPriceX96: String(head[0].value[0]), liquidity: String(head[1].value), stakedLiquidity: head[2].ok ? String(head[2].value) : '0', from, to, ticks };
}
