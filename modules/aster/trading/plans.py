"""Shared immutable plan for equal-quantity paired orders."""
from dataclasses import dataclass
from decimal import Decimal


@dataclass(frozen=True)
class TradePlan:
    phase: str
    symbol: str
    qty: Decimal
    leverage: int
    long_notional: Decimal
    short_notional: Decimal
    spread_bp: Decimal
    projected_ratio: Decimal | None = None
    capacity_notional: Decimal | None = None
