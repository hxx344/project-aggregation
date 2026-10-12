const headers = { "Cache-Control": "no-store" };
export function GET() {
  return Response.json({ available: false, reason: "当前为网页行情版。请在 Linux 部署的面板中设置统一飞书机器人，后台会持续运行告警。" }, { headers });
}
export function PUT() {
  return Response.json({ error: "当前未连接 Linux 告警后台，配置未保存。" }, { status: 503, headers });
}
