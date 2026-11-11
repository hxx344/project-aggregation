// Ethereum-style signing for the ASTER contract probe: keccak-256, secp256k1 with RFC 6979
// nonces and the EIP-712 `Message{msg:string}` envelope ASTER v3 verifies. Written without
// dependencies so the probe runs from a bare checkout on the server; `test/contract.test.ts`
// checks every function against ethers. The arithmetic is not constant-time: it is for an
// operator-run probe on the operator's own host, not for a long-lived signing service.
import { createHmac } from 'node:crypto';

const MASK64 = (1n << 64n) - 1n;
const ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
/** Rho rotation of lane x + 5y. */
const ROTATIONS = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const RATE = 136;

const rotate = (value: bigint, bits: number): bigint => bits === 0 ? value : ((value << BigInt(bits)) | (value >> BigInt(64 - bits))) & MASK64;

function permute(state: bigint[]): void {
  const column = new Array<bigint>(5), moved = new Array<bigint>(25);
  for (const constant of ROUND_CONSTANTS) {
    for (let x = 0; x < 5; x++) column[x] = state[x]! ^ state[x + 5]! ^ state[x + 10]! ^ state[x + 15]! ^ state[x + 20]!;
    for (let x = 0; x < 5; x++) {
      const mix = column[(x + 4) % 5]! ^ rotate(column[(x + 1) % 5]!, 1);
      for (let y = 0; y < 25; y += 5) state[x + y] = state[x + y]! ^ mix;
    }
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) moved[y + 5 * ((2 * x + 3 * y) % 5)] = rotate(state[x + 5 * y]!, ROTATIONS[x + 5 * y]!);
    for (let y = 0; y < 25; y += 5) for (let x = 0; x < 5; x++) state[x + y] = moved[x + y]! ^ (~moved[(x + 1) % 5 + y]! & MASK64 & moved[(x + 2) % 5 + y]!);
    state[0] = state[0]! ^ constant;
  }
}

export function keccak256(input: Uint8Array): Uint8Array {
  const padded = new Uint8Array(Math.ceil((input.length + 1) / RATE) * RATE);
  padded.set(input);
  padded[input.length] = padded[input.length]! | 0x01;
  padded[padded.length - 1] = padded[padded.length - 1]! | 0x80;
  const state = new Array<bigint>(25).fill(0n), view = new DataView(padded.buffer);
  for (let offset = 0; offset < padded.length; offset += RATE) {
    for (let lane = 0; lane < RATE / 8; lane++) state[lane] = state[lane]! ^ view.getBigUint64(offset + lane * 8, true);
    permute(state);
  }
  const out = new Uint8Array(32), result = new DataView(out.buffer);
  for (let lane = 0; lane < 4; lane++) result.setBigUint64(lane * 8, state[lane]!, true);
  return out;
}

const P = 2n ** 256n - 2n ** 32n - 977n;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G: Point = [0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n, 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n];
type Point = [bigint, bigint] | null;

const mod = (value: bigint, modulus: bigint): bigint => { const rest = value % modulus; return rest < 0n ? rest + modulus : rest; };
function inverse(value: bigint, modulus: bigint): bigint {
  let [low, high, lowCoefficient, highCoefficient] = [mod(value, modulus), modulus, 1n, 0n];
  if (low === 0n) throw new RangeError('no inverse');
  while (low > 1n) {
    const quotient = high / low;
    [low, high] = [high - quotient * low, low];
    [lowCoefficient, highCoefficient] = [highCoefficient - quotient * lowCoefficient, lowCoefficient];
  }
  return mod(lowCoefficient, modulus);
}
function addPoints(left: Point, right: Point): Point {
  if (!left) return right;
  if (!right) return left;
  const [x1, y1] = left, [x2, y2] = right;
  if (x1 === x2 && mod(y1 + y2, P) === 0n) return null;
  const slope = x1 === x2 ? mod(3n * x1 * x1 * inverse(2n * y1, P), P) : mod((y2 - y1) * inverse(x2 - x1, P), P);
  const x = mod(slope * slope - x1 - x2, P);
  return [x, mod(slope * (x1 - x) - y1, P)];
}
function multiply(scalar: bigint, point: Point): Point {
  let result: Point = null, addend = point;
  for (let rest = scalar; rest > 0n; rest >>= 1n) {
    if (rest & 1n) result = addPoints(result, addend);
    addend = addPoints(addend, addend);
  }
  return result;
}

