import { z } from 'zod';
import { apiOwner, failure, json, jsonBody } from '@/lib/api';
import { importLedger } from '@/lib/import-ledger';
import { IMPORT_MAX_BYTES } from '@/lib/source-ledger';

export async function POST(request: Request) {
  try {
    const owner = await apiOwner(request, true, IMPORT_MAX_BYTES);
    const input = z.object({ source: z.unknown(), apply: z.boolean() }).parse(await jsonBody(request, IMPORT_MAX_BYTES));
    return json(await importLedger(owner, input.source, input.apply));
  } catch (error) { return failure(error); }
}
