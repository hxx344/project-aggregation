import { currentOwner } from './auth';
export function sameOrigin(request: Request) {
  const origin=request.headers.get('origin');
  const expected=process.env.PUBLIC_ORIGIN || (new URL(request.url).protocol+'//'+request.headers.get('host'));
  if(!origin || origin!==expected || request.headers.get('sec-fetch-site')==='cross-site')throw new Error('ORIGIN_REJECTED');
}
export async function apiOwner(request:Request,mutation=false,maxBytes=8192){
  const owner=await currentOwner();
  if(!owner)throw new Error('AUTH_REQUIRED');
  if(mutation){
    sameOrigin(request);
    if(!request.headers.get('content-type')?.startsWith('application/json'))throw new Error('请使用 JSON 请求');
    if(Number(request.headers.get('content-length')??0)>maxBytes)throw new Error('请求内容过大');
  }
  return owner;
}
export async function jsonBody(request:Request,maxBytes=8192){
  const reader=request.body?.getReader();
  if(!reader)throw new Error('请求内容为空');
  const chunks:Uint8Array[]=[];let size=0;
  try{
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes){await reader.cancel();throw new Error('请求内容过大');}chunks.push(value);}
  }finally{reader.releaseLock();}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
export function failure(error:unknown){
  const message=error instanceof Error?error.message:'请求失败，请稍后重试';
  if(message==='AUTH_REQUIRED')return json({error:'请先登录'},401);
  if(message==='ORIGIN_REJECTED')return json({error:'请求来源不匹配'},403);
  if(error instanceof Error&&(error.name==='ZodError'||error.name==='SyntaxError'))return json({error:'输入格式不正确，请检查数值和连接信息'},400);
  // Do not echo provider responses, credentials, SQL text or crypto exception internals.
  if(/D1_|SQLITE|decrypt|OperationError|fetch failed|network|aborted|timeout/i.test(message))return json({error:'服务暂时不可用，已保留上次数据，请稍后重试'},503);
  return json({error:message},400);
}
