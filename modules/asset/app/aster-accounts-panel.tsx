'use client';
import {useState} from 'react';
import {Plus, Pencil, Trash2} from 'lucide-react';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {Checkbox} from '@/components/ui/checkbox';
import type {AsterAccount} from '@/lib/types';

type Props={accounts:AsterAccount[];busy:boolean;error:string;clearError:()=>void;mutate:(path:string,method:string,body:unknown,onSuccess:()=>void)=>Promise<void>};
const stamp=(s:string|null)=>s?new Date(s).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'尚未同步';
export function AsterAccountsPanel({accounts,busy,error,clearError,mutate}:Props){
  const [editing,setEditing]=useState<{id:string;existing:boolean}|null>(null),[removing,setRemoving]=useState<AsterAccount|null>(null);
  const [name,setName]=useState(''),[address,setAddress]=useState(''),[secret,setSecret]=useState(''),[includeSpot,setIncludeSpot]=useState(false);
  function close(){setEditing(null);setAddress('');setSecret('');clearError();}
  function open(account?:AsterAccount){setEditing({id:account?.id??crypto.randomUUID(),existing:!!account});setName(account?.name??'');setIncludeSpot(account?.includeSpot??false);setAddress('');setSecret('');clearError();}
  return <section className="panel connection-card aster-accounts-panel">
    <div className="aster-heading"><div className="connection-card-title"><div className="exchange-mark aster">A</div><h2>Aster</h2><span className="status">{accounts.length} 个账号</span></div><button className="button primary" disabled={busy||accounts.length>=10} onClick={()=>open()}><Plus size={16}/>新增 Aster 账号</button></div>
    <p className="help">每个账号使用自己的 API Pro 钱包地址和私钥，分别同步后汇总。最多 10 个账号；每个实际账户只添加一次，更换 API 钱包请使用“更新连接”。</p>
    {accounts.length===0?<p className="help section-note">尚未添加账号。首次连接成功后，以账户余额替换原表 Aster 估值。</p>:<div className="aster-account-list">{accounts.map(account=>{
      const stale=!!account.error||!account.configured||Date.now()-Date.parse(account.updatedAt)>300000;
      return <article className="aster-account" key={account.id}>
        <div className="aster-heading"><h3>{account.name}</h3><span className={'status '+(stale?'amber':'live')}>{!account.configured?'已断开 · 保留旧值':account.error?'同步失败 · 保留旧值':stale?'数据已过期 · 保留旧值':'已连接'}</span></div>
        <strong className="aster-account-value">$ {account.value.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})} <small>USD</small></strong>
        <p className="help">{account.scope}{account.label?' · 钱包尾号 '+account.label:''}<br/>最近成功同步：{stamp(account.lastSync)}</p>
        {account.error&&<p className="error-text" role="status">{account.error}</p>}
        <div className="form-actions"><button className="button" disabled={busy} onClick={()=>open(account)}><Pencil size={14}/>{account.configured?'更新连接':'重新连接'}</button><button className="button" disabled={busy} onClick={()=>{setRemoving(account);clearError();}}><Trash2 size={14}/>移除账号</button></div>
      </article>;
    })}</div>}
    <Dialog open={!!editing} onOpenChange={v=>{if(!v&&!busy)close();}}><DialogContent><DialogHeader><DialogTitle>{editing?.existing?'更新 Aster 账号':'新增 Aster 账号'}</DialogTitle><DialogDescription>验证钱包与余额后加密保存。私钥仅用于服务端签名，程序仅查询余额。</DialogDescription></DialogHeader>
      <form className="form-grid" onSubmit={e=>{e.preventDefault();if(editing)void mutate('/api/aster-accounts',editing.existing?'PATCH':'POST',{id:editing.id,name:name.trim(),walletAddress:address.trim(),privateKey:secret.trim(),includeSpot},close);}}>
        <label>账号名称<input maxLength={40} required value={name} onChange={e=>setName(e.target.value)} placeholder="例如：主账号、备用账号"/></label>
        <label>API 钱包地址<input autoComplete="off" spellCheck={false} autoCapitalize="none" placeholder="0x…" required value={address} onChange={e=>setAddress(e.target.value)}/></label>
        <label>API 钱包私钥<input type="password" autoComplete="new-password" spellCheck={false} autoCapitalize="none" required value={secret} onChange={e=>setSecret(e.target.value)}/></label>
        <label className="checkbox-label"><Checkbox checked={includeSpot} onCheckedChange={v=>setIncludeSpot(v===true)}/>同时同步现货账户</label>
        <p className="help">填写 Aster「API Pro」生成的 API 钱包地址和私钥；不需要主钱包私钥。范围不含质押资产。</p>
        {error&&<p className="error-text" role="alert">{error}</p>}
        <div className="form-actions">{editing?.existing&&accounts.find(a=>a.id===editing.id)?.configured&&<button type="button" className="button" disabled={busy} onClick={()=>void mutate('/api/aster-accounts','DELETE',{id:editing.id,action:'disconnect'},close)}>断开并保留估值</button>}<button className="button primary" disabled={busy}>{busy?'验证中…':'验证并保存'}</button></div>
      </form>
    </DialogContent></Dialog>
    <Dialog open={!!removing} onOpenChange={v=>{if(!v&&!busy){setRemoving(null);clearError();}}}><DialogContent><DialogHeader><DialogTitle>移除 {removing?.name}</DialogTitle><DialogDescription>删除此账号的连接和已保存私钥，其资产将不再计入当前汇总。过往日期的快照保留，今天的快照会更新。</DialogDescription></DialogHeader>{error&&<p className="error-text" role="alert">{error}</p>}<div className="form-actions"><button className="button" disabled={busy} onClick={()=>setRemoving(null)}>取消</button><button className="button primary" disabled={busy} onClick={()=>{if(removing)void mutate('/api/aster-accounts','DELETE',{id:removing.id,action:'remove'},()=>setRemoving(null));}}>确认移除</button></div></DialogContent></Dialog>
  </section>;
}
