import test from 'node:test';
import assert from 'node:assert/strict';
import { canPreload, emptyWorkspacePlan, planWorkspace, projectKey } from '../src/hub-state.ts';

const projects = ['aster', 'monitor', 'asset', 'crossex'].map(id => ({ id, adapter: id === 'crossex' ? 'standard' : id, enabled: true, accessMode: 'proxy', apiUrl: 'http://127.0.0.1:9000', revision: 'one' }));
const keys = projects.map(projectKey);
const finish = (state, key, phase = 'ready') => ({ ...state, frames: state.frames.map(frame => frame.key === key ? { ...frame, phase } : frame) });
const reconcile = (state, active = null, hint = null, allowed = true, list = projects) => planWorkspace(state, list, active, hint, allowed);

test('idle warmup starts one module at a time and retains all four without moving their documents', () => {
  let state = reconcile(emptyWorkspacePlan(), null, null, false); assert.deepEqual(state.frames, []);
  for (const key of keys) {
    state = reconcile(state); assert.deepEqual(state.frames.filter(frame => frame.phase === 'loading').map(frame => frame.key), [key]);
    state = finish(state, key);
  }
  const order = state.frames.map(frame => frame.key);
  for (const id of ['crossex', 'aster', 'asset', 'monitor', 'crossex']) {
    state = reconcile(state, id); assert.deepEqual(state.frames.map(frame => frame.key), order); assert.equal(state.frames.length, 4);
  }
  state = reconcile(state, null, null, true, [...projects].reverse()); assert.deepEqual(state.frames.map(frame => frame.key), order);
});

test('explicit selection bypasses a slow preload; intent reorders only work that has not started', () => {
  let state = reconcile(emptyWorkspacePlan());
  state = reconcile(state, null, 'asset'); assert.deepEqual(state.frames.map(frame => frame.key), [keys[0]]);
  state = reconcile(state, 'crossex', 'asset'); assert.deepEqual(state.frames.map(frame => frame.key), [keys[0], keys[3]]);
  state = reconcile(finish(state, keys[0]), 'crossex', 'asset'); assert.equal(state.frames.length, 2);
  state = reconcile(finish(state, keys[3]), 'crossex', 'asset'); assert.equal(state.frames.at(-1).key, keys[2]);
});

test('fast switching bounds unfinished work to the active module plus one background load', () => {
  let state = reconcile(emptyWorkspacePlan());
  for (const id of ['monitor', 'asset', 'crossex', 'aster', 'monitor']) {
    state = reconcile(state, id);
    assert.ok(state.frames.filter(frame => frame.phase === 'loading').length <= 2);
    assert.ok(state.frames.some(frame => frame.key === projectKey(projects.find(project => project.id === id))));
  }
});

test('failed or incompatible preload frees the queue and is not retried until explicit selection or a new revision', () => {
  let state = reconcile(emptyWorkspacePlan());
  state = reconcile(finish(state, keys[0], 'failed')); assert.deepEqual(state.frames.map(frame => frame.key), [keys[1]]);
  state = reconcile(finish(state, keys[1], 'unsupported')); assert.deepEqual(state.frames.map(frame => frame.key), [keys[2]]);
  state = reconcile(finish(state, keys[2])); state = reconcile(finish(state, keys[3]));
  for (let i = 0; i < 10; i++) state = reconcile(state);
  assert.deepEqual(state.frames.map(frame => frame.key), [keys[2], keys[3]]);
  state = reconcile(state, 'aster'); assert.equal(state.frames.at(-1).key, keys[0]); assert.equal(state.frames.at(-1).phase, 'loading');
});

test('hidden or offline workbench starts no automatic work, while returning resumes the queue', () => {
  let state = reconcile(emptyWorkspacePlan(), null, null, false); assert.equal(state.frames.length, 0);
  state = reconcile(state); state = reconcile(finish(state, keys[0]), null, null, false); assert.equal(state.frames.length, 1);
  state = reconcile(state); assert.equal(state.frames.at(-1).key, keys[1]);
});

test('configuration revision, disable and removal revoke cached frames and old attempts', () => {
  let state = reconcile(emptyWorkspacePlan()); state = reconcile(finish(state, keys[0])); state = reconcile(finish(state, keys[1]));
  const changed = [{ ...projects[0], revision: 'two' }, { ...projects[1], enabled: false }, projects[3]];
  state = reconcile(state, null, null, true, changed);
  assert.deepEqual(state.frames.map(frame => frame.key), ['aster:two']); assert.ok(!state.attempted.includes(keys[0])); assert.ok(!state.attempted.includes(keys[2]));
});

test('unknown, external and differently configured modules are not opened speculatively', () => {
  const list = [{ ...projects[0], id: 'custom' }, { ...projects[1], accessMode: 'direct' }, { ...projects[2], enabled: false }, { ...projects[3], adapter: 'link' }];
  for (const project of list) assert.equal(canPreload(project), false);
  assert.deepEqual(reconcile(emptyWorkspacePlan(), null, 'custom', true, list).frames, []);
  assert.equal(reconcile(emptyWorkspacePlan(), 'custom', null, true, list).frames[0].key, 'custom:one');
});
