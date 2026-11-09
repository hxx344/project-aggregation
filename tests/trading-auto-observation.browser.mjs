// Run with playwright-cli run-code against the isolated production build on 4175.
async (page) => {
  const origin = 'http://127.0.0.1:4175';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const stamp = () => new Date().toISOString(), writes = [], errors = [];
  let rule = null, online = true, holdRead = false, waitingRead = null;
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
  const state = () => ({ generatedAt: stamp(), exposureVersion: rule ? String(rule.revision) : 'empty', maintenance: false, rules: rule ? [rule] : [] });
  const reading = () => ({ hits: 2, value: 4.2, met: true, side: 'sell', at: stamp(), note: null });
  await page.route('**/api/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    const send = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/api/session') return send({ authenticated: true, csrfToken: 'observation-fixture' });
    if (path === '/api/overview/events') return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ projects: [], generatedAt: stamp() })}\n\n` });
    if (path === '/api/overview') return send({ projects: [], generatedAt: stamp() });
    if (path === '/api/trading/execution') return send({ generatedAt: stamp(), connections: [], positions: [], jobs: [] });
    if (path === '/api/trading/execution/quotes') return send({ generatedAt: stamp(), maxAgeMs: 10000, books: [] });
    if (path === '/api/trading/execution/auto' && req.method() === 'GET') {
      if (!online) return route.abort('internetdisconnected');
      if (holdRead) { waitingRead = () => send(state()); return; }
      return send(state());
    }
    if (path.startsWith('/api/trading/execution/auto/rules')) {
      const body = JSON.parse(req.postData()); writes.push({ path, body });
      assert(req.headers()['x-csrf-token'] === 'observation-fixture', 'mutations carry CSRF');
      if (path.endsWith('/rules')) {
        rule = { id: '00000000-0000-4000-8000-000000000283', revision: 0, enabled: false, mode: body.mode, observing: body.observing, createdAt: stamp(), title: '观察测试', config: body.config,
          spread: { label: 'BZ − CL', unit: 'USDT/桶' }, state: { phase: 'idle', jobId: null, held: null, opensToday: 0, failures: 0, retryAt: null, reason: null, events: [] }, live: null,
          observation: { open: reading(), close: { ...reading(), value: 4.3, hits: 0, met: false }, note: null, events: [{ time: stamp(), kind: 'signal', action: 'open', message: '开仓条件本会触发；仅记录信号，未下单', hits: 2, value: 4.2, threshold: '4', inputs: { premiumAt: stamp(), baseAt: stamp() } }] } };
      } else if (path.endsWith('/live')) { assert(body.confirmLive === true, 'independent live confirmation'); rule = { ...rule, revision: rule.revision + 1, mode: 'live', observing: false, enabled: true, live: null }; }
      else if (path.endsWith('/disable')) rule = { ...rule, revision: rule.revision + 1, enabled: false, observing: false, live: null };
      else if (path.endsWith('/observe')) rule = { ...rule, revision: rule.revision + 1, enabled: false, mode: 'observe', observing: true };
      else return send({ error: 'unexpected write' }, 400);
      return send(state());
    }
    return send({ error: 'fixture scope' }, 503);
  });
  await page.goto(`${origin}/?view=trading&tradingSection=auto`);
  const panel = page.locator('section.auto-panel');
  await panel.getByText('尚无自动规则').waitFor();
  await panel.getByRole('button', { name: '新建规则' }).click();
  const form = panel.getByRole('form', { name: '新建自动规则' });
  await form.getByLabel('规则名称（选填）').fill('观察测试');
  await form.getByLabel('开仓阈值 · USDT/桶').fill('4');
  await form.getByLabel('平仓阈值 · USDT/桶').fill('2');
  await form.getByLabel('每腿桶数 · 桶').fill('1');
  await form.getByLabel('保存后开始只观察').check();
  await form.getByRole('button', { name: '保存并观察' }).click();
  await panel.getByText('规则已保存并开始只观察。').waitFor();
  assert(writes.length === 1 && writes[0].body.mode === 'observe' && writes[0].body.observing === true && writes[0].body.enabled === undefined, 'saving observation never enables live');
  const card = panel.getByRole('article', { name: '自动规则 观察测试' });
  await card.getByText('只观察中', { exact: true }).waitFor();
  assert(await card.getByRole('button', { name: '转为实盘' }).isDisabled(), 'conversion starts disabled');
  await card.getByText('观察记录（最近 30 条）').click();
  await card.getByText('开仓条件本会触发；仅记录信号，未下单', { exact: false }).waitFor();
  await card.getByRole('button', { name: '停止观察' }).click();
  await card.getByText('观察已停止', { exact: true }).waitFor();
  await card.getByRole('button', { name: '开始只观察' }).click();
  await card.getByText('只观察中', { exact: true }).waitFor();
  const before = writes.length;
  online = false;
  await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }); window.dispatchEvent(new Event('offline')); });
  await card.getByText('当前状态待重新读取，不展示旧连续次数。').waitFor();
  holdRead = true; online = true;
  await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, value: true }); window.dispatchEvent(new Event('online')); });
  await page.waitForTimeout(200);
  assert(await card.getByRole('button', { name: '转为实盘' }).isDisabled(), 'online alone cannot restore stale confirmation');
  assert((await card.innerText()).includes('状态待更新'), 'reconnect waits for fresh GET');
  holdRead = false; if (waitingRead) await waitingRead();
  await card.getByText('只观察中', { exact: true }).waitFor();
  assert(writes.length === before, 'network events do not write');
  await card.getByLabel('确认结束观察并转为自动实盘下单').check();
  await card.getByRole('button', { name: '转为实盘' }).click();
  await panel.getByText('已转为实盘，等待新盘口重新判断。').waitFor();
  assert(writes.at(-1).path.endsWith('/live'), 'separate live transition endpoint');
  await card.getByText('等待读取盘口…', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 900 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'narrow page does not overflow');
  assert(errors.length === 0, `page errors: ${errors.join(',')}`);
  return { passed: true, writes: writes.length, scenarios: ['create observe', 'signal evidence', 'stop/restart', 'offline/reconnect', 'independent live confirmation', 'narrow layout'] };
}