const toBytes = (value: bigint, length = 32): Uint8Array => Uint8Array.from(Buffer.from(value.toString(16).padStart(length * 2, '0'), 'hex'));
const toBigInt = (bytes: Uint8Array): bigint => bytes.length ? BigInt('0x' + Buffer.from(bytes).toString('hex')) : 0n;
const concat = (...parts: Uint8Array[]): Uint8Array => Uint8Array.from(Buffer.concat(parts));
const hex = (bytes: Uint8Array): string => '0x' + Buffer.from(bytes).toString('hex');

function privateScalar(privateKey: string): bigint {
  if (typeof privateKey !== 'string' || !/^(0x)?[0-9a-fA-F]{64}$/.test(privateKey)) throw new TypeError('私钥格式无效');
  const scalar = BigInt('0x' + privateKey.replace(/^0x/, ''));
  if (scalar === 0n || scalar >= N) throw new TypeError('私钥超出范围');
  return scalar;
}

/** Lower-case address of a private key. */
export function addressOf(privateKey: string): string {
  const [x, y] = multiply(privateScalar(privateKey), G)!;
  return hex(keccak256(concat(toBytes(x), toBytes(y))).subarray(12));
}

/** RFC 6979 deterministic nonce for a 32-byte digest, HMAC-SHA256. */
function deterministicNonce(digest: Uint8Array, scalar: bigint): bigint {
  const hmac = (key: Uint8Array, ...data: Uint8Array[]): Uint8Array => { const mac = createHmac('sha256', key); for (const part of data) mac.update(part); return Uint8Array.from(mac.digest()); };
  const secret = toBytes(scalar), reduced = toBytes(mod(toBigInt(digest), N));
  let v: Uint8Array = new Uint8Array(32).fill(1), k: Uint8Array = new Uint8Array(32);
  k = hmac(k, v, Uint8Array.of(0), secret, reduced);
  v = hmac(k, v);
  k = hmac(k, v, Uint8Array.of(1), secret, reduced);
  v = hmac(k, v);
  for (;;) {
    v = hmac(k, v);
    const candidate = toBigInt(v);
    if (candidate > 0n && candidate < N) return candidate;
    k = hmac(k, v, Uint8Array.of(0));
    v = hmac(k, v);
  }
}

/** 65-byte r || s || v signature (v = 27/28, low s) over a 32-byte digest. */
export function signDigest(digest: Uint8Array, privateKey: string): string {
  if (digest.length !== 32) throw new TypeError('摘要必须为 32 字节');
  const scalar = privateScalar(privateKey), nonce = deterministicNonce(digest, scalar);
  const [x, y] = multiply(nonce, G)!;
  const r = mod(x, N);
  let s = mod(inverse(nonce, N) * (toBigInt(digest) + r * scalar), N);
  if (r === 0n || s === 0n) throw new RangeError('签名失败');
  let recovery = Number(y & 1n) | (x >= N ? 2 : 0);
  if (s > N / 2n) { s = N - s; recovery ^= 1; }
  return hex(concat(toBytes(r), toBytes(s), Uint8Array.of(27 + recovery)));
}

const text = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, 'utf8'));
const DOMAIN_TYPE = keccak256(text('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));
const MESSAGE_TYPE = keccak256(text('Message(string msg)'));
/** ASTER v3 signing domain: AsterSignTransaction / "1" / chain 1666 / zero verifying contract. */
const ASTER_DOMAIN = keccak256(concat(DOMAIN_TYPE, keccak256(text('AsterSignTransaction')), keccak256(text('1')), toBytes(1666n), new Uint8Array(32)));

export function asterDigest(message: string): Uint8Array {
  return keccak256(concat(Uint8Array.of(0x19, 0x01), ASTER_DOMAIN, keccak256(concat(MESSAGE_TYPE, keccak256(text(message))))));
}
export const signAsterMessage = (message: string, privateKey: string): string => signDigest(asterDigest(message), privateKey);

/** Python's `urllib.parse.urlencode` (quote_plus): the exact string the old module signs and sends. */
export function pythonUrlencode(parameters: Record<string, string>): string {
  const quote = (value: string): string => {
    let out = '';
    for (const byte of Buffer.from(value, 'utf8')) {
      const char = String.fromCharCode(byte);
      out += /[A-Za-z0-9_.~-]/.test(char) ? char : char === ' ' ? '+' : '%' + byte.toString(16).toUpperCase().padStart(2, '0');
    }
    return out;
  };
  return Object.entries(parameters).map(([key, value]) => quote(key) + '=' + quote(value)).join('&');
}
