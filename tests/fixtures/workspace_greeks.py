"""Network-free ASGI fixture for the managed stdio transport."""
import asyncio
import json
import os
from pathlib import Path


def record(value):
    with Path(os.environ["STATE_FILE"] + ".lifecycle").open("a", encoding="utf-8") as stream:
        stream.write(value + "\n")


async def app(scope, receive, send):
    if scope["type"] == "lifespan":
        while True:
            message = await receive()
            if message["type"] == "lifespan.startup":
                record("startup")
                scope["state"]["ready"] = True
                await send({"type": "lifespan.startup.complete"})
            elif message["type"] == "lifespan.shutdown":
                record("shutdown")
                await send({"type": "lifespan.shutdown.complete"})
                return
    if scope["path"] == "/crash":
        os._exit(7)
    if scope["path"] in {"/slow", "/concurrent"}:
        try:
            await asyncio.sleep(2 if scope["path"] == "/slow" else 0.15)
        except asyncio.CancelledError:
            record("cancel")
            raise
    event = await receive()
    headers = dict(scope["headers"])
    import base64
    expected = "Basic " + base64.b64encode(("workspace:" + os.environ["DASHBOARD_PASSWORD"]).encode()).decode()
    payload = json.dumps({"ready": scope["state"]["ready"], "authenticated": headers.get(b"authorization", b"").decode() == expected,
                          "origin": headers.get(b"origin", b"").decode(), "scheme": scope["scheme"],
                          "body": event["body"].decode(), "query": scope["query_string"].decode(),
                          "private_key_forwarded": b"x-workspace-key" in headers}).encode()
    await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"application/json")]})
    await send({"type": "http.response.body", "body": payload})
