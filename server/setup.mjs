import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertRecoveryStartup } from './recovery/startup.mjs';
import { openHubDatabase } from './control/schema.mjs';
import { createControlStore } from './control/store.mjs';
import { resetPassword } from './control/password.mjs';

if (process.argv.length !== 3 || process.argv[2] !== '--reset-password') {
  console.error('用法：node server/setup.mjs --reset-password'); process.exitCode = 1;
} else {
  // Only the control-plane rows are touched: no seeding, credential key, account writer or native execution.
  const dataDir = path.resolve(process.env.DATA_DIR || fileURLToPath(new URL('../.data', import.meta.url)));
  const dbPath = path.join(dataDir, 'hub.sqlite');
  assertRecoveryStartup(dataDir);
  if (!existsSync(dbPath)) { console.error('工作台尚未初始化：请先启动一次工作台，首次启动会在日志中显示初始密码'); process.exitCode = 1; }
  else {
    const db = openHubDatabase(dbPath);
    try { const password = await resetPassword(createControlStore(db)); process.stdout.write(`新的工作台登录密码：${password}\n旧登录会话已失效。请妥善保存，密码不会再次显示。\n`); } finally { db.close(); }
  }
}
