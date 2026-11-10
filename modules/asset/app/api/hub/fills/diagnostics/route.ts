import { apiOwner, failure, json } from '@/lib/api';
import { db } from '@/lib/store';
import { hubFillsService } from '@/lib/hub-fills';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  try { const owner = await apiOwner(request); return json(await hubFillsService.diagnostics(db(), owner)); }
  catch (error) { return failure(error); }
}
