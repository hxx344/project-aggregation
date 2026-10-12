import { apiOwner, json, jsonBody, failure } from '@/lib/api';
import { saveWithdrawal, deleteWithdrawal } from '@/lib/store';
import { withdrawalSchema, withdrawalIdSchema } from '@/lib/validation';

async function save(request: Request, editing: boolean) {
  try {
    const owner = await apiOwner(request, true);
    return json(await saveWithdrawal(owner, withdrawalSchema.parse(await jsonBody(request)), editing));
  } catch (error) { return failure(error); }
}
export const POST = (request: Request) => save(request, false);
export const PATCH = (request: Request) => save(request, true);
export async function DELETE(request: Request) {
  try {
    const owner = await apiOwner(request, true);
    return json(await deleteWithdrawal(owner, withdrawalIdSchema.parse(await jsonBody(request)).id));
  } catch (error) { return failure(error); }
}
