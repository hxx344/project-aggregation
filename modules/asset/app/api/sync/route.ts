import {apiOwner,json,failure} from '@/lib/api';
import {refresh} from '@/lib/store';
export async function POST(request:Request){try{return json(await refresh(await apiOwner(request,true)));}catch(e){return failure(e);}}
