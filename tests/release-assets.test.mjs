import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApiServer } from '../server/api/server.mjs';
import { openHubDatabase } from '../server/control/schema.mjs';
import { createControlStore } from '../server/control/store.mjs';
import { createProjectCatalog } from '../server/control/projects.mjs';

const directoryLink = (target, link) => symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
const releaseName = digit => `${digit.repeat(12)}-${digit.repeat(16)}`;

// Real API handlers and HTTP responses; only the unrelated runtime is scripted.
async function fixture(t) {
  const appDir = await mkdtemp(path.join(os.tmpdir(), 'hub-release-assets-'));
  const apis = [], databases = [];
  t.after(async () => {
    await Promise.all(apis.map(api => api.close()));
    for (const db of databases) db.close();
    await rm(appDir, { recursive: true, force: true });
  });
  await mkdir(path.join(appDir, 'slots'), { recursive: true });
  const stage = async (digit, tag, base = path.join(appDir, 'releases')) => {
    const release = path.join(base, releaseName(digit));
    await mkdir(path.join(release, 'dist', 'assets'), { recursive: true });
    await writeFile(path.join(release, 'dist', 'index.html'), `<title>${tag}</title><script src="/assets/app-${tag}.js"></script>`);
    await writeFile(path.join(release, 'dist', 'assets', `app-${tag}.js`), `document.title = '${tag}';`);
    return release;
  };
  const link = async (name, target) => {
    const filename = path.join(appDir, name);
    await rm(filename, { force: true });
    await directoryLink(target, filename);
  };
  const start = async release => {
    const db = openHubDatabase(path.join(appDir, `api-${apis.length}.sqlite`)); databases.push(db);
    const control = createControlStore(db), decrypt = () => null;
    const api = createApiServer({ control, catalog: createProjectCatalog({ control, embeddedModules: false, decrypt }),
      encrypt: value => value, decrypt, embeddedModules: false, supervisor: {},
      runtime: { reportApiStats: async () => ({}), subscribeOverview: () => () => {} },
      executionJobs: { state: () => ({ jobs: [] }), openEntries: () => 0, transaction: fn => fn() },
      updatesClient: {}, secureCookies: false, configuredOrigin: '', distDir: path.join(release, 'dist'),
      log: { info() {}, debug() {}, warn() {}, error() {} } });
    apis.push(api); await api.initialize();
    await new Promise(resolve => api.server.listen(0, '127.0.0.1', resolve));
    const port = api.server.address().port;
    return route => new Promise((resolve, reject) => {
      const req = http.get({ hostname: '127.0.0.1', port, path: route, agent: false, timeout: 3000,
        headers: { Host: `hub.localhost:${port}` } }, res => {
        let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
        res.on('error', reject); res.on('end', () => resolve([res.statusCode, body]));
      });
      req.on('timeout', () => req.destroy(new Error('HTTP asset request timed out'))); req.on('error', reject);
    });
  };
  return { appDir, stage, link, start };
}

const script = page => {
  const match = page[1].match(/src="(\/assets\/[^"/]+\.js)"/);
  assert.ok(match, 'the served page names its release asset');
  return match[1];
};
const asset = tag => [200, `document.title = '${tag}';`];

test('a delayed page asset survives cutover before previous moves to the old serving release', async t => {
  const f = await fixture(t);
  const old = await f.stage('1', 'old'), next = await f.stage('2', 'next'), previous = await f.stage('3', 'previous');
  await f.link('current', old); await f.link('previous', previous);
  await f.link('slots/a', old); await f.link('slots/b', next);
  const oldApi = await f.start(old), nextApi = await f.start(next);
  const oldPage = await oldApi('/'); assert.equal(oldPage[0], 200);
  await f.link('current', next);
  assert.deepEqual(await nextApi(script(oldPage)), asset('old'));
  assert.deepEqual(await oldApi('/assets/app-next.js'), asset('next'));
  await f.link('previous', old);
  assert.deepEqual(await nextApi(script(oldPage)), asset('old'));
  assert.equal((await nextApi('/api/health'))[0], 200);
});

