import { apiOwner, json } from '@/lib/api';
import { db } from '@/lib/sqlite';
import { unseal } from '@/lib/vault';
import { readTradingConnections, tradingExportFailure } from '@/lib/trading-export';

export async function GET(request: Request) {
  try {
    const owner = await apiOwner(request);
    // Legacy Hub clients require exactly two rows; new clients explicitly opt in.
    const includeOkx = new URL(request.url).searchParams.get('include') === 'okx';
    return json(await readTradingConnections(db(), owner, unseal, { includeOkx }));
  } catch (error) {
    if (error instanceof Error && error.message === 'AUTH_REQUIRED') return json({ error: '请先登录' }, 401);
    const safe = tradingExportFailure(error);
    return json({ error: safe.error }, safe.status);
  }
}
