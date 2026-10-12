"""Placeholders for every capability until a partner is configured (ADR 0021).

Each refuses its calls with ``IntegrationNotConfiguredError`` naming the capability,
so a service that reaches for an integration that doesn't exist yet fails clearly
instead of pretending it worked.
"""

from dataclasses import dataclass, field
from datetime import date
from typing import Never

from gajufreight_integrations.capabilities import (
    CapacityBooking,
    CustomsFiler,
    Schedules,
    Tracking,
)
from gajufreight_integrations.models import (
    CustomsFiling,
    CustomsStatus,
    Locode,
    Sailing,
    SpaceBooking,
    SpaceRequest,
    TrackingEvent,
)


class IntegrationNotConfiguredError(RuntimeError):
    """Raised when a capability is used before a partner's adapter is configured."""

    def __init__(self, capability: str) -> None:
        """Name the capability so the error says what's missing."""
        super().__init__(f"no partner is configured for {capability} (ADR 0021)")
        self.capability = capability


def _refuse(capability: str) -> Never:
    raise IntegrationNotConfiguredError(capability)


class NotConfiguredCapacity:
    """``CapacityBooking`` with no partner yet."""

    def request_space(self, request: SpaceRequest) -> SpaceBooking:
        """Refuse: no carrier-booking partner."""
        _refuse("capacity booking")

    def cancel_space(self, booking_ref: str) -> SpaceBooking:
        """Refuse: no carrier-booking partner."""
        _refuse("capacity booking")


class NotConfiguredSchedules:
    """``Schedules`` with no partner yet."""

    def sailings(
        self, origin: Locode, destination: Locode, from_day: date
    ) -> list[Sailing]:
        """Refuse: no schedules partner."""
        _refuse("schedules")


class NotConfiguredTracking:
    """``Tracking`` with no partner yet."""

    def events(self, reference: str) -> list[TrackingEvent]:
        """Refuse: no tracking partner."""
        _refuse("tracking")


class NotConfiguredCustoms:
    """``CustomsFiler`` with no partner yet."""

    def submit(self, filing: CustomsFiling) -> CustomsStatus:
        """Refuse: no customs partner."""
        _refuse("customs filing")

    def status(self, reference: str) -> CustomsStatus:
        """Refuse: no customs partner."""
        _refuse("customs filing")


@dataclass(frozen=True)
class Integrations:
    """The adapters a service is given, one per capability; placeholders by default.

    A service receives this through dependency injection, so configuring a partner
    means passing its adapter here and nothing else changes.
    """

    capacity: CapacityBooking = field(default_factory=NotConfiguredCapacity)
    schedules: Schedules = field(default_factory=NotConfiguredSchedules)
    tracking: Tracking = field(default_factory=NotConfiguredTracking)
    customs: CustomsFiler = field(default_factory=NotConfiguredCustoms)
