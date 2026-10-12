import { PassThrough } from 'node:stream';
import { renderToPipeableStream } from 'react-dom/server';
import Home from '../app/page';
import type { PageProps } from './page-props';

// Await lazy components before returning the fragment. The client hydrates
// exactly this Home tree, without a second fetch or a different root wrapper.
export function render(props: PageProps, { signal, timeoutMs = 15_000 }: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Page request cancelled')); return; }
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', cancel);
      if (error) { stream.abort(); output.destroy(); reject(error); }
      else resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const cancel = () => finish(new Error('Page request cancelled'));
    const timeout = setTimeout(() => finish(new Error('Page rendering timed out')), timeoutMs);
    output.on('data', chunk => chunks.push(Buffer.from(chunk)));
    output.on('end', () => finish());
    output.on('error', error => finish(error));
    const stream = renderToPipeableStream(<Home {...props} />, {
      onAllReady() { if (!settled) stream.pipe(output); },
      onShellError(error) { finish(error instanceof Error ? error : new Error('Page rendering failed')); },
      onError(error) { finish(error instanceof Error ? error : new Error('Page rendering failed')); },
    });
    signal?.addEventListener('abort', cancel, { once: true });
  });
}
