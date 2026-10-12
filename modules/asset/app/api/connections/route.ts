import {z} from 'zod';
import {apiOwner,json,jsonBody,failure} from '@/lib/api';
import {connect,disconnect} from '@/lib/store';
import {connectionSchema} from '@/lib/validation';
export async function POST(request:Request){try{const owner=await apiOwner(request,true);return json(await connect(owner,connectionSchema.parse(await jsonBody(request))));}catch(e){return failure(e);}}
export async function DELETE(request:Request){try{const owner=await apiOwner(request,true),input=z.object({exchange:z.enum(['bybit','aster','binance','okx','variational'])}).strict().parse(await jsonBody(request));return json(await disconnect(owner,input.exchange));}catch(e){return failure(e);}}
