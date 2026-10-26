import { readFile, stat } from 'node:fs/promises';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzip as gzipCallback } from 'node:zlib';
import { promisify } from 'node:util';

const gzip = promisify(gzipCallback);
export function acceptsGzip(header = '') {
  const values = new Map(String(header).toLowerCase().split(',').map(part => {
    const [name, ...parameters] = part.trim().split(';');
    const q = parameters.find(value => value.trim().startsWith('q='));
    return [name, q ? Number(q.trim().slice(2)) : 1];
  }));
  return (values.get('gzip') ?? values.get('*') ?? 0) > 0;
}

// Only public workbench files enter this cache; API and proxy responses never do.
export function createStaticResponder({ maxBytes = 16 * 1024 * 1024 } = {}) {
  const cache = new Map(), pending = new Map();
  let bytes = 0;
  async function representation(filename) {
    const info = await stat(filename);
    const version = `${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
    const existing = cache.get(filename);
    if (existing?.version === version) { cache.delete(filename); cache.set(filename, existing); return existing; }
    const key = `${filename}\0${version}`;
    if (pending.has(key)) return pending.get(key);
    const task = (async () => {
      const body = await readFile(filename);
      const compressed = body.length >= 1024 && /\.(?:html|js|css|svg|json|txt)$/.test(filename) ? await gzip(body) : null;
      const zipped = compressed && compressed.length < body.length ? compressed : null;
      const result = { version, body, zipped, etag: `W/"${createHash('sha256').update(body).digest('base64url')}"`, size: body.length + (zipped?.length || 0) };
      const old = cache.get(filename); if (old) { bytes -= old.size; cache.delete(filename); }
      if (result.size <= maxBytes) {
        while (cache.size && bytes + result.size > maxBytes) { const first = cache.keys().next().value; bytes -= cache.get(first).size; cache.delete(first); }
        cache.set(filename, result); bytes += result.size;
      }
      return result;
    })().finally(() => pending.delete(key));
    pending.set(key, task); return task;
  }
  return async (req, res, filename, headers) => {
    const item = await representation(filename);
    const zipped = item.zipped && acceptsGzip(req.headers['accept-encoding']);
    const body = zipped ? item.zipped : item.body;
    const responseHeaders = { ...headers, Vary: 'Accept-Encoding', ETag: item.etag, ...(zipped ? { 'Content-Encoding': 'gzip' } : {}) };
    const matches = String(req.headers['if-none-match'] || '').split(',').map(value => value.trim().replace(/^W\//, ''));
    if (matches.includes('*') || matches.includes(item.etag.replace(/^W\//, ''))) { res.writeHead(304, responseHeaders); res.end(); return; }
    res.writeHead(200, { ...responseHeaders, 'Content-Length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
}

// An installed release lives in `<APP_DIR>/releases/<commit>-<key>`, next to the
// `current` and `previous` links. A hashed Vite asset missing from this release's
// dist/ may still be wanted by a page another release served (one opened before
// an update, or an index.html from the other API slot); the same name is the same
// content, so it is looked up in those two releases only. Outside that layout
// nothing is looked up. Returns the file's real path or null.
const RELEASE_NAME = /^[a-f0-9]{12}-[a-f0-9]{16}$/;
export function createReleaseAssetLookup(distDir) {
  const release = path.dirname(path.resolve(distDir)), releases = path.dirname(release);
  if (path.basename(releases) !== 'releases' || !RELEASE_NAME.test(path.basename(release))) return () => null;
  const appDir = path.dirname(releases);
  return name => {
    if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(name)) return null;
    for (const link of ['current', 'previous']) {
      try {
        const target = realpathSync(path.join(appDir, link));
        if (target === release || path.dirname(target) !== releases || !RELEASE_NAME.test(path.basename(target))) continue;
        const file = path.join(target, 'dist', 'assets', name);
        // No link inside the other release is followed either.
        if (lstatSync(file).isFile() && realpathSync(file) === file) return file;
      } catch {}
    }
    return null;
  };
}
