import { apiOwner, failure, json } from '@/lib/api';
import { db, initialize } from '@/lib/store';
import { readDailyChanges } from '@/lib/daily-changes';

export async function GET(request: Request) {
  try {
    const owner = await apiOwner(request);
    await initialize(owner);
    return json(await readDailyChanges(db(), owner));
  } catch (error) { return failure(error); }
}
