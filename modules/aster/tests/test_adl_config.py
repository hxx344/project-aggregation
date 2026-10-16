"""ADL execution settings reject ambiguous numeric and boolean inputs."""
from copy import deepcopy
import unittest

from trading.adl_config import DEFAULT_ADL, validate_adl
from trading.models import TradingError


class AdlConfigTests(unittest.TestCase):
    def test_legacy_and_partial_settings_return_independent_defaults(self):
        for value in (None, {}):
            result = validate_adl(value)
            self.assertEqual(result, {"enabled": True, "batch_notional": "1000"})
            result["enabled"] = False
            self.assertTrue(DEFAULT_ADL["enabled"])
        self.assertEqual(validate_adl({"enabled": False}), {"enabled": False, "batch_notional": "1000"})

    def test_amounts_are_exact_canonical_decimal_strings_without_mutating_input(self):
        for raw, expected in (("00001.000", "1"), ("1000000.0000", "1000000"),
                              ("00123.4500", "123.45"), ("1.000000000000000000000000000001", "1.000000000000000000000000000001")):
            with self.subTest(value=raw):
                supplied = {"enabled": False, "batch_notional": raw}
                original = deepcopy(supplied)
                self.assertEqual(validate_adl(supplied)["batch_notional"], expected)
                self.assertEqual(supplied, original)

    def test_non_boolean_enabled_and_unknown_fields_are_rejected(self):
        for value in ("false", "true", 0, 1, None, [], {}):
            with self.subTest(value=value), self.assertRaises(TradingError):
                validate_adl({"enabled": value})
        for value in (False, [], "", 1, {"unknown": True}, {"enabled": True, "limit": "100"}):
            with self.subTest(value=value), self.assertRaises(TradingError):
                validate_adl(value)

    def test_non_plain_decimal_values_and_out_of_range_amounts_are_rejected(self):
        invalid = (None, True, 1000, 1.5, "", " 1", "1 ", "1\n", "+1", "-1", "1e3", "1E3", ".5", "1.",
                   "NaN", "Infinity", "١٠٠٠", "１０００", "1,000", "0", "0.999999999999999999999999999999",
                   "1000000.000000000000000000000001", "1000001", "0" * 40 + "1")
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(TradingError):
                validate_adl({"batch_notional": value})


if __name__ == "__main__":
    unittest.main()
