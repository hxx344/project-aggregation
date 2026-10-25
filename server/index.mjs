// The service entry (design doc 5.1): the launcher of the runtime and API
// processes. Windows keeps the single-process workbench, since the split
// processes are tested on POSIX only.
if (process.platform === 'win32') await import('./workbench.mjs');
else await (await import('./launcher.mjs')).runLauncher();
