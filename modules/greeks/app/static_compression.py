"""Compress fixed dashboard code without transforming account/API responses."""

from starlette.middleware.gzip import GZipMiddleware


def accepts_gzip(value):
    qualities = {}
    for item in value.lower().split(","):
        name, *parameters = item.strip().split(";")
        try:
            quality = next((float(part.strip()[2:]) for part in parameters if part.strip().startswith("q=")), 1.0)
        except ValueError:
            quality = 0.0
        qualities[name.strip()] = quality if 0 <= quality <= 1 else 0.0
    return qualities.get("gzip", qualities.get("*", 0.0)) > 0


class StaticCompressionMiddleware:
    def __init__(self, app):
        self.app = app
        self.compressed = GZipMiddleware(app, minimum_size=1024, compresslevel=4)

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "")
        headers = dict(scope.get("headers", []))
        static = path == "/" or path.startswith("/static/") and path.endswith((".js", ".css", ".html"))
        if (scope["type"] != "http" or scope.get("method") != "GET" or not static
                or b"range" in headers or b"if-range" in headers
                or not accepts_gzip(headers.get(b"accept-encoding", b"").decode("latin-1"))):
            return await self.app(scope, receive, send)

        async def encoded_send(message):
            if message["type"] == "http.response.start":
                values = dict(message["headers"])
                if values.get(b"content-encoding") == b"gzip":
                    # Compression changes the representation, not the file.
                    message["headers"] = [(key, b"W/" + value if key == b"etag" and value.startswith(b'"') else value)
                                          for key, value in message["headers"] if key != b"accept-ranges"]
            await send(message)

        # Normalize a negotiated wildcard as well; the stock middleware only
        # checks for the literal gzip token, rather than parsing quality values.
        encoded_scope = {**scope, "headers": [(key, value) for key, value in scope["headers"] if key != b"accept-encoding"]
                         + [(b"accept-encoding", b"gzip")]}
        await self.compressed(encoded_scope, receive, encoded_send)
