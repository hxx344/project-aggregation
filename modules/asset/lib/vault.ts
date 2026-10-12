import { serverConfig } from './server-config';
async function key(){
  const raw=serverConfig().credentialKey;
  if(!raw || !/^[0-9a-f]{64}$/i.test(raw)) throw new Error('服务端密钥未配置，暂时无法保存交易所连接');
  return crypto.subtle.importKey('raw',Uint8Array.from(raw.match(/../g)!,x=>parseInt(x,16)),'AES-GCM',false,['encrypt','decrypt']);
}
export async function seal(value:unknown, owner:string){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const result=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(owner)},await key(),new TextEncoder().encode(JSON.stringify(value)));
  return JSON.stringify({iv:Array.from(iv),cipher:Array.from(new Uint8Array(result))});
}
export async function unseal(value:string,owner:string){
  const data=JSON.parse(value);
  const result=await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(data.iv),additionalData:new TextEncoder().encode(owner)},await key(),new Uint8Array(data.cipher));
  return JSON.parse(new TextDecoder().decode(result));
}
