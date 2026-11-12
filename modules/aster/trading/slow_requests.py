"""Slow-request diagnostics: log where the process is when an HTTP request stalls.

The dashboard gives up on a state read after 10 seconds and shows the desk as
disconnected. These logs name the stalled path and the code each relevant
thread is executing at that moment, so an intermittent stall can be traced
from the service journal. Only file, line and function names are logged; no
locals, arguments, headers or query strings.
"""
import logging
import os
import sys
import threading
import time
import traceback

import anyio.to_thread

log = logging.getLogger("aster.slow_requests")

SLOW_SECONDS = 3.0
STALL_SECONDS = 8.0
DUMP_INTERVAL_SECONDS = 60.0
PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__)) + os.sep


def _frame(entry):
    return f"{os.path.basename(entry.filename)}:{entry.lineno} {entry.name}"


def thread_stacks(frames=None, threads=None):
    """One line per thread running package code, plus the event-loop thread.

    Each line keeps the last few package frames and the innermost frame (where
    the thread is actually waiting), e.g. a lock acquire or a socket read.
    """
    frames = sys._current_frames() if frames is None else frames
    names = {thread.ident: thread.name for thread in (threading.enumerate() if threads is None else threads)}
    main, current = threading.main_thread().ident, threading.get_ident()
    lines, idle = [], 0
    for ident, frame in frames.items():
        if ident == current:
            continue  # The watchdog itself.
        stack = traceback.extract_stack(frame)
        own = [entry for entry in stack if entry.filename.startswith(PACKAGE_DIR)]
        if not own and ident != main:
            idle += 1
            continue
        shown = own[-5:]
        if stack and (not shown or stack[-1] is not shown[-1]):
            shown.append(stack[-1])
        lines.append(f"{names.get(ident, ident)}: " + " > ".join(_frame(entry) for entry in shown))
    lines.append(f"其他线程 {idle} 个（未在执行交易模块代码）")
    return lines


class SlowRequestMonitor:
    """ASGI middleware; a watchdog thread runs only while requests are in flight."""

    def __init__(self, app, *, slow_seconds=SLOW_SECONDS, stall_seconds=STALL_SECONDS,
                 dump_interval=DUMP_INTERVAL_SECONDS, poll_seconds=1.0, clock=time.monotonic, stacks=thread_stacks):
        self.app = app
        self.slow_seconds = slow_seconds
        self.stall_seconds = stall_seconds
        self.dump_interval = dump_interval
        self.poll_seconds = poll_seconds
        self.clock = clock
        self.stacks = stacks
        self.lock = threading.Lock()
        self.active = {}
        self.watchdog = None
        self.last_dump = float("-inf")

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        try:
            busy = anyio.to_thread.current_default_thread_limiter().borrowed_tokens
        except Exception:
            busy = None
        token, started, status = object(), self.clock(), [None]
        request = {"method": scope.get("method", ""), "path": scope.get("path", ""),
                   "started": started, "busy": busy, "reported": False}

        async def tracked_send(message):
            if message["type"] == "http.response.start":
                status[0] = message.get("status")
            await send(message)

        with self.lock:
            self.active[token] = request
            if self.watchdog is None:
                self.watchdog = threading.Thread(target=self._watch, name="slow-request-watchdog", daemon=True)
                self.watchdog.start()
        try:
            await self.app(scope, receive, tracked_send)
        finally:
            with self.lock:
                self.active.pop(token, None)
            elapsed = self.clock() - started
            if elapsed >= self.slow_seconds:
                log.warning("慢请求 %s %s 状态 %s 用时 %.1f 秒（开始时线程池占用 %s）",
                            request["method"], request["path"], status[0], elapsed, busy)

    def check(self):
        """Log requests newly past the stall threshold, with thread positions at most once per interval."""
        now = self.clock()
        with self.lock:
            stalled = [request for request in self.active.values()
                       if not request["reported"] and now - request["started"] >= self.stall_seconds]
            for request in stalled:
                request["reported"] = True
            in_flight = len(self.active)
            dump = bool(stalled) and now - self.last_dump >= self.dump_interval
            if dump:
                self.last_dump = now
        for request in stalled:
            log.warning("请求停滞 %s %s 已 %.1f 秒未完成（进行中 %d 个，开始时线程池占用 %s）",
                        request["method"], request["path"], now - request["started"], in_flight, request["busy"])
        if dump:
            try:
                log.warning("请求停滞时的线程位置：\n%s", "\n".join(self.stacks()))
            except Exception:
                log.exception("记录线程位置失败")

    def _watch(self):
        while True:
            time.sleep(self.poll_seconds)
            try:
                self.check()
            except Exception:
                log.exception("慢请求诊断失败")
            with self.lock:
                if not self.active:
                    self.watchdog = None
                    return
