"""Optional per-call observations; never shared across account worker threads."""
from contextlib import contextmanager
from contextvars import ContextVar
import math
from time import perf_counter, time


_transport = ContextVar("transport_timing", default=None)


def _clock():
    try:
        return perf_counter()
    except Exception:
        return None


def _elapsed(start):
    try:
        duration = (perf_counter() - start) * 1000
        return duration if math.isfinite(duration) and duration >= 0 else None
    except Exception:
        return None


@contextmanager
def observe_transport(data):
    token = _transport.set((data, _clock()))
    try:
        yield
    finally:
        _transport.reset(token)


@contextmanager
def transport_stage(key):
    observed = _transport.get()
    if observed is None:
        yield
        return
    data, overall = observed
    started = _clock()
    if key == "http_ms":
        try:
            data["http_started_at"] = time()
            data["before_http_ms"] = _elapsed(overall)
        except Exception:
            pass
    try:
        yield
    finally:
        duration = _elapsed(started)
        data[key] = duration
        if key == "http_ms":
            try:
                data["http_finished_at"] = time()
            except Exception:
                pass
