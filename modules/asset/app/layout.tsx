import type { Metadata, Viewport } from 'next';
import './globals.css';
export const viewport: Viewport = { colorScheme: 'dark', themeColor: '#0a0d11' };
export const metadata: Metadata = { title:'资产统计 · 个人资产账本', description:'资产估值、历史记录与交易所只读同步。', icons:{icon:'/favicon.svg',shortcut:'/favicon.svg'} };
// Runs before first paint so the duplicate brand header never flashes inside the hub.
// The host test must stay identical to trustedHubOrigin in lib/hub-bridge.ts.
const hubEmbeddedFlag="if(window.parent!==window&&/^p-[a-f0-9]{24}\\.hub\\.localhost$/.test(location.hostname)&&(location.protocol==='http:'||location.protocol==='https:'))document.documentElement.classList.add('hub-embedded')";
export default function RootLayout({children}:Readonly<{children:React.ReactNode}>){return <html lang="zh-CN" className="dark" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{__html:hubEmbeddedFlag}}/></head><body>{children}</body></html>;}
