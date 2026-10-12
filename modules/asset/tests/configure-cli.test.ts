import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { configure } from '../scripts/configure.mjs';
import { createSession, validSession, verifyPassword } from '../lib/auth-core.ts';

for (const entry of ['current', 'resolved'] as const) {
  test(`Password reset through the ${entry} deployment path prints a usable password and preserves data`, async () => {
    const temporaryRoot = resolve(tmpdir());
    const directory = mkdtempSync(join(temporaryRoot, 'asset-configure-cli-'));
    try {
      const release = join(directory, 'releases', 'version-one');
      mkdirSync(join(release, 'scripts'), { recursive: true });
      copyFileSync(new URL('../scripts/configure.mjs', import.meta.url), join(release, 'scripts', 'configure.mjs'));
      const current = join(directory, 'current');
      symlinkSync(release, current, process.platform === 'win32' ? 'junction' : 'dir');
      const linkedScript = join(current, 'scripts', 'configure.mjs');
      const script = entry === 'current' ? linkedScript : realpathSync(linkedScript);
      const dataDirectory = join(directory, 'data');
      configure(dataDirectory, { password: 'original-test-password-123' });
      const configPath = join(dataDirectory, 'config.json');
      const before = JSON.parse(readFileSync(configPath, 'utf8'));
      const oldSession = createSession(before.sessionSecret);
      const ledgerPath = join(dataDirectory, 'ledger.sqlite');
      const originalLedger = Buffer.from('Existing ledger must remain untouched');
      writeFileSync(ledgerPath, originalLedger);

      const output = execFileSync(process.execPath, [script, '--reset-password'], {
        encoding: 'utf8',
        env: { ...process.env, ASSET_DATA_DIR: dataDirectory },
        timeout: 15000,
      });
      const match = output.match(/登录密码（请保存）：([A-Za-z0-9_-]+)/);
      assert.ok(match, 'The command must print the newly generated password');
      const after = JSON.parse(readFileSync(configPath, 'utf8'));
      assert.equal(await verifyPassword(match[1], after.passwordHash), true);
      assert.equal(await verifyPassword('original-test-password-123', after.passwordHash), false);
      assert.equal(after.credentialKey, before.credentialKey);
      assert.equal(validSession(oldSession, after.sessionSecret), false);
      assert.deepEqual(readFileSync(ledgerPath), originalLedger);

      const retained = execFileSync(process.execPath, [script], {
        encoding: 'utf8', env: { ...process.env, ASSET_DATA_DIR: dataDirectory }, timeout: 15000,
      });
      assert.match(retained, /已有配置、登录密码及加密密钥已保留/);
      assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), after);
    } finally {
      const target = resolve(directory);
      assert.ok(target.startsWith(temporaryRoot + sep) && basename(target).startsWith('asset-configure-cli-'));
      rmSync(target, { recursive: true, force: true });
    }
  });
}
