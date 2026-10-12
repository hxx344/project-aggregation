'use client';
import { useState } from 'react';
export default function LoginForm() {
  const [password, setPassword] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <form className="form-grid" onSubmit={async event => {
    event.preventDefault(); if (busy) return; setBusy(true); setError('');
    try {
      const response = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || '登录失败');
      window.location.assign('/');
    } catch (failure) { setError(failure instanceof Error ? failure.message : '无法连接服务器'); setBusy(false); }
  }}><label>登录密码<input type="password" autoComplete="current-password" required maxLength={256} value={password} onChange={event => setPassword(event.target.value)}/></label>{error && <p className="error-text" role="alert">{error}</p>}<button className="button primary" disabled={busy}>{busy ? '正在登录…' : '进入账本'}</button></form>;
}
