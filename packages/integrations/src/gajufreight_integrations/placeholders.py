"""Placeholders for every capability until a partner is configured (ADR 0021).

Each refuses its calls with ``IntegrationNotConfiguredError`` naming the capability,
so a service that reaches for an integration that doesn't exist yet fails clearly
instead of pretending it worked.
"""

from dataclasses import dataclass, field
from datetime import date
from typing import Never

from gajufreight_integrations.capabilities import (
    CustomsFiling,
    Schedules,
    SpaceBooking,
    Tracking,
)
from gajufreight_integrations.models import (
    CustomsDeclaration,
    CustomsStatus,
    Departure,
    Locode,
    SpaceConfirmation,
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


class NotConfiguredSpaceBooking:
    """``SpaceBooking`` with no partner yet."""

    def request_space(self, request: SpaceRequest) -> SpaceConfirmation:
        """Refuse: no carrier-booking partner."""
        _refuse("space booking")

    def cancel_space(self, booking_ref: str) -> SpaceConfirmation:
        """Refuse: no carrier-booking partner."""
        _refuse("space booking")


class NotConfiguredSchedules:
    """``Schedules`` with no partner yet."""

    def departures(
        self, origin: Locode, destination: Locode, from_day: date
    ) -> list[Departure]:
        """Refuse: no schedules partner."""
        _refuse("schedules")


class NotConfiguredTracking:
    """``Tracking`` with no partner yet."""

    def events(self, reference: str) -> list[TrackingEvent]:
        """Refuse: no tracking partner."""
        _refuse("tracking")


class NotConfiguredCustomsFiling:
    """``CustomsFiling`` with no partner yet."""

    def submit(self, declaration: CustomsDeclaration) -> CustomsStatus:
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

    space: SpaceBooking = field(default_factory=NotConfiguredSpaceBooking)
    schedules: Schedules = field(default_factory=NotConfiguredSchedules)
    tracking: Tracking = field(default_factory=NotConfiguredTracking)
    customs: CustomsFiling = field(default_factory=NotConfiguredCustomsFiling)
