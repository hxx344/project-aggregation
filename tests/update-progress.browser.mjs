/**
 * Browser integration tests for update progress display.
 */

export const tests = [
  {
    name: 'displays download progress with speed and ETA',
    async run({ page, intercept }) {
      // Mock update status showing a running job
      intercept('/api/system/updates/status', {
        type: 'json',
        body: {
          enabled: true,
          checking: false,
          checkedAt: new Date().toISOString(),
          planId: 'test-plan-123',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          modules: [],
          job: {
            id: 'job-001',
            status: 'running',
            startedAt: new Date().toISOString(),
            finishedAt: null,
            activeModule: 'workbench',
            steps: [
              { id: 's1', name: '准备更新', status: 'succeeded' },
              { id: 's2', name: '下载部署包', status: 'running' },
            ],
            message: '正在下载更新包',
          },
        },
      });

      // Mock SSE progress stream
      const progressEvents = [
        { stage: 'preflight', progress: 1.0, total: 108630372, timestamp: Date.now() },
        { stage: 'download', progress: 0.2, downloaded: 21726074, total: 108630372, speed: 2500000, eta: 35, timestamp: Date.now() },
        { stage: 'download', progress: 0.5, downloaded: 54315186, total: 108630372, speed: 2600000, eta: 21, timestamp: Date.now() },
        { stage: 'download', progress: 0.8, downloaded: 86904297, total: 108630372, speed: 2550000, eta: 9, timestamp: Date.now() },
        { stage: 'download', progress: 1.0, downloaded: 108630372, total: 108630372, speed: 2500000, eta: 0, timestamp: Date.now() },
        { stage: 'verify', progress: 1.0, total: 108630372, timestamp: Date.now() },
        { stage: 'extract', progress: 1.0, total: 108630372, timestamp: Date.now() },
        { stage: 'switch', progress: 1.0, total: 108630372, timestamp: Date.now() },
      ];

      intercept('/api/system/updates/progress', {
        type: 'sse',
        events: progressEvents.map(e => `data: ${JSON.stringify(e)}\n\n`),
      });

      // Open update dialog
      await page.click('button.update-nav');
      await page.waitForSelector('.update-dialog');

      // Wait for download progress to appear
      await page.waitForSelector('.download-progress', { timeout: 5000 });

      // Verify progress message
      const message = await page.textContent('.download-progress-message');
      assert(message.includes('正在下载更新包') || message.includes('正在校验完整性'));

      // Verify speed display appears
      const speed = await page.textContent('.download-progress-speed');
      assert(speed, 'Speed should be displayed');
      assert(speed.includes('MB/s') || speed.includes('KB/s'), 'Speed should have units');

      // Verify progress bar
      const barFill = await page.waitForSelector('.download-progress-bar-fill');
      const width = await barFill.evaluate(el => getComputedStyle(el).width);
      const widthPx = parseFloat(width);
      assert(widthPx > 0, 'Progress bar should have positive width');

      // Verify percentage display
      const percent = await page.textContent('.download-progress-percent');
      assert(percent, 'Percentage should be displayed');
      assert(/\d+%/.test(percent), 'Percentage should be a number with %');

      // Verify ETA display
      const eta = await page.textContent('.download-progress-eta');
      assert(eta, 'ETA should be displayed');
      assert(eta.includes('剩余约'), 'ETA should have label');
    },
  },

  {
    name: 'progress bar animates smoothly through stages',
    async run({ page, intercept }) {
      intercept('/api/system/updates/status', {
        type: 'json',
        body: {
          enabled: true,
          job: {
            id: 'job-002',
            status: 'running',
            startedAt: new Date().toISOString(),
            finishedAt: null,
            activeModule: 'monitor',
            steps: [{ id: 's1', name: '下载部署包', status: 'running' }],
            message: '',
          },
          modules: [],
        },
      });

      const stages = [
        { stage: 'preflight', progress: 0.5 },
        { stage: 'preflight', progress: 1.0 },
        { stage: 'download', progress: 0.3 },
        { stage: 'download', progress: 0.7 },
        { stage: 'verify', progress: 0.5 },
        { stage: 'extract', progress: 1.0 },
      ];

      intercept('/api/system/updates/progress', {
        type: 'sse',
        events: stages.map(s => `data: ${JSON.stringify({ ...s, timestamp: Date.now() })}\n\n`),
        interval: 200, // 200ms between events
      });

      await page.click('button.update-nav');
      await page.waitForSelector('.download-progress');

      // Collect progress bar widths over time
      const widths = [];
      for (let i = 0; i < 5; i++) {
        await page.waitForTimeout(250);
        const width = await page.evaluate(() => {
          const fill = document.querySelector('.download-progress-bar-fill');
          return fill ? parseFloat(getComputedStyle(fill).width) : 0;
        });
        widths.push(width);
      }

      // Progress should generally increase (allowing some variance for stages)
      const increasing = widths.some((w, i) => i > 0 && w > widths[i - 1]);
      assert(increasing, 'Progress bar should show increasing width');

      // Verify messages change between stages
      await page.waitForTimeout(300);
      const finalMessage = await page.textContent('.download-progress-message');
      assert(finalMessage, 'Stage message should be present');
    },
  },

  {
    name: 'handles progress errors gracefully',
    async run({ page, intercept }) {
      intercept('/api/system/updates/status', {
        type: 'json',
        body: {
          enabled: true,
          job: {
            id: 'job-003',
            status: 'running',
            startedAt: new Date().toISOString(),
            finishedAt: null,
            activeModule: 'crossex',
            steps: [{ id: 's1', name: '下载部署包', status: 'running' }],
            message: '',
          },
          modules: [],
        },
      });

      intercept('/api/system/updates/progress', {
        type: 'sse',
        events: [
          `data: ${JSON.stringify({ stage: 'download', progress: 0.3, timestamp: Date.now() })}\n\n`,
          `data: ${JSON.stringify({ stage: 'download', progress: 0.5, error: 'Network error: Connection timeout', timestamp: Date.now() })}\n\n`,
        ],
      });

      await page.click('button.update-nav');
      await page.waitForSelector('.download-progress');

      // Progress should appear initially
      let progressVisible = await page.isVisible('.download-progress');
      assert(progressVisible, 'Progress should be visible initially');

      // Wait for error event
      await page.waitForTimeout(300);

      // Progress bar should disappear on error
      await page.waitForTimeout(500);
      progressVisible = await page.isVisible('.download-progress');
      assert(!progressVisible, 'Progress should be hidden after error');
    },
  },

  {
    name: 'closes SSE connection when dialog closes',
    async run({ page, intercept }) {
      let sseConnectionOpen = false;

      intercept('/api/system/updates/status', {
        type: 'json',
        body: {
          enabled: true,
          job: {
            id: 'job-004',
            status: 'running',
            startedAt: new Date().toISOString(),
            finishedAt: null,
            activeModule: 'asset',
            steps: [{ id: 's1', name: '下载部署包', status: 'running' }],
            message: '',
          },
          modules: [],
        },
      });

      intercept('/api/system/updates/progress', {
        type: 'sse',
        events: [
          `data: ${JSON.stringify({ stage: 'download', progress: 0.4, timestamp: Date.now() })}\n\n`,
        ],
        onConnect: () => { sseConnectionOpen = true; },
        onDisconnect: () => { sseConnectionOpen = false; },
      });

      // Open dialog
      await page.click('button.update-nav');
      await page.waitForSelector('.download-progress');
      await page.waitForTimeout(200);

      assert(sseConnectionOpen, 'SSE connection should be open');

      // Close dialog
      await page.click('.update-dialog button[aria-label*="关闭"]');
      await page.waitForTimeout(200);

      assert(!sseConnectionOpen, 'SSE connection should be closed');
    },
  },

  {
    name: 'no progress bar when job is not running',
    async run({ page, intercept }) {
      intercept('/api/system/updates/status', {
        type: 'json',
        body: {
          enabled: true,
          checking: false,
          job: {
            id: 'job-005',
            status: 'succeeded',
            startedAt: new Date(Date.now() - 300000).toISOString(),
            finishedAt: new Date().toISOString(),
            activeModule: null,
            steps: [
              { id: 's1', name: '准备更新', status: 'succeeded' },
              { id: 's2', name: '下载部署包', status: 'succeeded' },
            ],
            message: '更新成功',
          },
          modules: [],
        },
      });

      await page.click('button.update-nav');
      await page.waitForSelector('.update-dialog');

      // Progress bar should not appear for completed job
      const progressExists = await page.isVisible('.download-progress');
      assert(!progressExists, 'Progress bar should not appear for completed jobs');

      // Job progress section should still appear
      const jobProgressExists = await page.isVisible('.update-progress');
      assert(jobProgressExists, 'Job progress section should be visible');
    },
  },

  {
    name: 'formats speed units correctly',
    async run({ page, intercept }) {
      intercept('/api/system/updates/status', {
        type: 'json',
        body: {
          enabled: true,
          job: {
            id: 'job-006',
            status: 'running',
            startedAt: new Date().toISOString(),
            finishedAt: null,
            activeModule: 'greeks',
            steps: [{ id: 's1', name: '下载部署包', status: 'running' }],
            message: '',
          },
          modules: [],
        },
      });

      // Test different speed magnitudes
      const testCases = [
        { speed: 512, expected: 'B/s' },           // Bytes
        { speed: 1536, expected: 'KB/s' },         // 1.5 KB/s
        { speed: 2560000, expected: 'MB/s' },      // 2.4 MB/s
      ];

      for (const testCase of testCases) {
        intercept('/api/system/updates/progress', {
          type: 'sse',
          events: [
            `data: ${JSON.stringify({
              stage: 'download',
              progress: 0.5,
              speed: testCase.speed,
              timestamp: Date.now()
            })}\n\n`,
          ],
        });

        await page.click('button.update-nav');
        await page.waitForSelector('.download-progress-speed');

        const speed = await page.textContent('.download-progress-speed');
        assert(speed.includes(testCase.expected), `Speed should use ${testCase.expected} for ${testCase.speed} bytes/sec, got: ${speed}`);

        // Close and reopen for next test
        await page.click('.update-dialog button[aria-label*="关闭"]');
        await page.waitForTimeout(100);
      }
    },
  },
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}
