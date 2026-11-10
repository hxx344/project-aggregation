// Production preview :4180. All APIs are synthetic; no update, deployment or external call.
async page => {
  const origin = 'http://127.0.0.1:4180', planId = 'a'.repeat(64), jobId = 'd'.repeat(32), now = Date.now();
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const errors = [], writes = [], external = [];
  let rejectDelete = true, impactMode = 'busy', expired = false;
  let grants = [
    { id: '1'.repeat(64), projectId: 'asset', projectName: '资产模块夹具', scope: 'persistent', expiresAt: new Date(now + 3600000).toISOString(), status: 'active' },
    { id: '2'.repeat(64), projectId: 'monitor', projectName: '监控模块夹具', scope: 'persistent', expiresAt: new Date(now + 3600000).toISOString(), status: 'active' },
  ];
  const update = { enabled: true, checking: false, checkedAt: new Date(now).toISOString(), checkError: null, planId,
    expiresAt: new Date(now + 3600000).toISOString(), deploymentModes: ['source', 'ci'], planScopes: { source: 'full', ci: 'api' },
    modules: [{ id: 'hub', name: '工作台', state: 'available', currentVersion: 'v1', latestVersion: 'v2', currentCommit: 'b'.repeat(40), latestCommit: 'a'.repeat(40) }],
    job: { id: jobId, status: 'failed', startedAt: new Date(now - 10000).toISOString(), finishedAt: new Date(now - 5000).toISOString(), activeModule: null,
      message: '隔离失败任务', steps: [{ id: 'hub', name: '工作台', status: 'failed', message: '已记录失败' }] } };
  const handler = async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { external.push(url.href); return route.abort('blockedbyclient'); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const send = (json, status = 200) => route.fulfill({ status, json });
    if (url.pathname === '/api/session') return send({ authenticated: true, csrfToken: 'p2-platform-fixture' });
    if (url.pathname === '/api/overview') return send({ projects: [], generatedAt: new Date().toISOString() });
    if (url.pathname === '/api/system/updates') return send(update);
    if (url.pathname === '/api/portal/grants' && request.method() === 'GET') return expired ? send({ error: '会话已失效' }, 401)
      : send({ schemaVersion: 1, observedAt: new Date().toISOString(), instanceId: 'fixture', externalScope: 'current-api-instance', grants, truncated: false });
    if (url.pathname.startsWith('/api/portal/grants/') && request.method() === 'DELETE') {
      writes.push({ method: request.method(), path: url.pathname });
      if (rejectDelete) return send({ error: '授权撤销未完成，请稍后重试并核对结果' }, 503);
      grants = grants.filter(row => !url.pathname.endsWith(row.id)); return send({ revoked: true });
    }
    if (url.pathname === '/api/system/updates/impact') {
      assert(request.method() === 'GET', 'impact never writes');
      if (impactMode === 'error') return send({ error: '影响读取暂不可用' }, 503);
      const mode = url.searchParams.get('deployMode'), phase = url.searchParams.get('phase');
      const observedAt = new Date(Date.now() - (impactMode === 'stale' ? 30000 : 0)).toISOString();
      return send({ schemaVersion: 1, planId, deployMode: mode, phase, scope: mode === 'ci' ? 'api' : 'full', observedAt,
        effect: mode === 'ci' ? 'api-reconnect' : 'module-restart', evidence: mode === 'ci' ? null : { observedAt, modules: [
          { moduleId: 'hub', busy: true, observedAt, reasonCode: 'native-tasks-active', activeRequests: 1, tasks: [{ id: '11111111-1111-4111-8111-111111111111', status: 'paused' }], truncated: false },
        ] } });
    }
    if (url.pathname === `/api/system/updates/jobs/${jobId}/diagnostic`) return send({ schemaVersion: 1, jobId,
      job: { id: jobId, status: 'failed' }, versions: [], observation: { observedAt: null, units: [] }, health: { status: 'unknown' }, rollback: { status: 'unknown' }, missing: ['unit-states-not-recorded'] });
    if (request.method() !== 'GET') writes.push({ method: request.method(), path: url.pathname });
    return send({ error: 'isolated endpoint unavailable' }, 404);
  };
  const onError = error => errors.push(error.message);
  page.on('pageerror', onError);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => {
    window.EventSource = class { close() {} };
    localStorage.setItem('workbench.update-notice.dismissed', `hub@${'a'.repeat(40)}/v2`);
  });
  await page.route('**/*', handler);
  try {
    await page.goto(`${origin}/?view=projects`);
    const access = page.getByRole('region', { name: '当前会话模块授权' });
    await access.getByText('资产模块夹具', { exact: true }).waitFor();
    await access.getByRole('button', { name: '撤销此授权' }).first().click();
    await access.getByRole('alert').waitFor();
    assert(await access.getByRole('button', { name: '撤销此授权' }).count() === 2, 'failed deletion keeps the grant visible');
    rejectDelete = false;
    await access.getByRole('button', { name: '撤销此授权' }).first().click();
    await access.getByText(/这条授权已撤销/).waitFor();
    assert(await access.getByRole('button', { name: '撤销此授权' }).count() === 1, 'other grants survive');
    await page.getByRole('button', { name: /^系统更新：/ }).click();
    const dialog = page.getByRole('dialog', { name: '系统更新', exact: true }); await dialog.waitFor();
    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: '导出本次失败诊断' }).click();
    assert((await download).suggestedFilename() === `update-${jobId}.json`, 'diagnostic download is bound to the failed job');
    await dialog.getByRole('button', { name: '查看更新', exact: true }).click();
    const impact = dialog.getByRole('region', { name: '更新实时影响' });
    await impact.getByText(/存在未结束任务或在途请求/).waitFor();
    impactMode = 'stale'; await impact.getByRole('button', { name: '重新核对' }).click();
    await impact.getByText(/读取已过期，状态未知/).waitFor();
    impactMode = 'error'; await impact.getByRole('button', { name: '重新核对' }).click();
    await impact.getByRole('alert').waitFor();
    assert(!await impact.getByText(/存在未结束任务或在途请求/).count(), 'failed read withdraws the prior evidence');
    await dialog.getByRole('button', { name: '返回', exact: true }).click();
    await dialog.getByRole('radio', { name: /下载 CI 构建包/ }).check();
    impactMode = 'busy'; await dialog.getByRole('button', { name: '查看更新', exact: true }).click();
    await impact.getByText('仅 API 连接短暂重连，运行时与交易任务继续运行。', { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'impact dialog fits narrow viewport');
    await dialog.getByRole('button', { name: '关闭系统更新', exact: true }).click();
    expired = true;
    await access.getByRole('button', { name: '刷新', exact: true }).click();
    await page.getByRole('heading', { name: '进入工作台', exact: true }).waitFor();
    assert(writes.length === 2 && writes.every(row => row.method === 'DELETE'), 'inspection and exports never submit updates or transactions');
    assert(!errors.length && !external.length, `browser errors ${errors}; external ${external}`);
    return { passed: true, checks: 'grant failure/success/isolation/session; job export; full/API impact; stale/failure withdrawal; narrow view', writes: writes.length };
  } finally { page.off('pageerror', onError); await page.unroute('**/*', handler); }
}
