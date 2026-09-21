import { createApp } from './app.mjs';

if (process.argv.length !== 3 || process.argv[2] !== '--reset-password') {
  console.error('用法：node server/setup.mjs --reset-password'); process.exitCode = 1;
} else {
  const app = await createApp({ refreshInterval: 0, initialPassword: 'temporary-setup-password', logger: () => {} });
  try { const password = await app.resetPassword(); console.log(`新的工作台登录密码：${password}\n旧登录会话已失效。请妥善保存，密码不会再次显示。`); } finally { await app.close(); }
}
