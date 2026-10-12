import { apiOwner, json, jsonBody } from '@/lib/api';
import { verifyPassword } from '@/lib/auth-core';
import { serverConfig } from '@/lib/server-config';
import { db } from '@/lib/sqlite';
import { unseal } from '@/lib/vault';
import { exportTradingConnection, tradingExportFailure } from '@/lib/trading-export';
import { workspaceExportAuthorized } from '@/lib/workspace-auth';

export async function POST(request: Request) {
  let owner: string;
  try {
    owner = await apiOwner(request, true, 2048);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message === 'AUTH_REQUIRED') return json({ error: '请先登录' }, 401);
    if (message === 'ORIGIN_REJECTED') return json({ error: '请求来源不匹配' }, 403);
    if (message === '请使用 JSON 请求' || message === '请求内容过大') return json({ error: '输入格式不正确' }, 400);
    return json({ error: 'Asset 连接服务暂不可用，请稍后重试' }, 503);
  }
  let input: unknown;
  try { input = await jsonBody(request, 2048); }
  catch { return json({ error: '输入格式不正确' }, 400); }
  try {
    return json(await exportTradingConnection(db(), owner, input, {
      unseal,
      workspaceAuthorized: workspaceExportAuthorized(request.headers),
      verifyPassword: password => verifyPassword(password, serverConfig().passwordHash),
    }));
  } catch (error) {
    const safe = tradingExportFailure(error);
    return json({ error: safe.error }, safe.status);
  }
}
