import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Interface, ZeroAddress } from 'ethers';
import { freezePermissionBatch, reviewPermissionBatch, permissionDigest } from '../server/automation/aero-permission-review.mjs';
import { ROLES_ABI, SAFE_ABI, encodeMultiSend } from '../tools/aero-roles/roles-calls.mjs';
import { allowanceKey } from '../tools/aero-roles/permissions.mjs';
import { SAFE as SAFE_ADDRESSES } from '../tools/aero-roles/addresses.mjs';
import { createAeroSafe } from '../server/automation/aero-safe.mjs';

const SAFE = '0x1111111111111111111111111111111111111111', ROLES = '0x2222222222222222222222222222222222222222', BOT = '0x3333333333333333333333333333333333333333';
const HASH = `0x${'44'.repeat(32)}`, BLOCK = `0x${'55'.repeat(32)}`;
const view = new Interface(['function allowances(bytes32) view returns (uint128 refill,uint128 maxRefill,uint64 period,uint128 balance,uint64 timestamp)']);
const events = new Interface(['event ExecutionSuccess(bytes32 txHash,uint256 payment)', 'event ExecutionFailure(bytes32 txHash,uint256 payment)']);
function fixture(options = {}) {
  const baseline = JSON.parse(readFileSync(new URL('../tools/aero-roles/config.example.json', import.meta.url), 'utf8'));
  const permissions = structuredClone(baseline); permissions.allowances[0].perDay = '123';
  if (options.two) { permissions.allowances[1].perDay = '456'; permissions.allowances[1].symbol = permissions.allowances[0].symbol; }
  const transactions = permissions.allowances.filter((token, index) => token.perDay !== baseline.allowances[index].perDay).map(token => ({ to: ROLES, value: '0', data: ROLES_ABI.encodeFunctionData('setAllowance', [allowanceKey(token.token), token.perDay, token.perDay, token.perDay, 86400, 0]) }));
  const batch = freezePermissionBatch({ safe: SAFE, roles: ROLES, bot: BOT, baseline, permissions, transactions, createdAt: 1000 });
  const log = events.encodeEventLog(events.getEvent(options.failed ? 'ExecutionFailure' : 'ExecutionSuccess'), [HASH, 0]);
  const transaction = { hash: HASH, to: SAFE, data: SAFE_ABI.encodeFunctionData('execTransaction', [SAFE_ADDRESSES.multiSendCallOnly, 0, encodeMultiSend(transactions), 1, 0, 0, 0, ZeroAddress, ZeroAddress, '0x']) };
  const receipt = { hash: HASH, to: SAFE, blockNumber: 10, blockHash: BLOCK, status: 1, logs: [{ address: SAFE, ...log }] };
  const calls = [];
  const rpc = { send: async method => { assert.equal(method, 'eth_chainId'); return options.chain ?? '0x2105'; }, getBlock: async number => ({ number, hash: BLOCK, timestamp: 100 }),
    getTransaction: async () => options.transaction ?? transaction, getTransactionReceipt: async () => options.missing ? null : receipt,
    call: async tx => {
      calls.push(tx); assert.equal(tx.blockTag, 10, 'every permission read uses the requested block');
      if (options.failRead) throw new Error('provider secret must not leak');
      if (tx.data.slice(0, 10) === view.getFunction('allowances').selector) {
        const key = view.decodeFunctionData('allowances', tx.data)[0], value = options.two && key === allowanceKey(permissions.allowances[1].token) ? 457 : options.allowance ?? 123;
        return view.encodeFunctionResult('allowances', [value, value, 86400, 100, 0]);
      }
      if (tx.to === SAFE) return SAFE_ABI.encodeFunctionResult('isModuleEnabled', [true]);
      const decoded = ROLES_ABI.parseTransaction({ data: tx.data });
      return ROLES_ABI.encodeFunctionResult(decoded.name, [options.owner ?? SAFE]);
    }, destroy() {} };
  return { batch, rpc, calls, transaction, receipt };
}

test('actual allowance reader pins identity and all calls to one block, and links the exact Safe batch receipt', async () => {
  const f = fixture();
  const result = await reviewPermissionBatch({ ...f, blockNumber: 10, transactionHash: HASH });
  assert.equal(result.status, 'effective'); assert.equal(result.receipt, 'confirmed'); assert.equal(result.blockHash, BLOCK);
  assert.equal(result.checks.length, 1); assert.match(result.checks[0].label, /0x833589/);
  assert.equal(f.calls.length, 5);
  assert.equal(JSON.stringify(result).includes('signature'), false);
});

