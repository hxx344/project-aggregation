import { monitors } from "../../../lib/monitors";
export function GET() {
  return Response.json({ schemaVersion: 1, monitors: monitors.map(monitor => ({ ...monitor, runtime: { available: false, monitorId: monitor.id, enabled: true, revision: 0, running: false, reason: '当前为网页预览，连接常驻监控服务后可控制开关。' } })) }, { headers: { "Cache-Control": "no-store" } });
}
