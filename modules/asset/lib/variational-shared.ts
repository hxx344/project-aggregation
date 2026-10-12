export type VariationalCredential = { vrToken: string };

export const VARIATIONAL_ERRORS = {
  invalid_data: 'Var 返回的账户数据不完整或数值无效；已保留上次数据',
  network_error: 'Var 读取失败，请检查会话及网络后重试；已保留上次数据',
  challenge: 'Var 的 Cloudflare 浏览器验证拦截了服务器请求，后台暂时无法读取资产；这不能说明令牌失效。已保留上次数据',
  unauthorized: 'Var 未接受当前会话（HTTP 401），请确认 Omni 登录状态并更新 vr-token；已保留上次数据',
  forbidden: 'Var 拒绝服务器访问（HTTP 403），尚未确认是会话失效；已保留上次数据',
  html: 'Var 返回了网页而非账户数据，无法确认登录或访问状态；已保留上次数据',
  rate_limited: 'Var 请求过于频繁，请稍后重试；已保留上次数据',
  timeout: 'Var 读取超时，请稍后重试；已保留上次数据',
  cancelled: 'Var 读取已取消；已保留上次数据',
  redirect: 'Var 返回了重定向，无法读取账户数据；已保留上次数据',
  client_unavailable: 'Var 服务器未找到可用的 Python 3，无法读取账户数据；已保留上次数据',
  client_error: 'Var Python 读取客户端运行失败；已保留上次数据',
} as const;

export function validateVariationalCredential(c: VariationalCredential): void {
  if (typeof c?.vrToken !== 'string' || c.vrToken.length < 5 || c.vrToken.length > 4096 || !/^[A-Za-z0-9._~-]+$/.test(c.vrToken)) throw new Error('Var 请填写单个 vr-token 值，不要填写完整 Cookie');
}

export function variationalDecimal(value: unknown): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(VARIATIONAL_ERRORS.invalid_data);
    return value === 0 ? 0 : value;
  }
  if (typeof value !== 'string' || value.length > 128 || !/^-?[0-9]+(?:\.[0-9]+)?$/.test(value)) throw new Error(VARIATIONAL_ERRORS.invalid_data);
  const result = Number(value);
  if (!Number.isFinite(result) || (result === 0 && /[1-9]/.test(value))) throw new Error(VARIATIONAL_ERRORS.invalid_data);
  return result === 0 ? 0 : result;
}

export function hasValidVariationalBalance(value: unknown): boolean {
  try { variationalDecimal(value); return true; } catch { return false; }
}
