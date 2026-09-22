import { createOverviewEncoder } from '../server/overview-stream.mjs';

// Deterministic one-minute workload: four modules, 90 asset history points,
// three fast modules checked every 5 s, asset every 30 s, heartbeat every 15 s.
const started = Date.parse('2026-09-22T00:00:00Z');
const projects = ['aster', 'monitor', 'asset', 'crossex'].map((id, order) => ({
  project: { id, name: id, category: id === 'asset' ? 'assets' : 'monitoring', adapter: 'standard', enabled: true, order, staleAfterSeconds: 120, revision: 'fixture-v1' },
  state: 'online', message: '测试来源正常', checkedAt: new Date(started).toISOString(), updatedAt: new Date(started).toISOString(), latencyMs: 20,
  staleAfterSeconds: id === 'asset' ? 900 : 10,
  metrics: [{ key: 'value', label: '测试记录', value: 1000 + order, unit: 'USD' }],
  ...(id === 'asset' ? { trend: Array.from({ length: 90 }, (_, i) => ({ at: new Date(started - (90 - i) * 86400000).toISOString(), value: 10000 + i * 20 })) } : {}),
}));
const encode = createOverviewEncoder();
let legacyBytes = 0, deltaBytes = 0, messages = 0, heartbeats = 0;
function publish(ms) {
  const overview = { projects, generatedAt: new Date(started + ms).toISOString() };
  const event = encode(overview);
  legacyBytes += Buffer.byteLength(`data: ${JSON.stringify(overview)}\n\n`);
  deltaBytes += Buffer.byteLength(`data: ${JSON.stringify(event)}\n\n`);
  messages++; if (event.type === 'heartbeat') heartbeats++;
}
publish(0);
for (let ms = 5000; ms <= 60000; ms += 5000) {
  for (const item of projects) {
    if (item.project.id === 'asset' && ms % 30000) continue;
    item.checkedAt = item.updatedAt = new Date(started + ms).toISOString();
    publish(ms);
  }
  if (ms % 15000 === 0) publish(ms);
}
console.log(JSON.stringify({ fixtureSeconds: 60, projects: projects.length, historyPoints: 90, messages, heartbeats, legacyBytes, deltaBytes, reductionPercent: Number(((1 - deltaBytes / legacyBytes) * 100).toFixed(1)) }, null, 2));
