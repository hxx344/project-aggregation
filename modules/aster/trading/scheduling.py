"""One owner for each account's transient scheduling state."""
from dataclasses import dataclass, field


class PollBackoff(float):
    """A failed poll waits from completion, independently of sampling cadence."""


@dataclass
class AccountWork:
    wake: bool = False
    urgent: bool = False
    priority: dict = field(default_factory=dict)
    priority_levels: dict = field(default_factory=dict)
    followup: bool = False
    leverage_followup: bool = False
    active_leverage_followup: bool = False
    ordinary_priority_after: float = 0
    ordinary_priority_retry: bool = False
    capacity_available: dict = field(default_factory=dict)
    active_priority: bool = False
    active_signals: dict = field(default_factory=dict)
    backoff: float = 0
    stream_wake: bool = False
    stream_backoff: float = 0

    def take_priority(self):
        signals, self.priority = self.priority, {}
        return signals

    def take_active_signals(self):
        signals, self.active_signals = self.active_signals, {}
        return signals

    def start_priority(self):
        self.active_signals = self.take_priority()
        self.active_leverage_followup = self.leverage_followup
        self.leverage_followup = False
        self.followup = False
        self.active_priority = True
