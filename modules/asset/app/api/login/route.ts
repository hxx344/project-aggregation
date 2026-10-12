import { cookies } from 'next/headers';
import { createSession, SESSION_SECONDS, verifyPassword } from '@/lib/auth-core';
import { SESSION_COOKIE } from '@/lib/auth';
import { serverConfig } from '@/lib/server-config';
import { db } from '@/lib/sqlite';
import { json, jsonBody, sameOrigin } from '@/lib/api';

export async function POST(request: Request) {
  try { sameOrigin(request); } catch { return json({ error: '请求来源不匹配' }, 403); }
  let password: unknown;
  try { password = (await jsonBody(request)).password; } catch { return json({ error: '输入格式不正确' }, 400); }
  if (typeof password !== 'string' || password.length > 256) return json({ error: '密码格式不正确' }, 400);
  try {
    const now = Date.now(), cutoff = now - 300_000;
    // One local account: an atomic, persisted limit also covers concurrent requests and restarts.
    const attempt = await db().prepare(`INSERT INTO auth_attempts(id,started_at,attempts) VALUES('owner',?,1)
      ON CONFLICT(id) DO UPDATE SET started_at=CASE WHEN started_at < ? THEN ? ELSE started_at END,
      attempts=CASE WHEN started_at < ? THEN 1 ELSE attempts+1 END RETURNING attempts`).bind(now,cutoff,now,cutoff).first<{attempts:number}>();
    if (!attempt || attempt.attempts > 10) return json({ error: '尝试次数过多，请 5 分钟后重试' }, 429);
    const config = serverConfig();
    if (!await verifyPassword(password, config.passwordHash)) return json({ error: '登录密码不正确' }, 401);
    await db().prepare("DELETE FROM auth_attempts WHERE id = 'owner'").run();
    (await cookies()).set(SESSION_COOKIE, createSession(config.sessionSecret), {
      httpOnly: true, sameSite: 'strict', secure: process.env.PUBLIC_ORIGIN?.startsWith('https://') ?? false,
      path: '/', maxAge: SESSION_SECONDS,
    });
    return json({ ok: true });
  } catch { return json({ error: '登录服务暂不可用，请检查服务器配置' }, 503); }
}
