"""Explicit stdio fixture: real engine/lifecycle, fake market, isolated runtime."""
import asyncio
import os
from pathlib import Path

from fastapi import Request
from starlette.routing import Mount

from trading.engine import Engine
from trading.paper import DemoMarket
from trading.server import create_app
from trading.store import Store

runtime = Path(os.environ["ASTER_TRADING_RUNTIME"])
engine = Engine(Store(runtime / "trading.sqlite3"), market=DemoMarket())
engine.notify = lambda: 5
original_start, original_stop = engine.start, engine.stop


def record(value):
    with (runtime / "lifecycle").open("a", encoding="utf-8") as handle:
        handle.write(value + "\n")


def start():
    original_start()
    record("startup")


def stop():
    original_stop()
    record("shutdown")


engine.start, engine.stop = start, stop
app = create_app(engine, workspace_secret=os.environ["ASTER_WORKSPACE_SECRET"])
app.router.routes = [route for route in app.router.routes if not isinstance(route, Mount)]


@app.get("/__fixture/inspect")
async def inspect(request: Request):
    return {"pid": os.getpid(), "managed": True, "runtime": str(runtime),
            "authorization": request.headers.get("authorization"),
            "publicOrigin": os.environ.get("ASTER_PUBLIC_ORIGIN"),
            "dashboard": os.environ["ASTER_DASHBOARD_DIR"]}


@app.get("/__fixture/slow")
async def slow():
    try:
        await asyncio.sleep(30)
    except asyncio.CancelledError:
        record("cancel")
        raise


@app.get("/__fixture/crash")
async def crash():
    os._exit(7)


@app.get("/__fixture/wait-shutdown")
def wait_shutdown():
    record("waiting")
    engine.shutdown.wait(15)
    return {"stopped": engine.shutdown.is_set()}
