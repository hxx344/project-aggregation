import { acceptsGzip } from './static-response.mjs';
import { cachePolicy } from './static-cache.mjs';

// Negotiate only public build assets. Never transform HTML, API responses or
// session-dependent content, and never buffer a proxied response in memory.
export function prepareAssetCompression(req, incoming, headers) {
  const source = incoming.headers;
  if (!['GET', 'HEAD'].includes(req.method) ||
      cachePolicy(req.url, source, incoming.statusCode) === 'no-store' ||
      req.headers.range || req.headers['if-range'] || source['content-range'] ||
      source['content-encoding'] ||
      /(?:^|,)\s*no-transform\s*(?:,|$)/i.test(source['cache-control'] || '') ||
      (source['content-length'] !== undefined && Number(source['content-length']) < 1024)) return false;

  const vary = String(headers.vary || '').split(',').map(value => value.trim()).filter(Boolean);
  if (!vary.some(value => ['*', 'accept-encoding'].includes(value.toLowerCase()))) vary.push('Accept-Encoding');
  headers.vary = vary.join(', ');
  if (!acceptsGzip(req.headers['accept-encoding'])) return false;

  headers['content-encoding'] = 'gzip';
  for (const name of ['content-length', 'accept-ranges', 'content-md5', 'digest', 'content-digest', 'repr-digest']) delete headers[name];
  if (typeof headers.etag === 'string' && headers.etag.startsWith('"')) headers.etag = `W/${headers.etag}`;
  return true;
}
