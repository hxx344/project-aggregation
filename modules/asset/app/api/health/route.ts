import { db } from '@/lib/sqlite';
import { serverConfig } from '@/lib/server-config';
export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    serverConfig();
    await db().prepare('SELECT 1').first();
    return Response.json({ status: 'ok', release: process.env.ASSET_RELEASE || 'development' }, { headers: { 'Cache-Control': 'no-store' } });
  } catch { return Response.json({ status: 'unavailable' }, { status: 503 }); }
}
