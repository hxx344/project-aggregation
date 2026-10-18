"""Authenticated ASGI protocol fixture; no exchange or external network."""
import json
import os


async def app(scope, receive, send):
    if scope["type"] == "lifespan":
        while True:
            event = await receive()
            if event["type"] == "lifespan.startup":
                await send({"type": "lifespan.startup.complete"})
            elif event["type"] == "lifespan.shutdown":
                await send({"type": "lifespan.shutdown.complete"})
                return
    headers = dict(scope["headers"])
    authenticated = headers.get(b"x-fixture-private") == b"trusted-parent"
    status = json.loads(os.environ["FIXTURE_WRITER_STATUS"])
    payload = json.dumps(status).encode()
    await send({"type": "http.response.start", "status": 200 if authenticated else 403,
                "headers": [(b"content-type", b"application/json")]})
    await send({"type": "http.response.body", "body": payload})
