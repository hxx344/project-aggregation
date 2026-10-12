import { redirect } from 'next/navigation';
import { currentOwner } from '@/lib/auth';
import LoginForm from './form';
export const dynamic = 'force-dynamic';
export default async function LoginPage() {
  if (await currentOwner()) redirect('/');
  return <main className="login-page"><section className="panel login-panel"><span className="eyebrow">PERSONAL ASSET LEDGER</span><h1>登录资产账本</h1><p className="help">输入安装时生成的登录密码，查看和管理你的资产。</p><LoginForm/></section></main>;
}
