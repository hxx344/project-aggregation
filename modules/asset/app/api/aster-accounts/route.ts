import {apiOwner,json,jsonBody,failure} from '@/lib/api';
import {connectAsterAccount,deleteAsterAccount} from '@/lib/store';
import {asterAccountSchema,asterAccountDeleteSchema} from '@/lib/validation';
export async function POST(request:Request){try{const owner=await apiOwner(request,true);return json(await connectAsterAccount(owner,asterAccountSchema.parse(await jsonBody(request)),false));}catch(e){return failure(e);}}
export async function PATCH(request:Request){try{const owner=await apiOwner(request,true);return json(await connectAsterAccount(owner,asterAccountSchema.parse(await jsonBody(request)),true));}catch(e){return failure(e);}}
export async function DELETE(request:Request){try{const owner=await apiOwner(request,true),input=asterAccountDeleteSchema.parse(await jsonBody(request));return json(await deleteAsterAccount(owner,input.id,input.action));}catch(e){return failure(e);}}
