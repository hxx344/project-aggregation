import asyncio
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import httpx

from app.config import Settings
from app.engine import TradingEngine
from app.trade_tasks import TradeConflict
from app.workspace import update_status


class WorkspaceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.engine = TradingEngine(Settings(_env_file=None, state_file=self.directory.name + "/state.json", auto_open=True))

    async def asyncTearDown(self):
        await self.engine.client.close()
        self.directory.cleanup()

    async def test_maintenance_blocks_admission_and_scheduler_without_changing_saved_strategy(self):
        engine = self.engine
        engine.workspace_maintenance = True
        with self.assertRaisesRegex(TradeConflict, "Workspace update"):
            engine._admit_trading_operation()
        engine.prepare_trade_plan = AsyncMock()
        engine.start_trade_task = AsyncMock()
        with patch.object(engine, "is_open_window", return_value=True), patch("app.engine.asyncio.sleep", new=AsyncMock(side_effect=asyncio.CancelledError)):
            with self.assertRaises(asyncio.CancelledError):
                await engine.scheduler()
        engine.prepare_trade_plan.assert_not_awaited()
        engine.start_trade_task.assert_not_awaited()
        self.assertTrue(engine.settings.auto_open)
        engine.workspace_maintenance = False
        engine._admit_trading_operation()
        self.assertTrue(engine._trade_admitting)

    async def test_worker_startup_inherits_maintenance_before_scheduler_runs(self):
        with patch.dict(os.environ, {"WORKSPACE_MAINTENANCE": "1"}):
            engine = TradingEngine(self.engine.settings)
        try:
            self.assertTrue(engine.workspace_maintenance)
            self.assertTrue(engine.settings.auto_open)
        finally:
            await engine.client.close()

    async def test_maintenance_route_preserves_origin_check_and_rejects_non_boolean(self):
        from app.main import app
        with patch("app.main.engine", self.engine), patch("app.main.settings", self.engine.settings):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost") as client:
                denied = await client.post("/__workspace/maintenance", json={"active": True}, headers={"Origin": "http://hostile.example"})
                self.assertEqual(denied.status_code, 403)
                self.assertFalse(self.engine.workspace_maintenance)
                invalid = await client.post("/__workspace/maintenance", json={"active": "false"})
                self.assertEqual(invalid.status_code, 422)
                active = await client.post("/__workspace/maintenance", json={"active": True})
                self.assertEqual(active.status_code, 200)
                self.assertEqual(active.json(), {"active": True, "busy": False})
                blocked = await client.post("/api/trading/plans", json={"operation": "open"})
                self.assertEqual(blocked.status_code, 409)
                restored = await client.post("/__workspace/maintenance", json={"active": False})
                self.assertEqual(restored.json(), {"active": False, "busy": False})

    async def test_update_gate_allows_reconciled_positions_but_blocks_unresolved_work(self):
        engine = self.engine
        self.assertEqual(update_status(engine), {"busy": False})
        engine.active_strategy_symbols.add("BTC-TRACKED")
        self.assertTrue(update_status(engine)["busy"])
        engine.reconciliation_last_success = datetime.now(timezone.utc)
        self.assertEqual(update_status(engine), {"busy": False})
        engine.workspace_maintenance = True
        engine.execution_groups["existing"] = {"execution_status": "recovering"}
        self.assertTrue(update_status(engine)["busy"])
        self.assertEqual(engine.execution_groups["existing"]["execution_status"], "recovering")
        engine.execution_groups.clear()
        engine.order_journal["pending"] = {"terminal": False}
        self.assertTrue(update_status(engine)["busy"])
        engine.order_journal["pending"]["terminal"] = True
        self.assertEqual(update_status(engine), {"busy": False})
        engine.reconciliation_last_success -= timedelta(minutes=5)
        self.assertTrue(update_status(engine)["busy"])


if __name__ == "__main__":
    unittest.main()
