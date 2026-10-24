// Runs one process of the split workbench (design doc 3.1). `start({ signal, fail })`
// starts the process and returns `{ ready, close() }`; it must clean up after
// itself when it throws, and stop early once `signal` aborts. `fail(error)`
// ends a started process with exit code 1 (a lost lock, a failed module).
// The launcher gets `{ type: 'ready', ...ready }` over IPC once start returns.
export async function runProcess({ name, start, logger }) {
  const controller = new AbortController();
  let code = 0, stopping = null, started = null;
  function stop(value) {
    code = Math.max(code, value); controller.abort();
    return stopping ??= (async () => {
      // A start that failed already cleaned up and was logged.
      const handle = await started?.catch(() => null);
      let failed = false;
      if (handle) try { await handle.close(); } catch (error) { failed = true; logger.error({ err: error, type: 'shutdown' }, `${name}关闭失败`); }
      process.exit(failed ? 1 : code);
    })();
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { logger.info({ signal, type: 'shutdown' }, `${name}收到关闭信号，正在退出`); void stop(0); });
  // Without the launcher nobody would stop this process.
  if (process.send) process.once('disconnect', () => { logger.warn({ type: 'shutdown' }, `${name}与启动器的连接已断开，正在退出`); void stop(1); });
  // Started on a microtask, so a fail() during start still finds `started`.
  started = Promise.resolve().then(() => start({ signal: controller.signal, fail: error => { logger.error({ err: error, type: 'shutdown' }, `${name}出现不可恢复的错误，正在退出`); void stop(1); } }));
  try {
    const handle = await started;
    if (!controller.signal.aborted) { process.send?.({ type: 'ready', ...handle.ready }); logger.info({ ...handle.ready, type: 'startup' }, `${name}已就绪`); }
  } catch (error) {
    if (controller.signal.aborted) logger.warn({ err: error, type: 'startup' }, `${name}启动已中止`);
    else logger.error({ err: error, type: 'startup' }, `${name}启动失败`);
    await stop(controller.signal.aborted ? 0 : 1);
  }
}
