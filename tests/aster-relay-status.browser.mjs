// Start: node --import ./tests/fixtures/aster-notices-workbench.mjs server/index.mjs
// Run: playwright-cli -s=aster-relay run-code --filename tests/aster-relay-status.browser.mjs
// Uses the real Hub login/launch/proxy and the built embedded ASTER dashboard.
// Synthetic read-only state; real elapsed time keeps serverNow and fixture timestamps aligned.
async (page) => {
  const origin = 'http://hub.localhost:39152';
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const errors = [], consoleErrors = [], writes = [], external = [], reads = [], observations = [];
  const apiError = '浏览器夹具：主服务器状态读取失败';
  const connectedAt = Date.now() / 1000 - 3600;
  const connectionAttempts = 3;
  let moduleOrigin, frame, releaseHeldRead, holdNextRead = false, failReads = false;
  let mode = {};
  const pageError = error => errors.push(error.stack || error.message);
  const consoleError = message => {
    if (message.type() === 'error') consoleErrors.push({ text: message.text(), url: message.location().url });
  };
  const isStateUrl = value => {
    try { const url = new URL(value); return url.origin === moduleOrigin && url.pathname === '/api/state'; }
    catch { return false; }
  };
  const state = () => {
    const now = Date.now() / 1000, observedAt = now - (mode.observationAge ?? 0);
    const age = mode.sampleAge ?? 0.4;
    return { workspaceManaged: true, ready: true, demo: false, accounts: [], pairs: [],
      markets: {}, events: [], updated_at: now, notification: { configured: false, pending: 0 },
      capacity_relay: { enabled: true, running: true, connected: mode.connected ?? true,
        closed: false, instance_id: 'relay-browser-fixture', cached_samples: 2,
        observed_at: observedAt, last_error: mode.wsError ?? mode.httpError ?? null,
        ws: { connected_at: connectedAt, disconnected_at: mode.disconnectedAt ?? null,
          last_message_at: observedAt, last_sample_at: observedAt - age,
          connection_attempts: connectionAttempts, retry_in_seconds: mode.retry ?? null,
          last_error: mode.wsError ?? null },
        http: { inflight: 0, requests: 2, failures: mode.httpError ? 1 : 0,
          last_attempt_at: observedAt - 1, last_success_at: observedAt - 2,
          last_error: mode.httpError ?? null },
        samples: [
          { kind: 'oi', symbol: 'XAUUSD1', source: 'ws', age_seconds: age,
            max_age_seconds: 8, received_at: observedAt - age },
          { kind: 'brackets', symbol: 'XAUUSD1', source: 'http', age_seconds: 2,
            max_age_seconds: 300, received_at: observedAt - 2 },
        ] },
    };
  };
  const routeRequest = async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.port !== '39152' || !(url.hostname === 'hub.localhost' || /^p-[a-f0-9]+\.hub\.localhost$/.test(url.hostname))) {
      external.push(url.href); return route.abort('blockedbyclient');
    }
    if (!['GET', 'HEAD'].includes(request.method())) {
      if (url.origin === origin && (url.pathname === '/api/login'
        || /^\/api\/projects\/(?:aster|asset|monitor|crossex|greeks)\/launch$/.test(url.pathname))) return route.continue();
      writes.push(`${request.method()} ${url.href}`);
      return route.fulfill({ status: 405, json: { detail: 'Trading writes forbidden' } });
    }
    if (url.origin !== origin && url.pathname === '/api/state') {
      moduleOrigin = url.origin;
      reads.push({ at: Date.now(), method: request.method() });
      if (holdNextRead) {
        holdNextRead = false;
        await new Promise(resolve => { releaseHeldRead = resolve; });
        releaseHeldRead = undefined;
      }
      return route.fulfill(failReads
        ? { status: 503, json: { detail: apiError } }
        : { status: 200, json: state() });
    }
    return route.continue();
  };
  const eventually = async (check, message) => {
    for (let i = 0; i < 50; i++) {
      if (await check()) return;
      await page.waitForTimeout(20);
    }
    throw new Error(message);
  };
  await page.unrouteAll({ behavior: 'wait' });
  page.on('pageerror', pageError);
  page.on('console', consoleError);
  await page.route('**/*', routeRequest);
  await page.setViewportSize({ width: 1440, height: 1050 });
  try {
    await page.goto(`${origin}/?view=project&id=aster`);
    const iframe = page.locator('iframe[title="Aster 5x模块"]');
    const password = page.getByRole('textbox', { name: '工作台密码', exact: true });
    await password.or(iframe).first().waitFor();
    if (await password.isVisible()) {
      await password.fill('aster-notices-browser-fixture');
      await page.getByRole('button', { name: '登录', exact: true }).click();
    }
    await iframe.waitFor();
    const app = page.frameLocator('iframe[title="Aster 5x模块"]');
    const panel = app.locator('details[aria-label="副服务器额度连接"]');
    const connection = panel.locator('.relay-status-label');
    const data = panel.locator('.relay-status-data');
    const samples = panel.getByRole('table', { name: '副服务器额度样本详情', exact: true });
    const oi = samples.locator('tbody tr').filter({ hasText: '公开额度' });
    await panel.waitFor();
    await panel.locator('summary').click();
    frame = page.frames().find(candidate => candidate.url().startsWith(moduleOrigin));
    assert(frame, 'actual embedded ASTER frame is loaded');
    const hasTone = async (locator, tone) => (await locator.getAttribute('class'))?.split(/\s+/).includes(`relay-tone-${tone}`);
    const expectTone = async (locator, tone, message) => eventually(() => hasTone(locator, tone), message);
    const readResponse = () => page.waitForResponse(response => isStateUrl(response.url())
      && response.request().method() === 'GET');
    const settle = async response => {
      const result = await response;
      await result.finished();
      await page.waitForTimeout(80);
      return result;
    };
    const refresh = async nextMode => {
      if (nextMode !== undefined) mode = nextMode;
      const response = readResponse();
      await app.getByRole('button', { name: '刷新数据', exact: true }).first().click();
      return settle(response);
    };
    const fact = name => panel.getByRole('region', { name: 'WS 连接详情', exact: true })
      .locator('.relay-facts > div').filter({ hasText: name }).locator('dd');
    const checkNoReconnect = async response => {
      const relay = (await response.json()).capacity_relay;
      assert(relay.ws.connection_attempts === connectionAttempts && relay.ws.disconnected_at === null,
        'restored GET retains connection attempts and a null disconnect time');
      assert(await fact('连接尝试次数').innerText() === String(connectionAttempts), 'connection attempt count stays visible and unchanged');
      assert(await fact('最近断开').innerText() === '—', 'no disconnect is invented in connection details');
    };

    await expectTone(connection, 'good', 'healthy WS connection is green');
    await expectTone(data, 'good', 'healthy data has its own green status');
    assert(await connection.innerText() === 'WS 已连接', 'healthy connection wording');
    assert((await oi.innerText()).includes('采集时 · 额度缓存有效'), 'fresh OI is shown as a valid cache sample');
    await checkNoReconnect(await refresh({}));
    observations.push('healthy WS and samples are independently green');

    // Hidden tabs keep their existing thirty-second cadence. Returning updates
    // serverNow before the delayed GET, exposing the strict eight-second TTL.
    const hiddenResponse = readResponse();
    await frame.evaluate(() => {
      window.__relayVisibilityDescriptors = {
        hidden: Object.getOwnPropertyDescriptor(document, 'hidden'),
        visibilityState: Object.getOwnPropertyDescriptor(document, 'visibilityState'),
      };
      window.__relayHidden = true;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__relayHidden });
      Object.defineProperty(document, 'visibilityState', { configurable: true,
        get: () => window.__relayHidden ? 'hidden' : 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const hiddenSnapshot = await settle(hiddenResponse);
    const readsWhileHidden = reads.length;
    await page.waitForTimeout(9000);
    assert(reads.length === readsWhileHidden, 'hidden iframe does not poll at the three-second foreground cadence');
    const hiddenState = await hiddenSnapshot.json();
    assert(Date.now() / 1000 - hiddenState.capacity_relay.observed_at >= 8, 'stored relay observation has exceeded its strict TTL');
    holdNextRead = true;
    const resumedResponse = readResponse();
    await frame.evaluate(() => {
      window.__relayHidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await eventually(() => Boolean(releaseHeldRead), 'returning to the iframe starts a state GET');
    await expectTone(connection, 'muted', 'stale healthy WS becomes neutral while the resumed GET is pending');
    assert(await connection.innerText() === 'WS 状态待更新', 'stale healthy WS does not claim a current connection or reconnect');
    assert((await data.innerText()).includes('最近记录') && (await data.innerText()).includes('时效待更新'), 'sample summary explicitly remains historical');
    const freshness = await samples.locator('tbody tr td:last-child').allTextContents();
    assert(freshness.length === 2 && freshness.every(text => text === '最近记录 · 时效待更新'), 'neither stale sample claims current freshness');
    assert(await samples.locator('tbody .relay-tone-good').count() === 0, 'stale sample cells are not green');
    await page.screenshot({ path: 'output/playwright/aster-relay-resume-pending.png', fullPage: true });
    releaseHeldRead();
    const restoredResponse = await settle(resumedResponse);
    await expectTone(connection, 'good', 'a fresh GET restores the green WS connection');
    await expectTone(data, 'good', 'a fresh GET restores sample freshness');
    await checkNoReconnect(restoredResponse);
    observations.push('nine-second hidden interval, delayed resume GET, neutral pending state, strict stale samples and recovery without changed reconnect metrics');

    await refresh({ connected: false, disconnectedAt: Date.now() / 1000 - 1, retry: 4 });
    await expectTone(connection, 'warning', 'reported WS disconnection warns immediately');
    assert(await connection.innerText() === 'WS 等待重连', 'reported retry remains visible');
    await refresh({ wsError: 'stream_unavailable' });
    await expectTone(connection, 'warning', 'reported WS error warns even when connected remains true');
    assert(await panel.getByText('WS 连接暂不可用', { exact: true }).count() === 1, 'specific WS error remains visible');
    await refresh({ connected: false, disconnectedAt: Date.now() / 1000 - 10, retry: 4, observationAge: 9 });
    await expectTone(connection, 'warning', 'stale snapshots retain a known WS failure');
    assert(await connection.innerText() === '最近记录 · WS 等待重连', 'known stale failure retains its historical qualifier');
    observations.push('fresh disconnect, explicit WS error and historical known disconnect remain warnings');

    for (const [sampleAge, expected] of [[9, '缓存已过期']]) {
      await refresh({ sampleAge });
      await expectTone(connection, 'good', `${sampleAge}-second sample does not recolor a healthy WS connection`);
      await expectTone(data, 'warning', `${sampleAge}-second sample warns independently`);
      assert(await connection.innerText() === 'WS 已连接', 'sample age does not imply WS disconnection');
      assert((await oi.innerText()).includes(expected), `${sampleAge}-second sample keeps its actual freshness restriction`);
      assert(await oi.locator('td.relay-tone-warning').count() === 1, 'affected sample cell warns');
    }
    await refresh({ httpError: 'snapshot_unavailable' });
    await expectTone(connection, 'good', 'HTTP fallback error does not recolor a healthy WS connection');
    await expectTone(data, 'warning', 'HTTP fallback error remains a data warning');
    assert(await panel.getByText('HTTP 补取暂不可用', { exact: true }).count() === 1, 'HTTP error detail remains visible');
    await page.screenshot({ path: 'output/playwright/aster-relay-http-warning.png', fullPage: true });
    observations.push('nine-second cache expiry and HTTP errors warn only in data status');

    await refresh({});
    failReads = true;
    const failed = await refresh();
    assert(failed.status() === 503, 'page API failure was exercised');
    await expectTone(connection, 'muted', 'page API failure makes the WS state unknown');
    await expectTone(data, 'warning', 'page API failure retains a data warning');
    assert(await connection.innerText() === 'WS 状态待更新', 'page API failure does not invent a WS disconnect or claim a live connection');
    assert((await panel.locator('.relay-status-note').innerText()).includes('无法确认当前连接和样本时效'), 'page API failure explains the observation limit');
    assert((await app.locator('.message-error').allTextContents()).some(text => text.includes(apiError)), 'page read failure remains visible');
    failReads = false;
    await checkNoReconnect(await refresh({}));
    await expectTone(connection, 'good', 'page API recovery restores the WS indicator');
    await expectTone(data, 'good', 'page API recovery restores the data indicator');
    await page.screenshot({ path: 'output/playwright/aster-relay-recovered.png', fullPage: true });
    observations.push('page API failure produces unknown WS state, visible read error and clean recovery');

    const unexpectedConsole = consoleErrors.filter(error => !(isStateUrl(error.url)
      && /\b503\b/.test(error.text) && /Failed to load resource/.test(error.text)));
    assert(errors.length === 0, `browser errors: ${errors.join('; ')}`);
    assert(unexpectedConsole.length === 0, `unexpected console errors: ${JSON.stringify(unexpectedConsole)}`);
    assert(writes.length === 0, `unexpected writes: ${writes.join('; ')}`);
    assert(external.length === 0, `external requests: ${external.join('; ')}`);
    assert(reads.every(read => read.method === 'GET'), 'all synthetic state reads use GET');
    return { passed: true, entry: page.url(), moduleOrigin, realClock: true, tradingWrites: 0,
      browserErrors: 0, stateReads: reads.length, expectedFailedReads: consoleErrors.length, observations };
  } catch (error) {
    await page.screenshot({ path: 'output/playwright/aster-relay-failure.png', fullPage: true }).catch(() => {});
    throw new Error(`${error.stack || error.message || String(error)}\nBrowser page errors:\n${errors.join('\n') || '(none)'}\nBrowser console errors:\n${JSON.stringify(consoleErrors)}`, { cause: error });
  } finally {
    holdNextRead = false;
    releaseHeldRead?.();
    if (frame && !frame.isDetached()) await frame.evaluate(() => {
      const descriptors = window.__relayVisibilityDescriptors;
      if (!descriptors) return;
      for (const property of ['hidden', 'visibilityState']) {
        if (descriptors[property]) Object.defineProperty(document, property, descriptors[property]);
        else delete document[property];
      }
      delete window.__relayHidden;
      delete window.__relayVisibilityDescriptors;
      document.dispatchEvent(new Event('visibilitychange'));
    }).catch(() => {});
    await page.unroute('**/*', routeRequest);
    await page.unrouteAll({ behavior: 'wait' });
    page.off('pageerror', pageError);
    page.off('console', consoleError);
  }
}
