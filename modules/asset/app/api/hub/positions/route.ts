import { apiOwner, failure, json } from '@/lib/api';
import { db, initialize } from '@/lib/store';
import { unseal } from '@/lib/vault';
import { hubPositionsService } from '@/lib/hub-positions';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    const owner = await apiOwner(request);
    const version = new URL(request.url).searchParams.get('schemaVersion');
    if (version !== null && version !== '1') return json({ error: '不支持的仓位版本' }, 400);
    await initialize(owner);
    return json(await hubPositionsService.read(db(), owner, unseal));
  } catch (error) {
    if (error instanceof Error && error.message === 'AUTH_REQUIRED') return failure(error);
    return json({ error: '仓位服务暂不可用，请稍后重试' }, 503);
  }
}
