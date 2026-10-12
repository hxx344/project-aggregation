import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHandler } from "../server/http.mjs";

test("Linux endpoints authenticate, reject cross-site edits and protect live/config responses", async t => {
  let writes = 0;
  const service = {
    view: () => ({ available: true }), quote: async () => ({ premium: 42 }),
    update: async value => { writes++; return { revision: value.revision + 1 }; },
    test: async () => ({ sent: true }),
  };
  const server = createServer(createHandler({ service, username: "admin", password: "test-password-only", nextHandler: (_request, response) => { response.end("dashboard"); } }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Basic ${Buffer.from("admin:test-password-only").toString("base64")}` };
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/api/alerts`)).status, 401);
  assert.equal((await fetch(base)).status, 401);
  const quoted = await fetch(`${base}/api/quote`, { headers });
  assert.equal(quoted.headers.get("cache-control"), "no-store");
  assert.deepEqual(await quoted.json(), { premium: 42 });
  const put = { method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: '{"revision":3}' };
  assert.equal((await fetch(`${base}/api/alerts`, { ...put, headers: { ...put.headers, Origin: "https://attacker.invalid" } })).status, 403);
  assert.equal(writes, 0);
  const result = await fetch(`${base}/api/alerts`, { ...put, headers: { ...put.headers, Origin: base } });
  assert.deepEqual(await result.json(), { revision: 4 });
  assert.equal(writes, 1);
  assert.equal((await fetch(`${base}/api/alerts`, { method: "DELETE", headers })).status, 405);
  service.quote = async () => { throw new Error("upstream failure"); };
  assert.equal((await fetch(`${base}/api/quote`, { headers })).status, 503);
});
