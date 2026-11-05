import { useEffect, useState } from 'react';
import AeroMarketPage, { SettingsForm } from './AeroMarketPage';
import { AeroSafeConfig, AeroSafePositions } from './AeroSafePage';
import { useAeroMarket } from './aero-market-client';
import type { AeroMarket } from './aero-market-client';
import { useAeroSafe } from './aero-safe-client';
import { AERO_TABS, aeroTabOf, openAeroTab } from './aero-nav';
import { CircleAlert, LoaderCircle } from 'lucide-react';
import './aero-lp.css';
import './aero-safe.css';

// 配置标签里的行情扫描设置；本机缓存不含 RPC 地址，等服务器的完整数据到了才显示。
function MarketSettings({ market }: { market: AeroMarket }) {
  const [saved, setSaved] = useState(0);
  const { snapshot, cachedAt, busy, actionError } = market;
  if (!snapshot || cachedAt !== null) return <section className="panel lp-empty" role="status">{market.loadError ? <CircleAlert /> : <LoaderCircle className="spin" />}<p>{market.loadError ? `行情扫描设置读取失败：${market.loadError}` : '正在读取行情扫描设置…'}</p></section>;
  return <>
    {actionError ? <div className="lp-callout warning" role="alert"><CircleAlert size={15} />{actionError}</div> : null}
    {saved ? <div className="lp-callout success" role="status">扫描设置已保存，按新设置重新排程。</div> : null}
    <SettingsForm key={saved} config={snapshot.config} busy={!!busy} onSave={(next) => void market.execute('save', '/config', 'PUT', { config: next }).then((ok) => { if (ok) setSaved((v) => v + 1); })} />
  </>;
}

// Aero 模块：仓位（Safe 实盘头寸）、行情（各链池子）、配置（bot 私钥、Safe/Roles、行情扫描）。
// 行情快照与实盘状态在这里各读一份，三个标签共享；池详情里的开仓面板仍各自读取实盘状态。
export default function AeroPage({ onExpired }: { onExpired: () => void }) {
  // 标签由地址栏决定：浏览器后退、openAeroTab（popstate）与侧栏导航（App 重新渲染）都会切换。
  const [, setRouteTick] = useState(0);
  const tab = aeroTabOf(location.search);
  useEffect(() => { const change = () => setRouteTick((v) => v + 1); window.addEventListener('popstate', change); return () => window.removeEventListener('popstate', change); }, []);
  const market = useAeroMarket(onExpired);
  const safe = useAeroSafe(onExpired);
  const goConfig = () => openAeroTab('config');
  return <div className="lp-page">
    <header className="lp-heading"><div><h1>Aero</h1><p>资产与头寸在 Safe；bot 只持 gas，经 Zodiac Roles 在白名单与每日额度内操作</p></div></header>
    <div className="as-tabs" role="tablist" aria-label="Aero 分区">{AERO_TABS.map((t) => <button key={t.id} type="button" role="tab" id={`aero-tab-${t.id}`} aria-selected={tab === t.id} aria-controls="aero-tabpanel" className={tab === t.id ? 'active' : ''} onClick={() => { if (tab !== t.id) openAeroTab(t.id); }}>{t.label}</button>)}</div>
    <div className="lp-page" role="tabpanel" id="aero-tabpanel" aria-labelledby={`aero-tab-${tab}`}>
      {tab === 'positions' ? <AeroSafePositions safe={safe} market={market} onConfig={goConfig} />
        : tab === 'market' ? <AeroMarketPage market={market} safe={safe.state} onExpired={onExpired} onConfig={goConfig} />
        : <><AeroSafeConfig safe={safe} /><MarketSettings market={market} /></>}
    </div>
  </div>;
}
