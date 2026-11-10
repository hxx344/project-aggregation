import { createHash } from 'node:crypto';
import { Interface } from 'ethers';
import { buildPermissions } from '../../tools/aero-roles/permissions.mjs';
import { BASE_CHAIN_ID, SAFE } from '../../tools/aero-roles/addresses.mjs';
import { ROLES_ABI, SAFE_ABI, encodeMultiSend } from '../../tools/aero-roles/roles-calls.mjs';
import { verifyActive } from '../../tools/aero-roles/executor.mjs';

const success = new Interface(['event ExecutionSuccess(bytes32 txHash, uint256 payment)', 'event ExecutionFailure(bytes32 txHash, uint256 payment)']);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
export function permissionReviewView(value) {
  const { at, batchId, chainId, safe, roles, blockNumber, blockHash, transactionHash, receipt, status, note, coverage } = value;
  return { at, batchId, chainId, safe, roles, blockNumber, blockHash, transactionHash, receipt, status, note, coverage,
    checks: (value.checks ?? []).slice(0, 200).map(({ label, ok, status }) => ({ label, ok, status })),
    operations: (value.operations ?? []).slice(0, 200).map(({ index, to, method, target }) => ({ index, to, method, target })) };
}
export const permissionDigest = batch => createHash('sha256').update(JSON.stringify([batch.chainId, batch.safe.toLowerCase(), batch.roles.toLowerCase(), batch.bot, batch.createdAt, batch.baseline, batch.permissions, batch.transactions])).digest('hex');
export function freezePermissionBatch({ safe, roles, bot, baseline, permissions, transactions, createdAt }) {
  const batch = { chainId: BASE_CHAIN_ID, safe, roles, bot, baseline, permissions, createdAt,
    transactions: transactions.map(({ to, value, data }) => ({ to, value: String(value ?? 0), data })) };
  return { ...batch, id: permissionDigest(batch), reviews: [] };
}

export function receiptMatchesBatch(batch, transaction, receipt) {
  if (!transaction || !receipt || !same(transaction.to, batch.safe) || !same(receipt.to, batch.safe)) return false;
  try {
    const args = SAFE_ABI.decodeFunctionData('execTransaction', transaction.data);
    const direct = batch.transactions.length === 1 && Number(args.operation) === 0 && same(args.to, batch.transactions[0].to)
      && args.value === BigInt(batch.transactions[0].value) && same(args.data, batch.transactions[0].data);
    return direct || Number(args.operation) === 1 && args.value === 0n && same(args.to, SAFE.multiSendCallOnly) && same(args.data, encodeMultiSend(batch.transactions));
  } catch { return false; }
}

/** Real RPC reads only: each call <=3s, <=64 calls, total <=20s, no custom retries.
 * verifyActive's existing bounded retries consume the same global budget.
 * The returned checks are probes/allowance reads for this batch's changes,
 * never a claim to enumerate unrelated permission changes on the chain.
 */
