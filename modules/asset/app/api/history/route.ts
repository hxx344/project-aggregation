import {apiOwner,json,failure} from '@/lib/api';
import {db, initialize} from '@/lib/store';
import {readSource, type SourceLedger} from '@/lib/seed';
export async function GET(request:Request){try{
  const owner=await apiOwner(request),id=new URL(request.url).searchParams.get('id');
  await initialize(owner);
  const source=await db().prepare('SELECT value FROM settings WHERE owner = ? AND key = ?').bind(owner,'source-ledger').first<{value:string}>();
  const raw: SourceLedger=source?JSON.parse(source.value):readSource();
  const original=raw.periods.find(p=>p.id===id);
  if(original)return json({rows:original.rows});
  if(!id||!/^daily-\d{4}-\d{2}-\d{2}$/.test(id)&&!/^archive-[a-f0-9-]{36}-\d+$/.test(id))return json({error:'未找到记录'},404);
  const row=await db().prepare('SELECT data FROM snapshots WHERE owner = ? AND date = ?').bind(owner,id.startsWith('daily-')?id.slice(6):id).first<{data:string}>();
  return row?json({rows:JSON.parse(row.data).assets}):json({error:'未找到记录'},404);
}catch(e){return failure(e);}}
