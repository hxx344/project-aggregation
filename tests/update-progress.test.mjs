import test from 'node:test';
import assert from 'node:assert/strict';
import { getUpdateProgress } from '../src/update-progress.ts';

const startedAt = '2026-10-15T08:00:00.000Z';
const timestamp = Date.parse(startedAt) + 1000;
const progress = (changes = {}) => ({ stage: 'download', progress: 0.25, downloaded: 256, total: 1024, speed: 1536, eta: 21, timestamp, ...changes });
const job = (data, changes = {}) => ({ id: 'update-1', status: 'running', startedAt, finishedAt: null, activeModule: 'workbench', steps: [], message: '', progress: data, ...changes });

test('shows measured stage progress and download units without estimating total completion', () => {
  const view = getUpdateProgress(job(progress()));
  assert.equal(view.stageProgress, 0.25);
  assert.equal(view.speed, '1.5 KiB/s');
  assert.equal(view.downloaded, '256.0 B');
  assert.equal(view.total, '1.0 KiB');
  assert.equal(view.eta, '21秒');
  assert.equal('overall' in view, false);
  assert.equal(getUpdateProgress(job(progress({ progress: 0, speed: 0, eta: 0 }))).stageProgress, 0);
  assert.equal(getUpdateProgress(job(progress({ eta: 0 }))).eta, '不足1秒');
  assert.equal(getUpdateProgress(job(progress({ speed: 2 * 1024 ** 2, eta: 61 }))).speed, '2.0 MiB/s');
  assert.equal(getUpdateProgress(job(progress({ eta: 61 }))).eta, '2分钟');
});

test('unmeasurable source-install stages show a phase without a fabricated percentage', () => {
  for (const stage of ['preflight', 'download', 'prepare', 'build', 'verify', 'extract', 'switch', 'finalize']) {
    const view = getUpdateProgress(job({ stage, timestamp }));
    assert.equal(view.stage, stage);
    assert.ok(view.message);
    assert.equal(view.stageProgress, undefined);
    assert.equal(view.speed, undefined);
    assert.equal(view.downloaded, undefined);
    assert.equal(view.total, undefined);
    assert.equal(view.eta, undefined);
  }
  const view = getUpdateProgress(job(progress({ stage: 'verify', progress: 1 })));
  assert.equal(view.stageProgress, 1);
  assert.equal(view.speed, undefined);
  assert.equal(view.downloaded, undefined);
  assert.equal(view.total, undefined);
  assert.equal(view.eta, undefined);
});

test('source receive percentage counts objects and unknown byte totals suppress ETA', () => {
  const view = getUpdateProgress(job(progress({ detail: 'source-receive', downloaded: 2 * 1024 ** 2, total: undefined })));
  assert.equal(view.stageProgress, 0.25);
  assert.equal(view.progressLabel, '对象接收');
  assert.equal(view.message, '正在接收源码对象…');
  assert.equal(view.downloaded, '2.0 MiB');
  assert.equal(view.speed, '1.5 KiB/s');
  assert.equal(view.total, undefined);
  assert.equal(view.eta, undefined);
  assert.match(view.description, /对象接收数量/);
  const sourceWithTotal = getUpdateProgress(job(progress({ detail: 'source-receive' })));
  assert.equal(sourceWithTotal.total, undefined);
  assert.equal(sourceWithTotal.eta, undefined);
  const unknownTotal = getUpdateProgress(job(progress({ total: undefined })));
  assert.equal(unknownTotal.downloaded, '256.0 B');
  assert.equal(unknownTotal.speed, '1.5 KiB/s');
  assert.equal(unknownTotal.total, undefined);
  assert.equal(unknownTotal.eta, undefined);
});

test('recognized details stay within their stage and retries clear transfer statistics', () => {
  const details = {
    prepare: ['source-resolve', 'dependencies', 'runtime'],
    build: ['build-workbench', 'build-monitor', 'build-asset', 'build-crossex', 'build-aster'],
    verify: ['typecheck', 'tests'],
    finalize: ['healthcheck', 'updater'],
  };
  for (const [stage, values] of Object.entries(details)) {
    const generic = getUpdateProgress(job({ stage, timestamp }));
    for (const detail of values) {
      const view = getUpdateProgress(job({ stage, detail, timestamp }));
      assert.notEqual(view.message, generic.message, detail);
      assert.ok(view.description);
      assert.equal(view.stageProgress, undefined);
    }
  }
  const generic = getUpdateProgress(job(progress()));
  for (const detail of ['build-workbench', 'unknown', '__proto__', 'constructor', '<script>', null, {}, 1]) {
    assert.equal(getUpdateProgress(job(progress({ detail }))).message, generic.message);
  }
  const retry = getUpdateProgress(job(progress({ detail: 'source-retry', progress: undefined })));
  assert.equal(retry.message, '正在重试源码下载…');
  for (const field of ['downloaded', 'total', 'speed', 'eta', 'stageProgress']) assert.equal(retry[field], undefined);
});

test('absent, terminal and replaced tasks cannot retain the preceding progress', () => {
  assert.equal(getUpdateProgress(null), null);
  assert.equal(getUpdateProgress(undefined), null);
  assert.equal(getUpdateProgress(job(undefined)), null);
  for (const status of ['succeeded', 'failed', 'interrupted']) assert.equal(getUpdateProgress(job(progress(), { status })), null);
  assert.equal(getUpdateProgress(job(progress(), { id: 'update-2', startedAt: new Date(timestamp + 1000).toISOString() })), null);
  assert.equal(getUpdateProgress(job(progress(), { startedAt: 'invalid' })), null);
  assert.equal(getUpdateProgress(job(progress({ timestamp: Date.parse(startedAt) }))).stageProgress, 0.25);
});

test('rejects malformed progress instead of showing NaN or accepting unknown stages', () => {
  for (const value of [null, undefined, [], 1, 'download', {}]) assert.equal(getUpdateProgress(job(value)), null);
  for (const stage of ['', 'unknown', '__proto__', 'constructor', null, 1]) assert.equal(getUpdateProgress(job(progress({ stage }))), null);
  for (const value of [-1, 1.1, NaN, Infinity, '0.5', null, false]) assert.equal(getUpdateProgress(job(progress({ progress: value }))), null);
  for (const value of [0, -1, NaN, Infinity, timestamp + 0.5, '1', null]) assert.equal(getUpdateProgress(job(progress({ timestamp: value }))), null);
  assert.equal(getUpdateProgress(job(progress({ error: 'download failed' }))), null);
});

test('rejects inconsistent byte counts and invalid rates or durations', () => {
  for (const field of ['downloaded', 'total', 'speed', 'eta']) {
    for (const value of [-1, NaN, Infinity, '10', null, false]) {
      assert.equal(getUpdateProgress(job(progress({ [field]: value }))), null, `${field}: ${value}`);
    }
  }
  for (const patch of [{ downloaded: 1.5 }, { total: 1.5 }, { total: 0 }, { downloaded: 1025 }, { total: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.equal(getUpdateProgress(job(progress(patch))), null);
  }
});
