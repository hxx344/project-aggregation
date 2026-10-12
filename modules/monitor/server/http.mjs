import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { readHubSummary } from './hub-summary.mjs';
import { monitors } from '../lib/monitors.ts';
const compress = promisify(gzip);
import { timingSafeEqual } from "node:crypto";

function equal(a, b) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
const json = async (response, status, value, request) => {
  const text = JSON.stringify(value);
  const acceptsGzip = (request?.headers['accept-encoding'] || '').split(',').some(item => { const [name, ...params] = item.trim().split(';'); return name.trim().toLowerCase() === 'gzip' && !params.some(value => /^\s*q\s*=\s*0(?:\.0*)?\s*$/i.test(value)); });
  if (request) response.setHeader('Vary', 'Accept-Encoding');
  if (acceptsGzip && Buffer.byteLength(text) > 1024) {
    const data = await compress(text, { level: 4 });
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Encoding': 'gzip', 'Content-Length': data.length }); response.end(data); return;
  }
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(text);
};
async function body(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 64 * 1024) throw new Error("请求内容过大。");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("请求必须是有效 JSON。"); }
}

export function createAuthorization({ username, password }) {
  const credential = Buffer.from(`${username}:${password}`).toString("base64");
  return request => equal(request.headers.authorization ?? "", `Basic ${credential}`);
}

export function createHandler({ service, services, username, password, pageHandler, nextHandler = pageHandler }) {
  const authorize = createAuthorization({ username, password });
  return async (request, response) => {
    try {
      const path = new URL(request.url, "http://localhost").pathname;
      if (path === "/healthz" && request.method === "GET") {
        const healthy = !services || ([...services.values()].every(service => !service.healthy || service.healthy()) && (!services.notifications || services.notifications.healthy()) && (!services.market || services.market.healthy()));
        return json(response, healthy ? 200 : 503, { status: healthy ? "ok" : "degraded", service: "market-spread-monitor", monitors: services ? [...services.keys()] : ["hynix"] });
      }
      if (!authorize(request)) {
        response.writeHead(401, { "WWW-Authenticate": 'Basic realm="Market Monitor", charset="UTF-8"', "Cache-Control": "no-store" });
        response.end("Authentication required");
        return;
      }
      if (services?.controls && path === '/api/monitors') {
        if (request.method !== 'GET') return json(response, 405, { error: '不支持此请求方法' });
        const runtime = services.controls.view();
        return json(response, 200, { schemaVersion: 1, monitors: monitors.map(monitor => ({ ...monitor, runtime: runtime[monitor.id] })) });
      }
      if (services && path === '/api/hub/summary') {
        if (request.method !== 'GET') return json(response, 405, { error: '不支持此请求方法' });
        const summaryUrl = new URL(request.url, 'http://localhost');
        const value = await readHubSummary(services, Date.now(), summaryUrl.searchParams.get('monitor') || 'oil', summaryUrl.searchParams.get('goldOil') || 'cl', summaryUrl.searchParams.get('goldOilExchange') || 'binance');
        return json(response, 200, new URL(request.url, 'http://localhost').searchParams.get('schemaVersion') === '2' ? { schemaVersion: 2, data: value } : { schemaVersion: 1, data: { updatedAt: value.updatedAt || new Date(0).toISOString(), metrics: value.metrics } });
      }
      if (services?.notifications && ["/api/notifications/feishu", "/api/notifications/feishu/test"].includes(path)) {
        const testing = path.endsWith("/test"), writing = request.method !== "GET";
        if (!(testing ? ["POST"] : ["GET", "PUT"]).includes(request.method)) return json(response, 405, { error: "不支持此请求方法" });
        if (writing) {
          const origin = request.headers.origin;
          if (request.headers["sec-fetch-site"] === "cross-site" || (origin && new URL(origin).host !== request.headers.host)) return json(response, 403, { error: "不接受跨站配置请求" });
          if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] || "")) return json(response, 415, { error: "请使用 JSON 请求" });
        }
        try {
          const input = writing ? await body(request) : undefined;
          return json(response, 200, testing ? await services.notifications.test() : writing ? await services.notifications.update(input) : services.notifications.view());
        } catch (error) { return json(response, error.status || (testing ? 502 : 400), { error: error.message }); }
      }
      const route = /^\/api\/monitors\/([^/]+)\/(.+)$/.exec(path);
      if (route && services) {
        const [, id, action] = route;
        const backend = services.get(id);
        if (!backend) return json(response, 404, { error: "监控模块不存在" });
        if (Object.hasOwn(backend.actions, action)) {
          if (!backend.actions[action].includes(request.method)) return json(response, 405, { error: "不支持此请求方法" });
          if (action === 'stream' && typeof backend.stream === 'function') {
            try { return backend.stream(request, response); }
            catch (error) { return json(response, error.status || 503, { error: error.message }); }
          }
          const writing = request.method !== "GET";
          if (writing) {
            const origin = request.headers.origin;
            if (request.headers["sec-fetch-site"] === "cross-site" || (origin && new URL(origin).host !== request.headers.host)) return json(response, 403, { error: "不接受跨站配置请求" });
            if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] || "")) return json(response, 415, { error: "请使用 JSON 请求" });
          }
          try { return await json(response, 200, await backend.handle(action, request.method, writing ? await body(request) : undefined), action === 'opportunities-v2' || (id === 'perpetual' && action === 'quote') ? request : undefined); }
          catch (error) { return json(response, error.status || (writing ? action.includes("test") ? 502 : 400 : 503), { error: writing ? error.message : "监控服务暂不可用" }); }
        }
        return json(response, 404, { error: '模块不支持此接口' });
      }
      // Compatibility for clients of the original Hynix endpoints.
      if (services && ["/api/quote", "/api/alerts", "/api/alerts/test"].includes(path)) {
        request.url = request.url.replace("/api/", "/api/monitors/hynix/");
        return createHandler({ services, username, password, nextHandler })(request, response);
      }
      if (path === "/api/quote" && request.method === "GET") {
        try { return json(response, 200, await service.quote()); }
        catch { return json(response, 503, { error: "实时行情暂不可用" }); }
      }
      if (services && path === "/api/market" && request.method === "GET") {
        request.url = "/api/monitors/hynix/history";
        return createHandler({ services, username, password, nextHandler })(request, response);
      }
      if (path === "/api/alerts" || path === "/api/alerts/test") {
        if (path === "/api/alerts" && request.method === "GET") return json(response, 200, service.view());
        const expected = path.endsWith("/test") ? "POST" : "PUT";
        if (request.method !== expected) return json(response, 405, { error: "不支持此请求方法。" });
        const origin = request.headers.origin;
        if (request.headers["sec-fetch-site"] === "cross-site" || (origin && new URL(origin).host !== request.headers.host)) return json(response, 403, { error: "不接受跨站配置请求。" });
        if (!request.headers["content-type"]?.startsWith("application/json")) return json(response, 415, { error: "请使用 JSON 请求。" });
        const input = await body(request);
        try {
          const result = path.endsWith("/test") ? await service.test() : await service.update(input);
          return json(response, 200, result);
        } catch (error) { return json(response, path.endsWith("/test") ? 502 : 400, { error: error.message }); }
      }
      try { await nextHandler(request, response); }
      catch {
        if (!response.destroyed && !response.headersSent) await json(response, 500, { error: '页面服务暂不可用' });
        else if (!response.destroyed) response.end();
      }
    } catch {
      if (!response.headersSent) json(response, 400, { error: "无法处理请求，请检查输入后重试。" });
      else response.end();
    }
  };
}
