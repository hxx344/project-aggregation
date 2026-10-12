import { requireOwner } from '@/lib/auth';
import { getLedger } from '@/lib/store';
import Dashboard from './dashboard';
export const dynamic = 'force-dynamic';
export default async function Page(){ const owner=await requireOwner(); try{return <Dashboard initial={await getLedger(owner)}/>;}catch{return <main className="page"><h1>资产统计</h1><p>数据存储暂不可用，请稍后刷新。原始表格保持不变。</p></main>;} }
