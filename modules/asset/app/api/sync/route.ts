import {apiOwner,json,failure,jsonBody} from '@/lib/api';
import {refresh} from '@/lib/store';
import {parseAeroLp} from '@/lib/aero-lp';
// The ledger page posts an empty body; the workbench adds its Aero LP valuation.
export async function POST(request:Request){try{const owner=await apiOwner(request,true,32768);return json(await refresh(owner,parseAeroLp(request.body?await jsonBody(request,32768):{})));}catch(e){return failure(e);}}
