import { cookies } from 'next/headers';
import { SESSION_COOKIE } from '@/lib/auth';
import { json, sameOrigin } from '@/lib/api';
export async function POST(request: Request) {
  try { sameOrigin(request); } catch { return json({ error: '请求来源不匹配' }, 403); }
  (await cookies()).delete(SESSION_COOKIE);
  return json({ ok: true });
}
