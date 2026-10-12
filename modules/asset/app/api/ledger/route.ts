import {apiOwner,json,jsonBody,failure} from '@/lib/api';
import {getLedger,editAsset,editFx} from '@/lib/store';
import {editSchema,fxSchema} from '@/lib/validation';
export async function GET(request:Request){try{return json(await getLedger(await apiOwner(request)));}catch(e){return failure(e);}}
export async function PATCH(request:Request){try{const owner=await apiOwner(request,true),body=await jsonBody(request);return json('fx' in body?await editFx(owner,fxSchema.parse(body).fx):await editAsset(owner,editSchema.parse(body)));}catch(e){return failure(e);}}
