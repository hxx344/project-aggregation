import { readFile, stat } from 'node:fs/promises';
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
