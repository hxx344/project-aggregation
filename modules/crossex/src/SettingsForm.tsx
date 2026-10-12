import { useState } from 'react';
import type { Config } from './types';

export type LiveConfig = Pick<Config, 'entryPaused' | 'monitorUrl' | 'monitorUsername' | 'hasMonitorPassword' | 'notionalPerLeg' | 'maxOpen' | 'maxTotalNotional' | 'feeBps' | 'feeSchedule' | 'slippageBps' | 'minNetBps' | 'cooldownSeconds'>;
const numericFields = [
  ['notionalPerLeg', '单腿名义额上限（非保证金）', 'USDT'], ['maxTotalNotional', '总名义额上限', 'USDT'],
  ['maxOpen', '持仓组数上限', '组'], ['slippageBps', '价格偏离上限', 'bp'],
  ['minNetBps', '机会最低预算净价差', 'bp'], ['feeBps', '默认手续费预算', 'bp'],
  ['cooldownSeconds', '同币种操作冷却', '秒'],
] as const;

export default function SettingsForm({ config, configured, ready, loading, loadError, retry, busy, save, connect, disconnect }: {
  config: LiveConfig | null; configured: boolean | null; ready: boolean; loading: boolean; loadError: string; retry: () => void; busy: boolean;
  save: (input: object) => Promise<boolean>;
  connect: (input: { apiKey: string; apiSecret: string }) => Promise<boolean>;
  disconnect: () => Promise<boolean>;
}) {
  const [apiKey, setApiKey] = useState(''), [apiSecret, setApiSecret] = useState('');
  const [connectionSaved, setConnectionSaved] = useState(false), [confirmDisconnect, setConfirmDisconnect] = useState(false);
  return <div className="settings-layout">
    <form className="panel settings-panel" aria-label="Gate CrossEx 实盘连接" onSubmit={async e => {
      e.preventDefault(); if (!ready || busy) return; setConnectionSaved(false);
      const credentials = { apiKey: apiKey.trim(), apiSecret: apiSecret.trim() };
      setApiKey(''); setApiSecret('');
      if (await connect(credentials)) { setConnectionSaved(true); setConfirmDisconnect(false); }
    }}>
      <h2>Gate CrossEx 实盘连接</h2>
      <p className="muted">凭据仅发送到此服务进行连接校验。已保存的 Key 与 Secret 不会回显。</p>
      <p className="muted" role="status">连接配置：{configured == null ? '待读取' : configured ? '已有账户连接' : '尚未配置账户'}</p>
      {loadError ? <div className="notice warning" role="alert"><span>{loadError}{ready ? ' 已保留先前读取的连接信息。' : ' 可先填写凭据，读取成功后再提交。'}</span><button type="button" disabled={busy || loading} onClick={retry}>{loading ? '正在重试…' : '重试连接信息'}</button></div> : !ready ? <div className="notice" role="status"><span>正在读取连接与授权信息，可先填写凭据；读取完成后可提交。</span><button type="button" disabled={busy || loading} onClick={retry}>重试连接信息</button></div> : null}
      <div className="form-grid connection-fields">
        <label>API Key<input required type="password" autoComplete="new-password" spellCheck={false} value={apiKey} onChange={e => { setApiKey(e.target.value); setConnectionSaved(false); }} placeholder={configured ? '输入新的 Key 以更换连接' : '输入 Gate API Key'}/></label>
        <label>API Secret<input required type="password" autoComplete="new-password" spellCheck={false} value={apiSecret} onChange={e => { setApiSecret(e.target.value); setConnectionSaved(false); }} placeholder="输入 Gate API Secret"/></label>
      </div>
      <div className="save-row"><button type="submit" className="primary" disabled={busy || !ready || !apiKey.trim() || !apiSecret.trim()}>{busy ? '正在处理…' : !ready ? '等待读取连接信息' : configured ? '更换并校验连接' : '连接并校验账户'}</button>{connectionSaved && <span role="status" className="positive">连接信息已更新</span>}</div>
      {configured === true && <div className="disconnect-row">{confirmDisconnect ? <><span>移除连接后无法在此查询或操作现有仓位。</span><button type="button" disabled={busy || !ready} onClick={async () => { if (ready && await disconnect()) setConfirmDisconnect(false); }}>确认移除连接</button><button type="button" onClick={() => setConfirmDisconnect(false)}>保留连接</button></> : <button type="button" className="text-button" disabled={busy || !ready} onClick={() => setConfirmDisconnect(true)}>移除此连接</button>}</div>}
    </form>
    {config ? <SettingsPreferences config={config} ready={ready} busy={busy} save={save}/> : <section className="panel settings-panel"><h2>行情与额度设置</h2><p className="muted">{loadError ? '配置读取失败。重试连接信息后，已有行情与额度设置会显示在这里。' : '正在读取已保存的行情与额度设置…'}</p></section>}
  </div>;
}

