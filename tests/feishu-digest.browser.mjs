// Run against the production workbench preview on port 4180:
// playwright-cli -s=feishu-digest run-code --filename tests/feishu-digest.browser.mjs
// Every API is an isolated fixture; no request reaches a real robot or trading service.
async (page) => {
  const origin = 'http://127.0.0.1:4180', root = '/api/automation/feishu-digest';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  let config = { enabled: false, title: '初始标题', onlyOnAttention: false, hideIdle: true, showIssues: true, sections: {},
    schedule: { mode: 'times', times: ['09:00', '21:00'], intervalMinutes: 240, weekdays: [1, 2, 3, 4, 5, 6, 7], timezone: 'Asia/Shanghai' } };
  let channel = true, nextRead = null, nextSave = null, failSave = false;
  const writes = [], errors = [], checks = [];
  const onError = error => errors.push(error.message);
  const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
  const snapshot = () => ({ schema: 1, config: structuredClone(config), channel: { configured: channel, host: channel ? 'open.feishu.cn' : null, error: null },
    sending: false, nextAt: null, history: [], loadError: null, serverNow: Date.now() });
  const handler = async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== origin) return route.abort('blockedbyclient');
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const send = (json, status = 200) => route.fulfill({ status, json });
    if (url.pathname === '/api/session') return send({ authenticated: true, csrfToken: 'feishu-browser-fixture' });
    if (url.pathname === '/api/overview') return send({ projects: [], generatedAt: new Date().toISOString() });
    if (url.pathname === root && method === 'GET') {
      if (nextRead) { const held = nextRead; nextRead = null; held.resolve({ route, data: snapshot() }); return; }
      return send(snapshot());
    }
    if (url.pathname === `${root}/preview`) {
      const draft = request.postDataJSON().config;
      return send({ digest: { title: draft.title, at: new Date().toISOString(), clock: '10-31 09:00', level: 'ok', sections: [], attention: [] }, bytes: 200, omitted: 0, catalog: [] });
    }
    if (url.pathname === `${root}/config` && method === 'PUT') {
      writes.push('config');
      if (failSave) return send({ error: '夹具保存失败' }, 503);
      config = request.postDataJSON().config;
      if (nextSave) { const held = nextSave; nextSave = null; held.resolve({ route, data: snapshot() }); return; }
      return send(snapshot());
    }
    if (url.pathname === `${root}/channel/clear` && method === 'POST') {
      writes.push('clear'); channel = false; config = { ...config, enabled: false }; return send(snapshot());
    }
    return send({ error: 'isolated fixture' }, 404);
  };
  const flush = async () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const finishHeld = async held => {
    const response = page.waitForResponse(item => item.url() === held.route.request().url() && item.request().method() === held.route.request().method());
    await held.route.fulfill({ status: 200, json: held.data });
    await (await response).finished(); await flush();
  };
  page.on('pageerror', onError);
  await page.route('**/*', handler);
  try {
    await page.goto(`${origin}/?view=feishu-digest`);
    const title = page.getByLabel('标题', { exact: true });
    const enabled = page.getByLabel('开启定时发送', { exact: true });
    const save = page.getByRole('button', { name: '保存设置', exact: true });
    const refresh = page.getByRole('button', { name: '刷新', exact: true });
    const dirty = page.getByText('有未保存的修改', { exact: true });
    const refreshReady = () => page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === '刷新' && !button.disabled));
    await title.waitFor();

    await refreshReady(); nextRead = deferred(); const oldRead = nextRead.promise;
    await refresh.click(); const held = await oldRead;
    await title.fill('已确认的新标题'); await enabled.check();
    await save.click(); await page.getByText('设置已保存', { exact: true }).waitFor();
    await finishHeld(held);
    assert(config.title === '已确认的新标题' && config.enabled, 'the fixture accepted the write');
    assert(await title.inputValue() === config.title && await enabled.isChecked(), 'late GET cannot replace saved title or enabled state');
    assert(await dirty.count() === 0 && await save.isDisabled(), 'the confirmed draft remains clean');
    await page.getByText('定时发送已开启', { exact: true }).waitFor();
    checks.push('late GET after config write');

    await title.fill('正在提交'); nextSave = deferred(); const saving = nextSave.promise;
    await save.click(); const heldSave = await saving;
    await title.fill('保存过程中继续编辑');
    await finishHeld(heldSave);
    assert(config.title === '正在提交', 'only the submitted value was saved');
    assert(await title.inputValue() === '保存过程中继续编辑', 'new edits survive the successful response');
    await dirty.waitFor(); assert(await save.isEnabled(), 'new edits remain saveable');
    checks.push('edits during save');

    const previousTitle = config.title;
    nextSave = deferred(); const reverting = nextSave.promise;
    await save.click(); const heldRevert = await reverting;
    await title.fill(previousTitle); // Equal to the old snapshot, but still a new edit after submission.
    await finishHeld(heldRevert);
    assert(await title.inputValue() === previousTitle && config.title !== previousTitle, 'an edit back to the old value must also survive the response');
    await dirty.waitFor(); assert(await save.isEnabled(), 'the reverted draft differs from the now-saved value');
    checks.push('edit back to the prior value during save');

    await title.fill('保存失败保留');
    failSave = true; await save.click();
    await page.getByRole('alert').filter({ hasText: '夹具保存失败' }).waitFor();
    assert(await title.inputValue() === '保存失败保留' && await save.isEnabled(), 'a refused write keeps the unsaved draft and releases busy');
    failSave = false; await save.click();
    await page.getByText('设置已保存', { exact: true }).waitFor();
    assert(await dirty.count() === 0, 'retry confirms the draft');
    checks.push('failed save and retry');

    config = { ...config, title: '后续服务端更新' };
    await refreshReady(); await refresh.click();
    await page.waitForFunction(() => document.querySelector('input[maxlength="60"]')?.value === '后续服务端更新');
    checks.push('later normal refresh');

    await refreshReady(); nextRead = deferred(); const beforeClear = nextRead.promise;
    await refresh.click(); const heldChannel = await beforeClear;
    await page.getByRole('button', { name: '清除', exact: true }).click();
    await page.getByText('机器人已清除，定时发送已关闭', { exact: true }).waitFor();
    await finishHeld(heldChannel);
    assert(!channel && !config.enabled && !await enabled.isChecked(), 'clear remains reflected after a late GET');
    await page.getByText('尚未配置', { exact: true }).waitFor();
    checks.push('late GET after channel clear');
    assert(errors.length === 0, `page errors: ${errors.join('; ')}`);
    assert(writes.every(value => ['config', 'clear'].includes(value)), 'only fixture configuration writes occurred');
    return { checks, writes: writes.length };
  } finally {
    page.off('pageerror', onError);
    await page.unroute('**/*', handler);
  }
}
