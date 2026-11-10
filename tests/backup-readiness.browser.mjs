// Run with playwright-cli run-code --filename on the isolated production preview :4180.
async (page) => {
  const origin = 'http://127.0.0.1:4180';
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const errors = [], writes = [];
  const onError = error => errors.push(error.message);
  let mode = 'normal', release = null;
  const archive = { digest: 'a'.repeat(64), checkpointId: '12345678-1234-1234-1234-123456789012', commit: 'b'.repeat(40), completedAt: '2026-11-10T00:00:00Z', verifiedAt: '2026-11-10T00:01:00Z', archiveVerification: 'authenticated-ciphertext', unresolvedDependencyCount: 0 };
  let snapshot = { schemaVersion: 1, availability: 'available', observedAt: '2026-11-10T00:02:00Z', ledgerAvailability: 'available', ledgerRevision: 0,
    schedule: { enabled: true, start: '23:00', end: '01:00', timezone: 'Asia/Shanghai', keep: 7 },
    runs: [{ id: 'manual-' + 'a'.repeat(24), origin: 'manual-registration', status: 'complete', phase: 'complete', error: null, retention: null, notification: null, archive, declaration: null }] };
  const external = route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort();
  const handler = async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
    if (request.method() !== 'GET') writes.push({ pathname, body: request.postDataJSON() });
    if (pathname === '/api/session') return send({ authenticated: true, csrfToken: 'fixture' });
    if (pathname === '/api/health') return send({ status: 'ok' });
    if (pathname === '/api/overview') return send({ generatedAt: new Date().toISOString(), projects: [] });
    if (pathname === '/api/system/updates') return send({ enabled: false, checking: false, modules: [] });
    if (pathname === '/api/system/backup-readiness') {
      if (mode === 'expired') return send({ error: '会话已过期' }, 401);
      if (request.method() === 'POST') {
        if (mode === 'conflict') return send({ error: '台账已被更新，请刷新后重新核对' }, 409);
        const input = request.postDataJSON();
        assert(input.expectedRevision === snapshot.ledgerRevision, 'save includes the observed ledger revision');
        const run = snapshot.runs.find(row => row.archive.digest === input.digest);
        assert(run && input.commit === run.archive.commit && input.backupAt === run.archive.completedAt, 'save binds complete backup identity');
        snapshot = { ...snapshot, ledgerRevision: snapshot.ledgerRevision + 1, runs: snapshot.runs.map(row => row !== run ? row : { ...row, declaration: { checkedAt: '2026-11-10T02:00:00Z', origin: 'operator-declaration', retrieval: input.retrieval, drill: input.drill } }) };
        return send(snapshot);
      }
      if (mode === 'hold') { const old = structuredClone(snapshot); release = () => send(old); return; }
      if (mode === 'failure') return send({ error: '测试读取失败' }, 503);
      return send(snapshot);
    }
    return send({ error: 'Outside fixture scope' }, 503);
  };
  const previousViewport = page.viewportSize();
  page.on('pageerror', onError);
  await page.route('**/*', external);
  await page.route(`${origin}/api/**`, handler);
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${origin}/?view=server-status`);
    const panel = page.locator('.backup-readiness');
    await panel.getByText(/机器归档认证：通过/).waitFor();
    assert((await panel.innerText()).includes('独立演练：未登记'), 'archive verification does not imply independent recovery');
    assert(writes.length === 0, 'viewing readiness sends no writes');
    await panel.getByText('核对取回材料与演练记录', { exact: true }).click();
    const form = panel.locator('form');
    await form.getByLabel('备份包', { exact: true }).selectOption('retrieved');
    await form.getByLabel('数据密钥', { exact: true }).selectOption('missing');
    await form.getByLabel('秘密材料密钥', { exact: true }).selectOption('retrieved');
    await form.getByRole('button', { name: '保存人工核验记录' }).click();
    await panel.getByText(/数据密钥：材料缺失/).waitFor();
    assert((await panel.innerText()).includes('备份包：已取回核验'), 'package and key availability are separate');
    assert(await form.locator('input[type=text],textarea,input[type=password]').count() === 0, 'form has no free-text secret entry');

    mode = 'conflict';
    await form.getByLabel('数据密钥', { exact: true }).selectOption('retrieved');
    await form.getByRole('button', { name: '保存人工核验记录' }).click();
    await form.getByRole('alert').filter({ hasText: '请刷新后核对再保存' }).waitFor();
    assert(await form.getByRole('button', { name: '保存人工核验记录' }).isEnabled(), 'conflict releases submitting state');

    mode = 'hold';
    await panel.getByRole('button', { name: '刷新备份台账' }).click();
    for (let attempt = 0; !release && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert(release, 'old read is held before write');
    mode = 'normal';
    await form.getByRole('button', { name: '保存人工核验记录' }).click();
    await panel.getByText(/数据密钥：已取回核验/).waitFor();
    await release(); release = null;
    assert((await panel.innerText()).includes('数据密钥：已取回核验'), 'late pre-save GET cannot overwrite saved declaration');

    await form.getByLabel('依据', { exact: true }).selectOption('ci-fixture');
    await form.getByLabel('结果', { exact: true }).selectOption('passed');
    await form.getByLabel('隔离状态', { exact: true }).selectOption('isolated');
    await form.getByLabel('演练时间', { exact: true }).fill('2026-11-10T09:00');
    await form.getByLabel('耗时（秒）', { exact: true }).fill('3');
    await form.getByLabel('hub', { exact: true }).check();
    await form.getByRole('button', { name: '保存人工核验记录' }).click();
    await panel.getByText(/登记依据：CI 夹具/).waitFor();
    assert((await panel.innerText()).includes('独立演练：未登记'), 'manually declared CI success stays distinct');

    snapshot = { ...snapshot, runs: [...snapshot.runs, { ...snapshot.runs[0], id: 'scheduled-20261111T000000Z-123456789012', origin: 'scheduled', archive: { ...archive, digest: 'c'.repeat(64), completedAt: '2026-11-11T00:00:00Z' }, declaration: null }] };
    await panel.getByRole('button', { name: '刷新备份台账' }).click();
    await panel.locator('article').first().getByText('c'.repeat(64), { exact: true }).waitFor();
    assert((await panel.locator('article').first().innerText()).includes('独立演练：未登记'), 'new package never inherits the old drill');
    assert((await panel.locator('article').first().innerText()).includes('数据密钥：待取回核验'), 'new package requires its own key retrieval check');

    mode = 'failure';
    await panel.getByRole('button', { name: '刷新备份台账' }).click();
    await panel.getByRole('alert').filter({ hasText: '已有内容可能过期' }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'backup content has no mobile page overflow');
    assert(writes.every(item => item.pathname === '/api/system/backup-readiness'), 'readiness never sends restore/handoff/admission requests');
    mode = 'expired';
    await panel.getByRole('button', { name: '刷新备份台账' }).click();
    await page.getByRole('heading', { name: '进入工作台' }).waitFor();
    assert(errors.length === 0, errors.join('\n'));
    return { passed: true, scenarios: ['archive-vs-recovery', 'missing-key', 'revision-conflict', 'late-read', 'ci-layer', 'new-backup', 'failure-history', 'mobile', 'expired-session'] };
  } finally {
    if (release) await release();
    page.off('pageerror', onError);
    await page.unroute(`${origin}/api/**`, handler);
    await page.unroute('**/*', external);
    if (previousViewport) await page.setViewportSize(previousViewport);
  }
}
