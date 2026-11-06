import { Signature, TypedDataEncoder, Wallet, keccak256 } from 'ethers';

/**
 * Hyperliquid L1 action signing (phantom agent), ported from the official
 * Python SDK `hyperliquid/utils/signing.py` (sign_l1_action / action_hash):
 * keccak256(msgpack(action) ‖ nonce u64 BE ‖ vault flag[+address] ‖ [0x00 ‖ expiresAfter u64 BE])
 * becomes the `connectionId` of an EIP-712 `Agent` message on chain 1337.
 * Official SDK vectors are covered in tests/trading-hyperliquid-signing.test.mjs.
 * https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/signing
 */
const DOMAIN = Object.freeze({ chainId: 1337, name: 'Exchange', verifyingContract: '0x0000000000000000000000000000000000000000', version: '1' });
const TYPES = Object.freeze({ Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] });
const MAX_UINT64 = (1n << 64n) - 1n;
const encoder = new TextEncoder();

/**
 * MessagePack in the subset actions use: maps keep insertion order, strings,
 * booleans, null, arrays and non-negative integers in their smallest encoding
 * (as msgpack-python packs them). Anything else is refused rather than guessed.
 */
export function packAction(value) {
  const bytes = [];
  const push = (...items) => { for (const item of items) bytes.push(item); };
  const unsigned = (number, size) => { for (let shift = BigInt((size - 1) * 8); shift >= 0n; shift -= 8n) push(Number((number >> shift) & 0xffn)); };
  const length = (count, small, smallLimit, codes) => {
    if (count < smallLimit) push(small | count);
    else if (codes[0] !== null && count <= 0xff) { push(codes[0]); unsigned(BigInt(count), 1); }
    else if (count <= 0xffff) { push(codes[1]); unsigned(BigInt(count), 2); }
    else if (count <= 0xffffffff) { push(codes[2]); unsigned(BigInt(count), 4); }
    else throw new TypeError('msgpack value too large');
  };
  const write = (item, depth) => {
    if (depth > 16) throw new TypeError('msgpack nesting too deep');
    if (item === null) push(0xc0);
    else if (item === true) push(0xc3);
    else if (item === false) push(0xc2);
    else if (typeof item === 'number' || typeof item === 'bigint') {
      if (typeof item === 'number' && !Number.isSafeInteger(item)) throw new TypeError('msgpack integers must be safe integers');
      const number = BigInt(item);
      if (number < 0n || number > MAX_UINT64) throw new TypeError('msgpack integer out of range');
      if (number < 128n) push(Number(number));
      else if (number <= 0xffn) { push(0xcc); unsigned(number, 1); }
      else if (number <= 0xffffn) { push(0xcd); unsigned(number, 2); }
      else if (number <= 0xffffffffn) { push(0xce); unsigned(number, 4); }
      else { push(0xcf); unsigned(number, 8); }
    } else if (typeof item === 'string') {
      const data = encoder.encode(item);
      length(data.length, 0xa0, 32, [0xd9, 0xda, 0xdb]);
      push(...data);
    } else if (Array.isArray(item)) {
      length(item.length, 0x90, 16, [null, 0xdc, 0xdd]);
      for (const entry of item) write(entry, depth + 1);
    } else if (typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype) {
      const entries = Object.entries(item).filter(([, entry]) => entry !== undefined);
      length(entries.length, 0x80, 16, [null, 0xde, 0xdf]);
      for (const [key, entry] of entries) { write(key, depth + 1); write(entry, depth + 1); }
    } else throw new TypeError('msgpack type not supported');
  };
  write(value, 0);
  return Uint8Array.from(bytes);
}

function uint64(value) {
  const number = BigInt(value);
  if (number < 0n || number > MAX_UINT64) throw new TypeError('uint64 out of range');
  const out = new Uint8Array(8);
  for (let index = 7, rest = number; index >= 0; index -= 1, rest >>= 8n) out[index] = Number(rest & 0xffn);
  return out;
}

export function actionHash(action, vaultAddress, nonce, expiresAfter) {
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw new TypeError('nonce must be a safe integer');
  const parts = [packAction(action), uint64(nonce)];
  if (vaultAddress === null || vaultAddress === undefined) parts.push(Uint8Array.of(0));
  else {
    if (typeof vaultAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(vaultAddress)) throw new TypeError('invalid vault address');
    parts.push(Uint8Array.of(1), Uint8Array.from(Buffer.from(vaultAddress.slice(2), 'hex')));
  }
  if (expiresAfter !== null && expiresAfter !== undefined) {
    if (!Number.isSafeInteger(expiresAfter) || expiresAfter < 0) throw new TypeError('expiresAfter must be a safe integer');
    parts.push(Uint8Array.of(0), uint64(expiresAfter));
  }
  return keccak256(Buffer.concat(parts));
}

/** Synchronous signature of one L1 action; the key never leaves this call. */
export function signL1Action(privateKey, action, { nonce, vaultAddress = null, expiresAfter = null, mainnet = true }) {
  const wallet = privateKey instanceof Wallet ? privateKey : new Wallet(privateKey);
  const digest = TypedDataEncoder.hash(DOMAIN, TYPES, { source: mainnet ? 'a' : 'b', connectionId: actionHash(action, vaultAddress, nonce, expiresAfter) });
  const signature = Signature.from(wallet.signingKey.sign(digest));
  return { r: signature.r, s: signature.s, v: signature.v };
}

export function addressOf(privateKey) { return new Wallet(privateKey).address.toLowerCase(); }
