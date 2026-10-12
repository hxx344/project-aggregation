import { createApp } from './app.mjs';
if (process.argv.length !== 3 || process.argv[2] !== '--reset-password') { console.error('用法：node server/setup.mjs --reset-password'); process.exitCode = 1; }
else { const app = createApp({ intervalMs: 0, logger: () => {} }); try { console.log(`用户名：admin\n新密码：${app.resetPassword()}\n旧登录信息已失效。`); } finally { await app.close(); } }
