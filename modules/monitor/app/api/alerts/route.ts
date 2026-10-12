// The Linux Node server handles this path before Next.js. Sites has no resident monitor.
export async function GET() {
  return Response.json({ available: false, reason: "当前站点未运行 Linux 告警后台。部署 Linux 版本后可在这里保存阈值并启用飞书告警。" }, { headers: { "Cache-Control": "no-store" } });
}
