"""Historical pair journal shapes used to exercise upgrade compatibility."""
from trading.pair_execution import runtime_default as current_runtime


def empty_progress(owned=None, completed=0):
    return {"phase": "waiting_open", "baseline": dict(owned or {"LONG": "0", "SHORT": "0"}),
            "quantities": {"LONG": "0", "SHORT": "0"}, "completed_cycles": completed}


def runtime_default():
    return {**current_runtime(), "progress": empty_progress()}
