export function POST() {
  return Response.json({ error: "当前未连接 Linux 告警后台，无法发送测试消息。" }, { status: 503, headers: { "Cache-Control": "no-store" } });
}
