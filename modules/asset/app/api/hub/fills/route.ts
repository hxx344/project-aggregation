import { apiOwner, failure, json } from '@/lib/api';
import { db, initialize } from '@/lib/store';
import { unseal } from '@/lib/vault';
import { hubFillsService, validFillsQuery } from '@/lib/hub-fills';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    const owner = await apiOwner(request);
    if (!validFillsQuery(request.url)) return json({ error: '不支持的成交查询参数' }, 400);
    await initialize(owner);
    return json(await hubFillsService.read(db(), owner, unseal));
  } catch (error) {
    if (error instanceof Error && error.message === 'AUTH_REQUIRED') return failure(error);
    return json({ error: '成交服务暂不可用，请稍后重试' }, 503);
  }
}
