import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
if (args.some(argument => argument !== '--dev')) throw new Error('Usage: node scripts/run-server.mjs [--dev]');
const linux = process.platform === 'linux';
const child = spawn(linux ? 'bash' : process.execPath, linux
  ? ['server/entrypoint.sh', ...args]
  : ['--experimental-strip-types', '--env-file-if-exists=.env.linux', 'server/linux.mjs', ...args], {
  cwd: root, stdio: linux ? 'inherit' : ['inherit', 'inherit', 'inherit', 'ipc'],
  env: { ...process.env, NODE_ENV: args.includes('--dev') ? 'development' : process.env.NODE_ENV ?? 'production', MONITOR_NODE: process.execPath },
});
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32' && child.connected) child.send({ type: 'shutdown' });
  else child.kill(signal);
});
