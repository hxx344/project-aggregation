import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Aster · 账户与交易管理',
  description: '子账户持仓、杠杆额度、风险与双向开仓执行看板。',
};

// Runs before first paint so the duplicate brand header never flashes inside the hub.
// The host test must stay identical to the embedded check in lib/hub-bridge.ts.
const hubEmbeddedFlag =
  "if(window.parent!==window&&/^p-[a-f0-9]{24}\\.hub\\.localhost$/.test(location.hostname)&&(location.protocol==='http:'||location.protocol==='https:'))document.documentElement.classList.add('hub-embedded')";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: hubEmbeddedFlag }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
