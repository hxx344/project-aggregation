import asyncio
import threading
import unittest

from trading import slow_requests
from trading.slow_requests import SlowRequestMonitor, thread_stacks


class Clock:
    def __init__(self):
        self.value = 100.0

    def __call__(self):
        return self.value


def scope(path="/api/state"):
    return {"type": "http", "method": "GET", "path": path, "query_string": b"compact=true", "headers": []}


class SlowRequestMonitorTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.dumps = 0

    def monitor(self, app, **options):
        def stacks():
            self.dumps += 1
            return ["MainThread: engine.py:1 state"]
        return SlowRequestMonitor(app, clock=self.clock, stacks=stacks, poll_seconds=0.01, **options)

    def test_stalled_request_is_reported_once_and_stack_dump_is_rate_limited(self):
        release, entered = asyncio.Event(), []

        async def app(scope, receive, send):
            entered.append(scope["path"])
            await release.wait()
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"{}"})

        async def noop(message):
            pass

        async def run():
            monitor = self.monitor(app)
            first = asyncio.create_task(monitor(scope(), None, noop))
            second = asyncio.create_task(monitor(scope("/api/hub/summary"), None, noop))
            while len(entered) < 2:
                await asyncio.sleep(0)
            with self.assertLogs("aster.slow_requests", "WARNING") as logs:
                self.clock.value += 7.9
                monitor.check()
                self.assertEqual(logs.output, [])
                self.clock.value += 0.2
                monitor.check()
                monitor.check()
                release.set()
                await asyncio.gather(first, second)
            return logs.output

        output = asyncio.run(run())
        stalled = [line for line in output if "请求停滞 GET" in line]
        self.assertEqual(len(stalled), 2)
        self.assertTrue(any("/api/state 已 8.1 秒" in line and "进行中 2 个" in line for line in stalled))
        self.assertEqual(self.dumps, 1)
        finished = [line for line in output if "慢请求 GET" in line]
        self.assertEqual(len(finished), 2)
        self.assertTrue(any("/api/state 状态 200 用时 8.1 秒" in line for line in finished))
        self.assertFalse(any("compact" in line for line in output))

    def test_fast_request_logs_nothing_and_watchdog_exits(self):
        async def app(scope, receive, send):
            await send({"type": "http.response.start", "status": 204, "headers": []})

        async def noop(message):
            pass

        monitor = self.monitor(app)
        with self.assertNoLogs("aster.slow_requests", "WARNING"):
            asyncio.run(monitor(scope(), None, noop))
            watchdog = monitor.watchdog
            if watchdog is not None:
                watchdog.join(2)
                self.assertFalse(watchdog.is_alive())
        self.assertIsNone(monitor.watchdog)
        self.assertEqual(self.dumps, 0)

    def test_thread_stacks_name_the_package_frame_and_the_wait(self):
        lock, ready = threading.Lock(), threading.Event()
        lock.acquire()

        def blocked():
            ready.set()
            with lock:
                pass

        # Attribute the waiting function to the package so it counts as package code.
        blocked.__code__ = blocked.__code__.replace(co_filename=slow_requests.__file__)
        worker = threading.Thread(target=blocked, name="AnyIO worker thread")
        worker.start()
        try:
            ready.wait(2)
            # Called from a watchdog-like thread, which leaves itself out.
            result = []
            caller = threading.Thread(target=lambda: result.append(thread_stacks()), name="caller")
            caller.start()
            caller.join(2)
            lines = result[0]
        finally:
            lock.release()
            worker.join(2)
        line = next(line for line in lines if line.startswith("AnyIO worker thread: "))
        self.assertIn("slow_requests.py:", line)
        self.assertIn(" blocked", line)
        self.assertTrue(any(line.startswith("MainThread: ") for line in lines))
        self.assertFalse(any(line.startswith("caller: ") for line in lines))
        self.assertTrue(lines[-1].startswith("其他线程 "))


if __name__ == "__main__":
    unittest.main()