export async function reviewPermissionBatch({ batch, rpc, blockNumber, transactionHash, now = Date.now, verify = verifyActive, budgetMs = 20_000 }) {
  const started = Date.now(), deadline = started + budgetMs;
  let active = true, calls = 0;
  const result = { at: now(), batchId: batch.id, chainId: batch.chainId, safe: batch.safe, roles: batch.roles, blockNumber, blockHash: null,
    transactionHash: transactionHash || null, receipt: 'unknown', status: 'insufficient', checks: [], operations: batch.transactions.map((tx, index) => {
      let parsed; try { parsed = ROLES_ABI.parseTransaction({ data: tx.data }); } catch {}
      return { index, to: tx.to, method: parsed?.name ?? 'unknown', target: parsed?.name === 'setAllowance' ? String(parsed.args[0]) : parsed?.args[1] ? String(parsed.args[1]) : null };
    }), note: '证据不足；本地配置相同不代表已执行', coverage: '仅核对本批次新增/调整的权限探测与额度；未枚举批次外链上变化' };
  const read = async fn => {
    if (!active || ++calls > 64 || Date.now() >= deadline) throw new Error('budget');
    let timer;
    try { return await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), Math.min(3000, deadline - Date.now())); })]); }
    finally { clearTimeout(timer); }
  };
  let wall;
  const work = async () => {
    if (permissionDigest(batch) !== batch.id || batch.chainId !== BASE_CHAIN_ID) throw new Error('batch_identity');
    if (result.operations.some(operation => !['scopeTarget', 'scopeFunction', 'allowFunction', 'setAllowance'].includes(operation.method))) throw new Error('unsupported_abi');
    const chainId = await read(() => rpc.send('eth_chainId', []));
    if (Number(chainId) !== batch.chainId) throw new Error('chain_identity');
    const block = await read(() => rpc.getBlock(blockNumber));
    if (!block || block.number !== blockNumber || !/^0x[0-9a-f]{64}$/i.test(block.hash)) throw new Error('block');
    result.blockHash = block.hash;
    const fixed = { call: tx => read(() => rpc.call({ ...tx, blockTag: blockNumber })) };
    const identity = await Promise.all(['owner', 'avatar', 'target'].map(async name => ROLES_ABI.decodeFunctionResult(name,
      await fixed.call({ to: batch.roles, data: ROLES_ABI.encodeFunctionData(name) }))[0]));
    const [enabled] = SAFE_ABI.decodeFunctionResult('isModuleEnabled', await fixed.call({ to: batch.safe, data: SAFE_ABI.encodeFunctionData('isModuleEnabled', [batch.roles]) }));
    if (!enabled || identity.some(address => !same(address, batch.safe))) throw new Error('target_identity');
    if (!batch.bot) throw new Error('missing_bot');
    // Addresses stay in labels, so two assets/pools sharing a display name remain distinct.
    const named = config => ({ ...config, pools: config.pools.map(pool => ({ ...pool, name: `${pool.name} [${pool.gauge}]` })),
      allowances: config.allowances.map(token => ({ ...token, symbol: `${token.symbol} [${token.token}]` })) });
    const checked = await verify({ rpc: fixed, safe: batch.safe, roles: batch.roles, bot: batch.bot,
      current: buildPermissions(named(batch.baseline)), next: buildPermissions(named(batch.permissions)), now: () => block.timestamp * 1000 });
    result.checks = checked.checks.slice(0, 200).map(item => ({ label: String(item.label).slice(0, 240), ok: item.ok === true, status: String(item.status).slice(0, 200) }));
    if (!same((await read(() => rpc.getBlock(blockNumber)))?.hash, block.hash)) throw new Error('reorg');
    if (!transactionHash) { result.note = '已取得固定区块权限读数；未提供原批次交易回执，执行归属未知'; return; }
    const [transaction, receipt] = await Promise.all([read(() => rpc.getTransaction(transactionHash)), read(() => rpc.getTransactionReceipt(transactionHash))]);
    if (!receipt || !transaction || !same(transaction.hash, transactionHash) || !same(receipt.hash, transactionHash) || receipt.blockNumber > blockNumber) { result.note = '固定区块之前未取得对应回执；不能据此判定未执行'; return; }
    const receiptBlock = await read(() => rpc.getBlock(receipt.blockNumber));
    if (!same(receiptBlock?.hash, receipt.blockHash) || !receiptMatchesBatch(batch, transaction, receipt)) { result.note = '回执或解码交易与冻结批次不一致；无法归属的链上变化未计入'; return; }
    const events = (receipt.logs ?? []).filter(log => same(log.address, batch.safe)).map(log => { try { return success.parseLog(log)?.name; } catch { return null; } });
    if (receipt.status === 0 || events.includes('ExecutionFailure')) { result.receipt = 'failed'; result.status = 'not_executed'; result.note = '原批次交易明确失败；当前权限读数不代表由该批次生效'; return; }
    if (receipt.status !== 1 || !events.includes('ExecutionSuccess')) { result.note = '外层回执缺少 Safe 执行成功事件，结果未知'; return; }
    result.receipt = 'confirmed';
    const finalBlock = await read(() => rpc.getBlock(blockNumber));
    if (!same(finalBlock?.hash, block.hash)) throw new Error('reorg');
    const count = result.checks.filter(check => check.ok).length;
    result.status = result.checks.length && count === result.checks.length ? 'effective' : count ? 'partial' : 'not_effective';
    result.note = '原批次交易已确认；当前固定区块的权限读数单独列示，后续链上变更可能改变权限';
  };
  try { await Promise.race([work(), new Promise((_, reject) => { wall = setTimeout(() => reject(new Error('budget')), budgetMs); })]); }
  catch { result.status = 'insufficient'; result.note = '链上读取失败、身份不符或预算用尽，证据不足；不采用本地配置替代'; }
  finally { active = false; clearTimeout(wall); rpc.destroy?.(); }
  return structuredClone(result);
}
