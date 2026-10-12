import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { validSession } from './auth-core';
import { serverConfig } from './server-config';
export const SESSION_COOKIE = 'asset_session';
export async function currentOwner() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return validSession(token, serverConfig().sessionSecret) ? 'owner' : null;
}
export async function requireOwner() {
  const owner = await currentOwner();
  if (!owner) redirect('/login');
  return owner;
}
