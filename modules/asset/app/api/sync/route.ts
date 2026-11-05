import {apiOwner,json,failure} from '@/lib/api';
import {refresh} from '@/lib/store';
// The ledger page posts an empty body; older workbench builds may still attach fields, which are ignored.
export async function POST(request:Request){try{const owner=await apiOwner(request,true,32768);return json(await refresh(owner));}catch(e){return failure(e);}}
