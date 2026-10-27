"""Undiscounted Black-76, the model behind Deribit option marks."""
import math

YEAR_SECONDS = 365 * 86400


def black(forward, strike, years, iv, is_call):
    """USD price and delta of one option on `forward` (puts have negative delta)."""
    if years <= 0 or iv <= 0:
        itm = forward > strike if is_call else forward < strike
        return payoff(forward, strike, is_call), (1.0 if is_call else -1.0) if itm else 0.0
    sd = iv * math.sqrt(years)
    d1 = math.log(forward / strike) / sd + sd / 2
    n1 = 0.5 * math.erfc(-d1 / math.sqrt(2))
    n2 = 0.5 * math.erfc(-(d1 - sd) / math.sqrt(2))
    call = forward * n1 - strike * n2
    return (call, n1) if is_call else (call - forward + strike, n1 - 1)


def payoff(settlement, strike, is_call):
    return max(0.0, settlement - strike) if is_call else max(0.0, strike - settlement)