test('local equality or missing receipt never proves execution; mismatched chain, target, or unsupported ABI stays unknown', async () => {
  for (const options of [{ missing: true }, { chain: '0x1' }, { owner: BOT }, { failRead: true }, { transaction: { hash: HASH, to: ROLES, data: '0x' } }]) {
    const f = fixture(options), result = await reviewPermissionBatch({ ...f, blockNumber: 10, transactionHash: HASH });
    assert.equal(result.status, 'insufficient'); assert.equal(JSON.stringify(result).includes('secret'), false);
  }
  const f = fixture();
  assert.equal((await reviewPermissionBatch({ ...f, blockNumber: 10 })).status, 'insufficient');
  f.batch.transactions[0].data = '0x12345678'; f.batch.id = permissionDigest(f.batch);
  assert.equal((await reviewPermissionBatch({ ...f, blockNumber: 10, transactionHash: HASH })).status, 'insufficient');
});

test('a successful outer receipt with Safe failure is not executed; later permission drift remains distinct', async () => {
  const failed = fixture({ failed: true });
  assert.equal((await reviewPermissionBatch({ ...failed, blockNumber: 10, transactionHash: HASH })).status, 'not_executed');
  const changed = fixture({ allowance: 124 });
  const result = await reviewPermissionBatch({ ...changed, blockNumber: 10, transactionHash: HASH });
  assert.equal(result.status, 'not_effective'); assert.equal(result.receipt, 'confirmed');
});

test('mismatched canonical receipt block and tampered frozen permissions cannot claim execution', async () => {
  const f = fixture(); f.receipt.blockHash = `0x${'99'.repeat(32)}`;
  assert.equal((await reviewPermissionBatch({ ...f, blockNumber: 10, transactionHash: HASH })).status, 'insufficient');
  const next = fixture(); next.batch.permissions.allowances[0].perDay = '999';
  assert.equal((await reviewPermissionBatch({ ...next, blockNumber: 10, transactionHash: HASH })).status, 'insufficient');
  assert.equal(next.calls.length, 0, 'a modified frozen batch is rejected before chain reads');
});

test('partially effective permissions retain separate token addresses even when symbols match', async () => {
  const f = fixture({ two: true }); const result = await reviewPermissionBatch({ ...f, blockNumber: 10, transactionHash: HASH });
  assert.equal(result.status, 'partial'); assert.equal(result.checks.length, 2); assert.notEqual(result.checks[0].label, result.checks[1].label);
  assert.ok(result.checks.every(check => check.label.startsWith('额度 USDC [')));
});

test('read budget terminates hanging RPC and no late result changes the returned evidence', async () => {
  const f = fixture(); let release;
  f.rpc.send = () => new Promise(resolve => { release = resolve; });
  const result = await reviewPermissionBatch({ ...f, blockNumber: 10, transactionHash: HASH, budgetMs: 20 });
  assert.equal(result.status, 'insufficient'); const original = structuredClone(result);
  release('0x2105'); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(result, original); assert.equal(f.calls.length, 0);
});

test('real Safe service retains review evidence without activating config and isolates history on Safe changes', async t => {
  const f = fixture(), directory = mkdtempSync(join(tmpdir(), 'aero-review-service-')), store = join(directory, 'aero-safe'); mkdirSync(store);
  const config = { rpcUrl: 'https://rpc.example', safe: SAFE, roles: ROLES, permissions: f.batch.baseline };
  writeFileSync(join(store, 'config.json'), JSON.stringify(config)); writeFileSync(join(store, 'permission-history.json'), JSON.stringify({ schema: 1, batches: [f.batch] }));
  const manager = createAeroSafe({ dataDir: directory, encrypt: x => x, decrypt: x => x, log: { warn() {} }, chain: { connect: async () => { throw new Error('fixture does not execute'); } }, makeProvider: () => f.rpc });
  t.after(async () => { await manager.close(); rmSync(directory, { recursive: true, force: true }); }); await manager.initialize();
  let state = await manager.reviewBatch({ id: f.batch.id, blockNumber: 10, transactionHash: HASH });
  assert.equal(state.permissionHistory.batches[0].reviews[0].status, 'effective'); assert.deepEqual(state.config.permissions, f.batch.baseline); assert.equal(state.job, null);
  await manager.save({ ...config, safe: BOT }); assert.equal(manager.state().permissionHistory.batches.length, 0);
  await assert.rejects(manager.reviewBatch({ id: f.batch.id, blockNumber: 10 }), error => error.status === 404);
  await manager.save(config);
  let release, started; const gate = new Promise(resolve => { release = resolve; }), observed = new Promise(resolve => { started = resolve; });
  const getBlock = f.rpc.getBlock; let once = true;
  f.rpc.getBlock = async number => { if (once) { once = false; started(); await gate; } return getBlock(number); };
  const pending = manager.reviewBatch({ id: f.batch.id, blockNumber: 10, transactionHash: HASH }); await observed;
  await manager.save({ ...config, roles: BOT }); release();
  await assert.rejects(pending, error => error.status === 409);
  await manager.save(config); state = manager.state(); assert.equal(state.permissionHistory.batches[0].reviews.length, 1, 'late read after config change did not append evidence');
});
