"""A paused pair keeps its private stream for ADL after margin transfers settle."""
from unittest import TestCase
from unittest.mock import patch

from tests import test_account_stream_engine as engine_fixtures


class PausedTransferStreamTests(TestCase):
    setUp = engine_fixtures.AccountStreamEngineTests.setUp

    def test_paused_group_keeps_adl_stream_after_transfer_finishes_without_rest(self):
        row = self.f.store.account("test")
        row.update(enabled=False)
        self.f.store.save_account(row)
        pair = {"id": "gold", "enabled": False}
        self.f.store.put("pair_margin:gold", {"pending": {"status": "acknowledged"}})
        with patch.object(self.engine.pairs, "active_for_account", return_value=None), \
             patch.object(self.f.store, "pair_for_account", return_value=pair), \
             patch.object(self.broker, "stop_private_stream") as stop:
            self.assertEqual(self.engine.poll_private_stream("test"), 30)
            self.broker.start_private_stream.assert_called_once()
            stop.assert_not_called()
            self.assertFalse(self.f.store.account("test")["enabled"])
            self.f.store.put("pair_margin:gold", {})
            self.engine.poll_private_stream("test")
            stop.assert_not_called()
            # Paused groups still monitor ADL; only removing the binding and
            # leaving the independent account paused releases its stream.
            with patch.object(self.f.store, "pair_for_account", return_value=None):
                self.engine.poll_private_stream("test")
            stop.assert_called_once()
        self.api.call.assert_not_called()
