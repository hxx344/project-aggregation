// A stand-in for the launcher in tests/dev-watch.test.mjs. DEV_FIXTURE_MODE:
// `slow` exits 300 ms after SIGTERM, `stubborn` ignores it, `leak` leaves a
// child in a process group of its own that ignores SIGTERM, `crash` exits by
// itself. Each start appends "<pid> <run> [<leaked pid>]" to DEV_FIXTURE_LOG.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const mode = process.env.DEV_FIXTURE_MODE;
const fields = [process.pid, process.env.WORKBENCH_DEV_RUN];
if (mode === 'leak') {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { detached: true, stdio: 'ignore' });
  child.unref();
  fields.push(child.pid);
}
setInterval(() => {}, 1000);
process.on('SIGTERM', () => {
  if (mode === 'stubborn') return;
  setTimeout(() => process.exit(0), mode === 'slow' ? 300 : 0);
});
if (mode === 'crash') setTimeout(() => process.exit(3), 50);
appendFileSync(process.env.DEV_FIXTURE_LOG, `${fields.join(' ')}\n`);
