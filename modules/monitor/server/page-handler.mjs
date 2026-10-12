import { readFile, readdir, realpath } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { extname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { readInitialMarket } from './initial-market.mjs';
import { pageProps } from '../web/page-props.ts';

const compress = promisify(gzip);
const mime = {
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

export function serializePageProps(props) {
  return JSON.stringify(props).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function pageHtml(template, markup, props) {
  const preload = props.initialMonitor === 'oil'
    ? '<link rel="preload" href="/oil/panel.html" as="fetch" crossorigin="anonymous"><link rel="preload" href="/oil/styles.css" as="fetch" crossorigin="anonymous">'
    : props.initialMonitor === 'cl-xau' ? '<link rel="preload" href="/oil/styles.css" as="style">' : '';
  const values = { '<!--ssr-outlet-->': markup, '<!--ssr-props-->': serializePageProps(props), '<!--ssr-preload-->': preload };
  for (const marker of Object.keys(values)) if (template.split(marker).length !== 2) throw new Error(`Invalid page template: ${marker}`);
  // One pass prevents text inside rendered content or JSON from being treated
  // as a second template directive. Callback replacement preserves literal $.
  return template.replace(/<!--ssr-(?:outlet|props|preload)-->/g, marker => values[marker]);
}

function pathname(request, development) {
  const path = decodeURIComponent(request.url.split('?')[0]);
  const parts = path.split('/');
  if (!path.startsWith('/') || path.includes('\\') || [...path].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || parts.some((part, index) =>
    part.startsWith('.') && !(development && index === 2 && part === '.vite' && parts[1] === 'node_modules' && parts[3] === 'deps'))) return null;
  return path;
}

function gzipAccepted(request) {
  return (request.headers['accept-encoding'] ?? '').split(',').some(part => {
    const [name, ...parameters] = part.trim().split(';');
    return name.toLowerCase() === 'gzip' && !parameters.some(value => /^\s*q\s*=\s*0(?:\.0*)?\s*$/i.test(value));
  });
}

async function send(request, response, body, contentType, cacheControl, compressed) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const zipped = buffer.length > 1024 && gzipAccepted(request);
  const data = zipped ? await (compressed?.() ?? compress(buffer, { level: 4 })) : buffer;
  if (response.destroyed) return;
  response.writeHead(200, {
    'Content-Type': contentType, 'Content-Length': data.length, 'Cache-Control': cacheControl,
    'Vary': 'Accept-Encoding', 'X-Content-Type-Options': 'nosniff', ...(zipped ? { 'Content-Encoding': 'gzip' } : {}),
  });
  response.end(request.method === 'HEAD' ? undefined : data);
}

function errorResponse(response, status) {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...(status === 405 ? { Allow: 'GET, HEAD' } : {}) });
  response.end(status === 404 ? 'Not found' : status === 405 ? 'Method not allowed' : 'Invalid request');
}

export async function createPageHandler({ services, root = process.cwd(), development = false, authorize }) {
  root = resolve(root);
  let vite, template, render, handleUpgrade;
  const assets = new Map();
  if (development) {
    if (typeof authorize !== 'function') throw new Error('Development HMR requires application authorization');
    const { createServer } = await import('vite');
    // This server only receives authenticated upgrade events and never listens.
    // Sharing the application port avoids a separate unauthenticated HMR port.
    const upgrades = createHttpServer();
    vite = await createServer({ root, configLoader: 'runner', server: { middlewareMode: true, hmr: { server: upgrades } }, appType: 'custom' });
    handleUpgrade = (request, socket, head) => {
      const reject = status => {
        socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n${status.startsWith('401') ? 'WWW-Authenticate: Basic realm="Market Monitor", charset="UTF-8"\r\n' : ''}\r\n`);
        socket.destroySoon();
      };
      if (!authorize(request)) return reject('401 Unauthorized');
      let path;
      try { path = new URL(request.url, 'http://localhost').pathname; } catch { return reject('400 Bad Request'); }
      if (path !== '/' || !['vite-hmr', 'vite-ping'].includes(request.headers['sec-websocket-protocol'])) return reject('404 Not Found');
      upgrades.emit('upgrade', request, socket, head);
    };
  } else {
    const clientRoot = join(root, 'dist/client');
    template = await readFile(join(clientRoot, 'index.html'), 'utf8');
    ({ render } = await import(pathToFileURL(join(root, 'dist/server/entry-server.js')).href));
    if (typeof render !== 'function') throw new Error('Missing SSR renderer; run npm run build');
    const manifest = JSON.parse(await readFile(join(clientRoot, '.vite/manifest.json'), 'utf8'));
    const immutable = new Set(Object.values(manifest).flatMap(entry => [entry.file, ...(entry.css ?? []), ...(entry.assets ?? [])]));
    const canonicalRoot = await realpath(clientRoot);
    async function visit(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const absolute = join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error('Static build must not contain symlinks');
        const canonical = await realpath(absolute);
        if (!canonical.startsWith(canonicalRoot + sep)) throw new Error('Static file escaped build directory');
        if (entry.isDirectory()) await visit(absolute);
        else if (entry.isFile()) {
          const name = relative(clientRoot, absolute).split(sep).join('/');
          // The template and source maps are never directly public endpoints.
          if (name === 'index.html' || name.endsWith('.map')) continue;
          assets.set('/' + name, { path: canonical, type: mime[extname(name)] ?? 'application/octet-stream', immutable: immutable.has(name) });
        }
      }
    }
    await visit(clientRoot);
  }

  return {
    handleUpgrade,
    async handle(request, response) {
      let path;
      try { path = pathname(request, development); } catch { return errorResponse(response, 400); }
      if (path === null) return errorResponse(response, 404);
      if (request.method !== 'GET' && request.method !== 'HEAD') return errorResponse(response, 405);
      if (path === '/') {
        const cancellation = new AbortController();
        const cancel = () => cancellation.abort();
        response.once('close', cancel);
        try {
          const props = pageProps(new URL(request.url, 'http://localhost'), await readInitialMarket(services));
          const source = vite ? await vite.transformIndexHtml(request.url, await readFile(join(root, 'index.html'), 'utf8')) : template;
          const renderer = vite ? (await vite.ssrLoadModule('/web/entry-server.tsx')).render : render;
          const markup = await renderer(props, { signal: cancellation.signal });
          await send(request, response, pageHtml(source, markup, props), 'text/html; charset=utf-8', 'private, no-store');
        } finally { response.removeListener('close', cancel); }
        return;
      }
      if (path.startsWith('/api/') || path === '/api') return errorResponse(response, 404);
      if (vite) {
        await new Promise((accept, reject) => {
          response.once('finish', accept);
          response.once('close', accept);
          vite.middlewares(request, response, error => error ? reject(error) : (errorResponse(response, 404), accept()));
        });
        return;
      }
      const asset = assets.get(path);
      if (!asset) return errorResponse(response, 404);
      // Only content-addressed assets are retained in memory and compressed
      // once. Public files keep their bounded per-request lifetime.
      const content = asset.immutable ? await (asset.content ??= readFile(asset.path)) : await readFile(asset.path);
      await send(request, response, content, asset.type,
        asset.immutable ? 'private, max-age=31536000, immutable' : 'private, max-age=0, must-revalidate',
        asset.immutable ? () => asset.compressed ??= compress(content, { level: 4 }) : undefined);
    },
    async close() { await vite?.close(); },
  };
}
