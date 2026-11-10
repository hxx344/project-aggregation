// Run with playwright-cli run-code --filename against the stable production preview on 4176.
async (page) => {
  const origin = 'http://127.0.0.1:4176', root = '/api/research/entropy-lighter';
  const assert = (value, text) => { if (!value) throw new Error(text); };
  const session = '11111111-1111-4111-8111-111111111111';
  const reads = [], writes = [], errors = [];
  let failure = false;
  const config = { schema: 1, region: 'fixture', recordRaw: false, maxDataMb: 16, retentionDays: 1,
    maxBookAgeMs: 750, maxSourceAgeMs: 2000, maxPairSkewMs: 500, sampleIntervalMs: 250,
    simulation: { enabled: false, verifiedSymbols: [], entropyTakerFeeBps: null, lighterTakerFeeBps: null,
      notionalPerLeg: 100, minEntryEdgeBps: 15, slippageBpsPerFill: 2, fundingReserveBpsPerRoundTrip: 2,
      holdMs: 5000, fillWaitMs: 2000, cooldownMs: 10000, rebateRatios: [0, 1.1, 1.2],
      latencyScenarios: [{ name: 'base', entropyMs: 200, lighterMs: 450 }] } };
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.EventSource = class { close() {} }; });
  await page.route(`${origin}/api/**`, async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (request.method() !== 'GET') writes.push(path);
    if (path === '/api/session') return send({ authenticated: true, csrfToken: 'fixture' });
    if (path === '/api/health') return send({ status: 'ok' });
    if (path === '/api/overview') return send({ projects: [], generatedAt: new Date().toISOString() });
    if (path === '/api/system/updates') return send({ enabled: false, modules: [], job: null });
    if (path === root) return send({ schema: 1, state: 'stopped', enabled: false, stale: true, serverNow: Date.now(),
      reportAgeMs: 0, config, report: { session, mode: 'research', startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(), counts: { books: 0 }, latestQuotes: [], recentSpreads: {}, paper: {}, diagnostics: {} } });
    if (path === `${root}/evidence`) {
      reads.push(Object.fromEntries(url.searchParams));
      if (failure) return send({ error: 'fixture evidence unavailable' }, 503);
      return send({ jsonl: '{"kind":"normalized_event"}\n', manifest: { selection: Object.fromEntries(url.searchParams),
        gaps: ['raw_recording_disabled', 'segments_missing_or_cleaned'], output: { records: 1, rawFrames: 0, normalizedEvents: 1 }, scan: { bytes: 1234 } } });
    }
    return send({ error: 'fixture endpoint unavailable' }, 404);
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/?view=research`);
  await page.locator('.el-technical > summary').click();
  const section = page.getByRole('region', { name: '研究证据导出' });
  await section.getByLabel('导出会话').waitFor();
  await section.getByLabel('导出开始').fill('2026-11-10T08:00');
  await section.getByLabel('导出结束').fill('2026-11-10T08:05');
  await section.getByRole('button', { name: '生成证据片段' }).click();
  await section.getByRole('link', { name: '下载 JSONL' }).waitFor();
  assert(reads.length === 1 && reads[0].session === session && reads[0].symbol === 'SNDK', 'selected session and symbol reach the real page API call');
  assert(Number(reads[0].to) - Number(reads[0].from) === 300000, 'local time inputs convert to millisecond window');
  assert((await section.innerText()).includes('该会话未启用原始帧记录'), 'raw-disabled gap is visible');
  assert((await section.innerText()).includes('部分分段已缺失或清理'), 'cleaned-segment gap is visible');
  for (const [label, filename] of [['下载 JSONL', 'entropy-evidence.jsonl'], ['下载清单', 'entropy-evidence-manifest.json']]) {
    const download = page.waitForEvent('download');
    await section.getByRole('link', { name: label, exact: true }).click();
    assert((await download).suggestedFilename() === filename, 'download filenames preserve separate JSONL and manifest artifacts');
  }
  await section.getByLabel('导出开始').fill('2026-11-08T08:00');
  assert(await section.getByRole('link', { name: '下载 JSONL' }).count() === 0, 'changed filters withdraw the old result');
  await section.getByRole('button', { name: '生成证据片段' }).click();
  assert(reads.length === 1, 'over-24-hour selection does not issue a request');
  assert((await section.getByRole('alert').innerText()).includes('最多 24 小时'), 'invalid range is explained');
  await section.getByLabel('导出开始').fill('2026-11-10T08:00'); failure = true;
  await section.getByRole('button', { name: '生成证据片段' }).click();
  await section.getByText('fixture evidence unavailable', { exact: true }).waitFor();
  assert(await section.getByRole('link', { name: '下载 JSONL' }).count() === 0, 'failed export never reuses an old bundle');
  failure = false;
  await page.getByRole('group', { name: '价差标的' }).getByRole('button', { name: 'ANTH', exact: true }).click();
  assert((await section.innerText()).includes('当前标的 ANTH'), 'symbol changes remount the export selection');
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'new export form fits narrow viewport');
  assert(writes.length === 0 && errors.length === 0, `read-only UI, no browser errors: ${errors.join('; ')}`);
  return { checks: 'session-symbol-window, bounded-range, raw/cleaned gaps, JSONL-manifest downloads, changed-input withdrawal, failure, symbol-switch, narrow-form', exports: reads.length };
}
