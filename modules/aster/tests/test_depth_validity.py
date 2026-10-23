"""Shared depth snapshots never outlive their revocation or monotonic age."""
from fractions import Fraction
import threading
import time
from unittest import TestCase
from unittest.mock import patch

from trading.depth import DEPTH_MAX_AGE, DepthSnapshot
from trading.models import TradingError


class SharedDepthValidityTests(TestCase):
    def test_revocation_invalidates_an_already_returned_snapshot(self):
        connected = threading.Event()
        connected.set()
        snapshot = DepthSnapshot(
            ((Fraction(99), Fraction(100)),),
            ((Fraction(100), Fraction(100)),),
            time.time(), monotonic_timestamp=time.monotonic(),
            validity=connected.is_set,
        )
        snapshot.require_fresh()
        connected.clear()
        with self.assertRaises(TradingError):
            snapshot.require_fresh()

    def test_monotonic_expiry_cannot_be_reset_by_a_recent_wall_timestamp(self):
        snapshot = DepthSnapshot(
            ((Fraction(99), Fraction(100)),),
            ((Fraction(100), Fraction(100)),),
            100, monotonic_timestamp=1000,
        )
        with patch("trading.depth.time.monotonic", return_value=1000 + DEPTH_MAX_AGE):
            self.assertEqual(snapshot.age(100), DEPTH_MAX_AGE)
            snapshot.require_fresh(100)
        with patch("trading.depth.time.monotonic", return_value=1000 + DEPTH_MAX_AGE + .001):
            with self.assertRaises(TradingError):
                snapshot.require_fresh(100)
