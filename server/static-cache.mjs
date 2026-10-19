// Immutable build code may outlive a grant, never HTML, API or session data.
// Registered embedded transports also label their build files private; retain
// those only in the browser cache, without trusting arbitrary project servers.
export function cachePolicy(path, headers, status = 200, trustedBuildAssets = false) {
  const pathname = path.split('?')[0];
  const vite = /^\/assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(?:js|css)$/.test(pathname);
  const next = /^\/_next\/static\/(?:chunks|css)\/[A-Za-z0-9_./-]*(?:[a-f0-9]{8,}|[-.][A-Za-z0-9_-]{8,})\.(?:js|css)$/.test(pathname);
  const control = String(headers['cache-control'] || '');
  const type = String(headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const rightType = pathname.endsWith('.css') ? type === 'text/css' : ['application/javascript', 'text/javascript'].includes(type);
  const privateBuild = /(?:^|,)\s*private\s*(?:,|$)/i.test(control);
  const declaredBuild = privateBuild ? trustedBuildAssets : /(?:^|,)\s*public\s*(?:,|$)/i.test(control);
  if (status === 200 && (vite || next) && rightType && !headers['set-cookie'] && !headers.location && declaredBuild && /(?:^|,)\s*immutable\s*(?:,|$)/i.test(control) && !/no-store|no-cache/i.test(control)) return 'private, max-age=31536000, immutable';
  return 'no-store';
}
