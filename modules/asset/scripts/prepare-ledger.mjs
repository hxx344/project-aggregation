import { constants, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A fresh checkout starts with examples. Never replace an existing personal import.
/** @param {string | URL} [target] @param {string | URL} [example] */
export function prepareLedger(
  target = new URL('../lib/imported-ledger.json', import.meta.url),
  example = new URL('../lib/example-ledger.json', import.meta.url),
) {
  try {
    copyFileSync(example, target, constants.COPYFILE_EXCL);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareLedger();
}
