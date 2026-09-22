// Only explicitly public, immutable build files can outlive a portal grant.
// HTML, API and session responses remain private and uncached.
export function cachePolicy(path, headers, status = 200) {
  const pathname = path.split('?')[0];
  const vite = /^\/assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(?:js|css)$/.test(pathname);
  const next = /^\/_next\/static\/(?:chunks|css)\/[A-Za-z0-9_./-]*[a-f0-9]{8,}[A-Za-z0-9_.-]*\.(?:js|css)$/.test(pathname);
  const control = String(headers['cache-control'] || '');
  const type = String(headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const rightType = pathname.endsWith('.css') ? type === 'text/css' : ['application/javascript', 'text/javascript'].includes(type);
  if (status === 200 && (vite || next) && rightType && !headers['set-cookie'] && !headers.location && /(?:^|,)\s*public\s*(?:,|$)/i.test(control) && /(?:^|,)\s*immutable\s*(?:,|$)/i.test(control) && !/no-store|no-cache|private/i.test(control)) return 'private, max-age=31536000, immutable';
  return 'no-store';
}
