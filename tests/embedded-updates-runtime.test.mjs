// The embedded update cases, wired as createApp wires them: coordinator ->
// coordinatorHooks -> in-process runtime client -> runtime service -> guard.
process.env.EMBEDDED_UPDATES_WIRING = 'runtime';
await import('./embedded-updates.test.mjs');
