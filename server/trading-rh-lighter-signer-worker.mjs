import { parentPort } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

// Runs the official lighter-go WASM signer in its own thread so its globals
// (CreateClient, Sign*) never reach the main process. Only the three
// functions below are reachable: no transfer, withdrawal, leverage or key
// change can be signed through this worker. Provenance: vendor/lighter-signer/README.md.
const DIR = new URL('./vendor/lighter-signer/', import.meta.url);
export const SIGNER_WASM_SHA256 = '801e60563c190283b857c00aa31e1d7786a685e814ff316f0318f94cb57ab53e';
export const WASM_EXEC_SHA256 = '0c949f4996f9a89698e4b5c586de32249c3b69b7baadb64d220073cc04acba14';
const CHAIN_ID = 466324;
const clients = new Map();
let loaded = null;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function load() {
  const glue = brotliDecompressSync(readFileSync(new URL('wasm_exec.js.br', DIR)));
  const bytes = brotliDecompressSync(readFileSync(new URL('lighter-signer.wasm.br', DIR)));
  if (sha256(glue) !== WASM_EXEC_SHA256 || sha256(bytes) !== SIGNER_WASM_SHA256) throw new Error('signer integrity check failed');
  // The signer is built with an empty URL and never needs the network.
  for (const name of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'Request', 'Response', 'Headers']) delete globalThis[name];
  vm.runInThisContext(glue.toString('utf8'), { filename: 'wasm_exec.js' });
  const go = new globalThis.Go();
  return WebAssembly.instantiate(bytes, go.importObject).then(({ instance }) => {
    // main() registers the functions, then blocks on select{} for the worker's lifetime.
    void go.run(instance);
    for (const name of ['CreateClient', 'SignCreateOrder', 'SignCancelOrder', 'CreateAuthToken']) if (typeof globalThis[name] !== 'function') throw new Error('signer function missing');
  });
}

function checked(result) {
  if (!result || typeof result !== 'object') throw new Error('signer returned no result');
  if (typeof result.error === 'string' && result.error) throw new Error('signer rejected the request');
  return result;
}

function client({ privateKey, apiKeyIndex, accountIndex }) {
  const slot = `${apiKeyIndex}:${accountIndex}`, fingerprint = createHash('sha256').update(privateKey).digest('hex');
  if (clients.get(slot) !== fingerprint) {
    // An empty URL keeps the signer offline; every nonce is supplied by the caller.
    checked(globalThis.CreateClient('', privateKey, CHAIN_ID, apiKeyIndex, accountIndex));
    clients.set(slot, fingerprint);
  }
}

const METHODS = {
  createOrder(p) {
    client(p);
    return checked(globalThis.SignCreateOrder(p.marketIndex, p.clientOrderIndex, p.baseAmount, p.price, p.isAsk, p.orderType, p.timeInForce, p.reduceOnly,
      0, p.orderExpiry, 0, 0, 0, 0, 0, 0, p.nonce, p.apiKeyIndex, p.accountIndex));
  },
  cancelOrder(p) {
    client(p);
    return checked(globalThis.SignCancelOrder(p.marketIndex, p.index, 0, p.nonce, p.apiKeyIndex, p.accountIndex));
  },
  authToken(p) {
    client(p);
    return checked(globalThis.CreateAuthToken(p.deadline, p.apiKeyIndex, p.accountIndex));
  },
};

parentPort.on('message', async ({ id, method, params }) => {
  try {
    loaded ??= load();
    await loaded;
    if (!Object.hasOwn(METHODS, method)) throw new Error('unsupported signer method');
    const { txType, txInfo, txHash, authToken } = METHODS[method](params);
    parentPort.postMessage({ id, result: { txType, txInfo, txHash, authToken } });
  } catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : 'signer failed' });
  }
});
