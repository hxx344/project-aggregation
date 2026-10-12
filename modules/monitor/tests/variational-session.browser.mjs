// Run with playwright-cli run-code --filename tests/variational-session.browser.mjs.
// Requires the built app served by tests/oil-exchanges-server.mjs on port 3192.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions -- Playwright CLI evaluates this function.
async page => {
  const check = (value, message) => { if (!value) throw Error(message); };
  const path = '/api/monitors/oil/exchanges/variational/session';
  const requests = [], errors = [];
  const token = 'fixture.header.signature';
  let mode = 'success', quoteReads = 0, releaseSlow, markSlowStarted, markSlowFinished;
  let slowStarted, slowFinished;
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
  await page.route('**/api/monitors/oil/exchanges/variational/quote', route => { quoteReads++; return route.continue(); });
  await page.route(`**${path}`, async route => {
    const request = route.request(), method = request.method();
    requests.push({ method, input: method === 'PUT' ? request.postDataJSON() : null });
    if (method === 'GET') {
      if (mode === 'read-failure') return route.fulfill({ status: 503, json: { error: 'Fixture unavailable' } });
      if (mode === 'unavailable') return route.fulfill({ json: { available: false, configured: false, revision: 0, expiresAt: null, updatedAt: null, status: 'unavailable', error: '当前为网页预览，连接常驻监控服务后可更新 Var token。' } });
      const data = await (await route.fetch()).json();
      if (mode === 'expired') { data.status = 'expired'; data.configured = true; data.expiresAt = new Date(Date.now() - 60_000).toISOString(); }
      if (mode === 'rejected') { data.status = 'rejected'; data.configured = true; }
      if (mode === 'upstream-unavailable') { data.status = 'unavailable'; data.configured = true; data.error = '认证行情暂时读取失败。'; }
      return route.fulfill({ json: data });
    }
    if (mode === 'save-failure') return route.fulfill({ status: 502, json: { error: '服务器访问 Variational 被拦截，请稍后重试；这不代表 token 已过期。 原配置未修改。' } });
    if (mode === 'conflict') {
      await route.fetch();
      return route.fulfill({ status: 409, json: { error: '配置已更新。' } });
    }
    if (mode === 'slow') {
      await new Promise(resolve => { releaseSlow = resolve; markSlowStarted(); });
      try { return await route.fulfill({ json: { available: true, configured: true, revision: 500, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), updatedAt: new Date().toISOString(), status: 'ready', error: '' } }); }
      catch { /* Closing the editor aborts its pending response. */ }
      finally { markSlowFinished(); }
    }
    return route.continue();
  });
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.goto('http://127.0.0.1:3192/?monitor=oil');
  const oil = page.locator('[data-exchange-market="oil"]');
  const trigger = oil.locator('[data-exchange="variational"]').getByRole('button', { name: '更新 Var token', exact: true });
  const panel = oil.locator('.variational-session');
  const input = panel.getByLabel('新的 vr-token', { exact: true });
  const save = panel.getByRole('button', { name: '保存 token', exact: true });
  const reload = panel.getByRole('button', { name: '刷新配置', exact: true });
  const close = panel.getByRole('button', { name: '收起 Var token 表单', exact: true });
  const puts = () => requests.filter(request => request.method === 'PUT');
  await trigger.waitFor();
  check(requests.length === 0, 'Collapsed token editor sends no configuration requests');
  await trigger.focus(); await page.keyboard.press('Enter');
  await reload.waitFor();
  check(requests.length === 1 && requests[0].method === 'GET', 'Opening reads the configuration once');
  check(await trigger.getAttribute('aria-expanded') === 'true', 'Trigger announces the expanded state');
  check(await input.getAttribute('type') === 'password' && await input.getAttribute('autocomplete') === 'new-password', 'Token uses a password field without credential autofill');
  check(await save.isDisabled(), 'Empty token cannot be submitted');
  await input.fill(token);
  mode = 'save-failure';
  await input.press('Enter');
  await panel.getByText('服务器访问 Variational 被拦截，请稍后重试；这不代表 token 已过期。 原配置未修改。', { exact: true }).waitFor();
  check(await input.inputValue() === token && await save.isEnabled(), 'Gateway failure keeps the token available for a deliberate retry');
  check((await panel.innerText()).includes('公开价格和资金费无需 token'), 'Token editor explains public data availability');
  check((await oil.locator('[data-exchange="variational"] [data-label="做空价差年化"]').innerText()) !== '—', 'Failed token save leaves public funding visible');
  const stored = await page.evaluate(() => ({ local: JSON.stringify(localStorage), session: JSON.stringify(sessionStorage), url: location.href, text: document.body.innerText }));
  check(Object.values(stored).every(value => !value.includes(token)), 'Token is absent from browser storage, URL and rendered text');
  mode = 'conflict';
  await save.click();
  await panel.getByText('配置已被其他页面更新，请先刷新配置，再确认后保存。', { exact: true }).waitFor();
  check(await save.isDisabled() && await input.inputValue() === token, 'Conflict retains input but blocks resubmission until refresh');
  const afterConflict = requests.length, beforeRefreshPuts = puts().length;
  check(requests[afterConflict - 1].method === 'PUT', 'Conflict does not automatically reload or resubmit');
  mode = 'success';
  await reload.click();
  await save.waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('.variational-session button[type="submit"]').disabled);
  check(puts().length === beforeRefreshPuts, 'Refreshing configuration never submits the retained token');
  const previousReads = quoteReads;
  const refreshedQuote = page.waitForResponse(response => response.url().includes('/oil/exchanges/variational/quote'));
  await save.click();
  await panel.getByText('已保存，后台会在下一轮采集时自动使用，通常在 15 秒内更新，无需重启。', { exact: true }).waitFor();
  check(await input.inputValue() === '' && await save.isDisabled(), 'Successful save clears the token');
  check(puts().at(-1).input.revision > puts().at(-2).input.revision, 'Explicit retry uses the reloaded revision');
  await refreshedQuote;
  check(quoteReads > previousReads, 'Saving refreshes the current exchange quotes');
  check((await panel.innerText()).includes('有效性以后台采集结果为准'), 'Configured status makes no perpetual-validity claim');
  await input.fill(token);
  await close.click();
  check(await panel.count() === 0 && await trigger.evaluate(element => document.activeElement === element), 'Closing removes the input and returns focus to the trigger');
  await trigger.click(); await reload.waitFor();
  check(await input.inputValue() === '', 'Reopening starts with an empty token');
  mode = 'expired'; await reload.click();
  await panel.getByText('已过期，请更新 token', { exact: true }).waitFor();
  mode = 'rejected'; await reload.click();
  await panel.getByText('会话已失效，请更新 token', { exact: true }).waitFor();
  mode = 'upstream-unavailable'; await reload.click();
  await panel.getByText('认证行情暂不可用', { exact: true }).waitFor();
  check(await input.isEnabled(), 'Upstream outage still allows replacing the token');
  mode = 'read-failure'; await reload.click();
  await panel.getByText('配置读取失败，请刷新配置后重试。', { exact: true }).waitFor();
  check(await save.isDisabled(), 'Failed reads prevent submissions with an uncertain revision');
  mode = 'success'; await reload.click(); await reload.waitFor();
  await input.fill(token);
  await page.getByRole('tab', { name: '海力士 ADR', exact: true }).click();
  check(await panel.count() === 0, 'Inactive monitor unmounts the credential editor');
  await page.getByRole('tab', { name: '原油价差', exact: true }).click();
  await reload.waitFor();
  check(await input.inputValue() === '', 'Returning to a monitor cannot restore the previous token');
  await input.fill(token);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await panel.waitFor({ state: 'detached' });
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  await trigger.click(); await reload.waitFor();
  check(await input.inputValue() === '', 'Hiding the document clears the token editor');
  mode = 'slow';
  slowStarted = new Promise(resolve => { markSlowStarted = resolve; });
  slowFinished = new Promise(resolve => { markSlowFinished = resolve; });
  await input.fill(token); await save.click(); await slowStarted;
  const submitted = puts().length;
  check(await panel.getByRole('button', { name: '保存中…', exact: true }).isDisabled(), 'Pending save disables repeated clicks');
  await panel.locator('form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  check(puts().length === submitted, 'Pending request guard rejects duplicate submits');
  await close.click();
  mode = 'success'; releaseSlow(); await slowFinished;
  await trigger.click(); await reload.waitFor();
  check(await input.inputValue() === '' && await panel.locator('.variational-session-success').count() === 0, 'Late closed-editor response does not update a reopened editor');
  await panel.screenshot({ path: 'output/playwright/variational-session-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Expanded editor fits a narrow viewport');
  const box = await save.boundingBox(); check(box.height >= 44, 'Save button remains a usable touch target');
  await panel.screenshot({ path: 'output/playwright/variational-session-mobile.png' });
  mode = 'unavailable'; await reload.click();
  await panel.getByText('当前为网页预览，连接常驻监控服务后可更新 Var token。', { exact: true }).waitFor();
  check(await input.isDisabled() && await save.isDisabled(), 'Preview environment prevents saving unsupported configuration');
  check(errors.length === 0, errors.join('; '));
  return { passed: true, reads: requests.filter(request => request.method === 'GET').length, writes: puts().length, checked: ['lazy read', 'keyboard', 'password field', 'no persistence', 'save failure', 'revision conflict', 'explicit retry', 'quote refresh', 'success clear', 'close clear', 'inactive clear', 'hidden clear', 'expiry', 'rejection', 'read failure', 'duplicate submit', 'late response', 'mobile', 'unavailable preview'] };
}
