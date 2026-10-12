import { apiOwner, failure, json } from '@/lib/api';
import { db, initialize } from '@/lib/store';
import { readHubSummary } from '@/lib/hub-summary';

export async function GET(request: Request) {
  try {
    const owner = await apiOwner(request);
    const requested = new URL(request.url).searchParams.get('schemaVersion');
    if (requested !== null && requested !== '2') return json({ error: '不支持的摘要版本' }, 400);
    await initialize(owner);
    return json(await readHubSummary(db(), owner));
  } catch (error) { return failure(error); }
}
