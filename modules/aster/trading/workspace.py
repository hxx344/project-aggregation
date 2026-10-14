"""Managed ASGI entrypoint; never starts a TCP server or independent login."""
import os

from .server import create_app

secret = os.environ.get("ASTER_WORKSPACE_SECRET")
if not secret:
    raise RuntimeError("ASTER must be launched by the workspace worker")
app = create_app(workspace_secret=secret)
