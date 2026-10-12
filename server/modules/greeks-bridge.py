"""ASGI over private parent stdio; never creates a network listener."""
import asyncio
import base64
import importlib
import json
import sys
from urllib.parse import unquote, urlsplit

PROTOCOL = sys.stdout.buffer
sys.stdout = sys.stderr
MAX_REQUEST = 1024 * 1024
MAX_RESPONSE = 16 * 1024 * 1024
MAX_LINE = 2 * MAX_REQUEST


def emit(value):
    PROTOCOL.write(json.dumps(value, separators=(",", ":")).encode() + b"\n")
    PROTOCOL.flush()


async def serve(app):
    incoming = asyncio.Queue()
    outgoing = asyncio.Queue()
    state = {}
    tasks = {}
    lifecycle = asyncio.create_task(app({"type": "lifespan", "asgi": {"version": "3.0", "spec_version": "2.0"}, "state": state}, incoming.get, outgoing.put))

    async def transition(kind):
        await incoming.put({"type": "lifespan." + kind})
        message_task = asyncio.create_task(outgoing.get())
        try:
            completed, _ = await asyncio.wait({message_task, lifecycle}, timeout=90, return_when=asyncio.FIRST_COMPLETED)
            if message_task not in completed or message_task.result().get("type") != "lifespan." + kind + ".complete":
                raise RuntimeError("ASGI lifespan did not complete")
        finally:
            if not message_task.done():
                message_task.cancel()
                await asyncio.gather(message_task, return_exceptions=True)

    async def request(message):
        identifier = message["id"]
        disconnected = asyncio.Event()
        received = False
        body = base64.b64decode(message.get("body", ""), validate=True)
        if len(body) > MAX_REQUEST:
            raise ValueError("Request too large")
        url = urlsplit(message["url"])
        chunks = []
        size = 0
        status = None
        headers = []
        finished = False

        async def receive():
            nonlocal received
            if not received:
                received = True
                return {"type": "http.request", "body": body, "more_body": False}
            await disconnected.wait()
            return {"type": "http.disconnect"}

        async def send(event):
            nonlocal size, status, headers, finished
            if event["type"] == "http.response.start":
                if status is not None:
                    raise RuntimeError("Duplicate response start")
                status = event["status"]
                headers = [[key.decode("latin-1"), value.decode("latin-1")] for key, value in event.get("headers", [])]
            elif event["type"] == "http.response.body":
                if status is None or finished:
                    raise RuntimeError("Invalid response body")
                chunk = event.get("body", b"")
                size += len(chunk)
                if size > MAX_RESPONSE:
                    raise ValueError("Response too large")
                chunks.append(chunk)
                finished = not event.get("more_body", False)

        scope = {"type": "http", "asgi": {"version": "3.0", "spec_version": "2.4"},
                 "http_version": "1.1", "method": message["method"], "scheme": message["scheme"],
                 "path": unquote(url.path), "raw_path": url.path.encode("ascii"), "query_string": url.query.encode("ascii"),
                 "root_path": "", "headers": [(key.encode("latin-1"), value.encode("latin-1")) for key, value in message["headers"]],
                 "server": ("workspace.internal", 80), "client": ("127.0.0.1", 0), "state": state.copy()}
        try:
            await app(scope, receive, send)
            if not finished:
                raise RuntimeError("Incomplete response")
            emit({"type": "response", "id": identifier, "status": status, "headers": headers,
                  "body": base64.b64encode(b"".join(chunks)).decode("ascii")})
        except asyncio.CancelledError:
            disconnected.set()
            raise
        except Exception as exc:
            print("ASGI request failed:", type(exc).__name__, file=sys.stderr)
            emit({"type": "error", "id": identifier})
        finally:
            tasks.pop(identifier, None)

    started = False
    try:
        await transition("startup")
        started = True
        emit({"type": "ready"})
        while True:
            line = await asyncio.to_thread(sys.stdin.buffer.readline, MAX_LINE + 1)
            if not line:
                break
            if len(line) > MAX_LINE or not line.endswith(b"\n"):
                raise ValueError("Invalid protocol frame")
            message = json.loads(line)
            kind = message.get("type")
            if kind == "shutdown":
                break
            if kind == "cancel":
                task = tasks.get(message.get("id"))
                if task:
                    task.cancel()
            elif kind == "request":
                identifier = message["id"]
                if not isinstance(identifier, int) or identifier in tasks or len(tasks) >= 64:
                    raise ValueError("Invalid request inventory")
                tasks[identifier] = asyncio.create_task(request(message))
            else:
                raise ValueError("Invalid protocol operation")
    finally:
        pending = list(tasks.values())
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        if started:
            await transition("shutdown")
        if not lifecycle.done():
            lifecycle.cancel()
        await asyncio.gather(lifecycle, return_exceptions=True)
    emit({"type": "closed"})


if __name__ == "__main__":
    # Test fixtures may select an import through an explicit process argument;
    # production always passes app.main:app from the managed adapter.
    module, name = (sys.argv[1] if len(sys.argv) > 1 else "app.main:app").split(":", 1)
    try:
        asyncio.run(serve(getattr(importlib.import_module(module), name)))
    except Exception as exc:
        print("Greeks bridge failed:", type(exc).__name__, file=sys.stderr)
        sys.exit(1)
