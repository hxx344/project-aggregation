import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);

/**
 * Send JSON response with optional gzip compression
 * Compresses responses larger than 1KB when client supports it
 */
export async function sendCompressed(req, res, status, data, headers = {}) {
  const json = JSON.stringify(data);
  const acceptsGzip = req.headers['accept-encoding']?.includes('gzip');

  // Compress responses larger than 1KB
  if (json.length > 1024 && acceptsGzip) {
    try {
      const compressed = await gzipAsync(Buffer.from(json, 'utf8'));
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Encoding': 'gzip',
        'Cache-Control': 'no-store',
        'Vary': 'Accept-Encoding',
        ...headers
      });
      res.end(compressed);
      return;
    } catch (error) {
      // Fall back to uncompressed on error
    }
  }

  // Send uncompressed
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(json);
}