test('a page opened on the new slot can load its delayed asset after rollback', async t => {
  const f = await fixture(t);
  const old = await f.stage('1', 'old'), next = await f.stage('2', 'next'), previous = await f.stage('3', 'previous');
  await f.link('current', next); await f.link('previous', previous);
  await f.link('slots/a', old); await f.link('slots/b', next);
  const oldApi = await f.start(old), nextApi = await f.start(next);
  const nextPage = await nextApi('/'); assert.equal(nextPage[0], 200);
  await f.link('current', old);
  assert.deepEqual(await oldApi(script(nextPage)), asset('next'));
  await rm(path.join(f.appDir, 'slots', 'b'));
  assert.equal((await oldApi(script(nextPage)))[0], 404, 'removed slot links are not cached');
  assert.equal((await oldApi('/api/health'))[0], 200);
});

test('only named release links expose single files from their real dist/assets directories', async t => {
  const f = await fixture(t), own = await f.stage('0', 'own');
  for (const [name, digit, tag] of [['current', '1', 'current'], ['previous', '2', 'previous'], ['slots/a', '3', 'slot-a'], ['slots/b', '4', 'slot-b']]) {
    await f.link(name, await f.stage(digit, tag));
  }
  await f.stage('5', 'stray');
  const read = await f.start(own);
  for (const tag of ['current', 'previous', 'slot-a', 'slot-b']) assert.deepEqual(await read(`/assets/app-${tag}.js`), asset(tag));
  for (const route of ['/assets/app-stray.js', '/assets/..%2Freleases%2Fapp.js', '/assets/..%5Creleases%5Capp.js', '/assets/%2Fapp-current.js', '/app-current.js']) {
    assert.equal((await read(route))[0], 404, route);
  }
  assert.deepEqual(await read('/settings'), await read('/'));
});

test('every fallback link rejects external and malformed release targets', async t => {
  const f = await fixture(t), own = await f.stage('0', 'own');
  const external = await f.stage('1', 'external', path.join(f.appDir, 'outside', 'releases'));
  const malformed = path.join(f.appDir, 'releases', 'not-a-release');
  await mkdir(path.join(malformed, 'dist', 'assets'), { recursive: true });
  await writeFile(path.join(malformed, 'dist', 'assets', 'app-malformed.js'), 'malformed');
  const alias = path.join(f.appDir, 'releases', releaseName('2'));
  await directoryLink(external, alias);
  const read = await f.start(own);
  for (const name of ['current', 'previous', 'slots/a', 'slots/b']) {
    for (const target of [external, alias, malformed]) {
      await f.link(name, target);
      assert.equal((await read('/assets/app-external.js'))[0], 404, `${name}: ${target}`);
      assert.equal((await read('/assets/app-malformed.js'))[0], 404, `${name}: malformed release`);
    }
    await rm(path.join(f.appDir, name));
  }
});

test('internal directory links never expose fallback assets', async t => {
  const f = await fixture(t), own = await f.stage('0', 'own'), other = await f.stage('1', 'other'), stray = await f.stage('2', 'stray');
  await rm(path.join(other, 'dist', 'assets'), { recursive: true });
  await directoryLink(path.join(stray, 'dist', 'assets'), path.join(other, 'dist', 'assets'));
  await f.link('slots/a', other);
  const read = await f.start(own);
  assert.equal((await read('/assets/app-stray.js'))[0], 404);
});

test('internal file symlinks never expose fallback assets', async t => {
  const f = await fixture(t), own = await f.stage('0', 'own'), other = await f.stage('1', 'other'), stray = await f.stage('2', 'stray');
  try { await symlink(path.join(stray, 'dist', 'assets', 'app-stray.js'), path.join(other, 'dist', 'assets', 'linked.js'), 'file'); }
  catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Windows does not permit file symlinks; directory-link rejection is covered separately'); return; }
    throw error;
  }
  await f.link('slots/b', other);
  const read = await f.start(own);
  assert.equal((await read('/assets/linked.js'))[0], 404);
});