/** Keep the user's draft stable across bootstrap refreshes and normal account polling. */
function SettingsPreferences({ config, ready, busy, save }: { config: LiveConfig; ready: boolean; busy: boolean; save: (input: object) => Promise<boolean> }) {
  const [draft, setDraft] = useState(config);
  const [password, setPassword] = useState(''), [clearPassword, setClearPassword] = useState(false), [saved, setSaved] = useState(false);
  return <form aria-label="行情与额度设置" onChange={() => setSaved(false)} onSubmit={async e => {
      e.preventDefault(); if (busy || !ready) return; setSaved(false);
      const { hasMonitorPassword: _hasPassword, ...editable } = draft;
      if (await save({ config: editable, ...(password ? { monitorPassword: password } : {}), clearMonitorPassword: clearPassword })) { setSaved(true); setPassword(''); setClearPassword(false); }
    }}>
      <section className="panel settings-panel">
        <h2>行情连接</h2>
        <p className="muted">使用 Market Monitor 的行情发现价差机会。账户持仓与订单由 Gate CrossEx 查询。</p>
        <div className="form-grid">
          <label>Market Monitor 地址<input required value={draft.monitorUrl} onChange={e => setDraft(value => ({ ...value, monitorUrl: e.target.value }))}/></label>
          <label>登录用户名<input value={draft.monitorUsername} autoComplete="off" onChange={e => setDraft(value => ({ ...value, monitorUsername: e.target.value }))}/></label>
          <label>登录密码<input type="password" value={password} autoComplete="new-password" placeholder={config.hasMonitorPassword ? '已保存，留空保留' : '尚未保存'} onChange={e => setPassword(e.target.value)}/></label>
        </div>
        <label className="check"><input type="checkbox" checked={clearPassword} onChange={e => setClearPassword(e.target.checked)}/>清除已保存的行情服务密码</label>
      </section>
      <section className="panel settings-panel">
        <h2>手动开仓额度与检查</h2>
        <p className="muted">保存后用于下一次订单预览；具体数量、价格与限制以核对页为准。1 bp = 0.01%。</p>
        <label className="check"><input type="checkbox" checked={draft.entryPaused} onChange={e => setDraft(value => ({ ...value, entryPaused: e.target.checked }))}/>暂停新开仓，保留手动平仓与撤单</label>
        <div className="form-grid">{numericFields.map(([key, label, unit]) => <label key={key}>{label}<div className="input-unit"><input required type="number" min="0" step={key === 'maxOpen' ? '1' : 'any'} value={draft[key]} onChange={e => setDraft(value => ({ ...value, [key]: Number(e.target.value) }))}/><span>{unit}</span></div></label>)}</div>
        <p className="muted">持仓额度按每组两条持仓腿计算，已有单腿也占用额度。</p>
        <div className="save-row"><button className="primary" disabled={busy || !ready} type="submit">{busy ? '正在保存…' : '保存行情与额度设置'}</button>{saved && <span role="status" className="positive">已保存</span>}</div>
      </section>
    </form>;
}
