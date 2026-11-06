import test from 'node:test';
import assert from 'node:assert/strict';
import { actionHash, packAction, signL1Action } from '../server/trading-hyperliquid-signing.mjs';

// Vectors from the official SDK: hyperliquid-python-sdk tests/signing_test.py.
const KEY = '0x0123456789012345678901234567890123456789012345678901234567890123';
const same = (actual, expected) => assert.equal(BigInt(actual), BigInt(expected));
const order = cloid => ({ type: 'order', orders: [{ a: 1, b: true, p: '100', s: '100', r: false, t: { limit: { tif: 'Gtc' } }, ...(cloid ? { c: cloid } : {}) }], grouping: 'na' });
const check = (action, vault, mainnet, testnet) => {
  for (const [isMainnet, [r, s, v]] of [[true, mainnet], [false, testnet]]) {
    const signature = signL1Action(KEY, action, { nonce: 0, vaultAddress: vault, mainnet: isMainnet });
    same(signature.r, r); same(signature.s, s); assert.equal(signature.v, v);
  }
};

test('phantom agent connection id matches the official production vector', () => {
  const action = { type: 'order', orders: [{ a: 4, b: true, p: '1670.1', s: '0.0147', r: false, t: { limit: { tif: 'Ioc' } } }], grouping: 'na' };
  assert.equal(actionHash(action, null, 1677777606040, null), '0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908');
});

test('L1 action signatures match the official SDK vectors', () => {
  check({ type: 'dummy', num: 100000000000 }, null,
    ['0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298', '0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8', 27],
    ['0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f9510', '0x17b8b32f086e8cdede991f1e2c529f5dd5297cbe8128500e00cbaf766204a613', 28]);
  check(order(), null,
    ['0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e', '0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e', 28],
    ['0x82b2ba28e76b3d761093aaded1b1cdad4960b3af30212b343fb2e6cdfa4e3d54', '0x6b53878fc99d26047f4d7e8c90eb98955a109f44209163f52d8dc4278cbbd9f5', 27]);
  check(order('0x00000000000000000000000000000001'), null,
    ['0x41ae18e8239a56cacbc5dad94d45d0b747e5da11ad564077fcac71277a946e3', '0x3c61f667e747404fe7eea8f90ab0e76cc12ce60270438b2058324681a00116da', 27],
    ['0xeba0664bed2676fc4e5a743bf89e5c7501aa6d870bdb9446e122c9466c5cd16d', '0x7f3e74825c9114bc59086f1eebea2928c190fdfbfde144827cb02b85bbe90988', 28]);
  check({ type: 'dummy', num: 100000000000 }, '0x1719884eb866cb12b2287399b15f7db5e7d775ea',
    ['0x3c548db75e479f8012acf3000ca3a6b05606bc2ec0c29c50c515066a326239', '0x4d402be7396ce74fbba3795769cda45aec00dc3125a984f2a9f23177b190da2c', 28],
    ['0xe281d2fb5c6e25ca01601f878e4d69c965bb598b88fac58e475dd1f5e56c362b', '0x7ddad27e9a238d045c035bc606349d075d5c5cd00a6cd1da23ab5c39d4ef0f60', 27]);
});

test('expiresAfter is appended to the hash and changes the signature', () => {
  const action = order();
  assert.notEqual(actionHash(action, null, 5, 35), actionHash(action, null, 5, null));
  assert.notEqual(signL1Action(KEY, action, { nonce: 5, expiresAfter: 35 }).r, signL1Action(KEY, action, { nonce: 5 }).r);
});

test('msgpack keeps key order, uses the smallest encodings and refuses unsupported values', () => {
  assert.deepEqual([...packAction({ b: 1, a: 'x' })], [0x82, 0xa1, 0x62, 0x01, 0xa1, 0x61, 0xa1, 0x78]);
  assert.deepEqual([...packAction([200, 70000, 2 ** 40])], [0x93, 0xcc, 200, 0xce, 0, 1, 0x11, 0x70, 0xcf, 0, 0, 1, 0, 0, 0, 0, 0]);
  assert.deepEqual([...packAction('x'.repeat(32)).slice(0, 2)], [0xd9, 32]);
  for (const value of [1.5, -1, Number.MAX_SAFE_INTEGER + 1, new Date(0), Symbol('x'), () => 0]) assert.throws(() => packAction({ value }));
  let nested = 1; for (let index = 0; index < 20; index += 1) nested = [nested];
  assert.throws(() => packAction(nested));
});
