import { readHubSummary } from '../../../../server/hub-summary.mjs';
export async function GET(request: Request) {
  // Resident deployments intercept this route with their collector caches.
  // The stateless preview has no collector and does not start public market fetches.
  const url = new URL(request.url);
  try {
    const data = await readHubSummary(new Map(), Date.now(), url.searchParams.get('monitor') || 'oil');
    return Response.json(url.searchParams.get('schemaVersion') === '2' ? { schemaVersion: 2, data } : { schemaVersion: 1, data: { updatedAt: data.updatedAt || new Date(0).toISOString(), metrics: data.metrics } }, { headers: { 'Cache-Control': 'no-store' } });
  } catch { return Response.json({ error: '监控模块不存在' }, { status: 400, headers: { 'Cache-Control': 'no-store' } }); }
}
