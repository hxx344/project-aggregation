import { apiOwner, failure, json, jsonBody } from '@/lib/api';
import { db } from '@/lib/store';
import { loadCashFlows, saveCashFlow } from '@/lib/cash-flow-store';

export async function GET(request: Request) {
  try { const owner = await apiOwner(request); return json(await loadCashFlows(db(), owner)); } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    const owner = await apiOwner(request, true);
    return json(await saveCashFlow(db(), owner, await jsonBody(request)));
  } catch (error) { return failure(error); }
}
