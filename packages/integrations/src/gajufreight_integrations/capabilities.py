"""One port per third-party capability (ADR 0021).

A partner's adapter implements one or more of these. Services depend only on the
protocol, so changing provider never touches the code that uses it.
"""

from datetime import date
from typing import Protocol, runtime_checkable

from gajufreight_integrations.models import (
    CustomsFiling,
    CustomsStatus,
    Locode,
    Sailing,
    SpaceBooking,
    SpaceRequest,
    TrackingEvent,
)


@runtime_checkable
class CapacityBooking(Protocol):
    """Booking space directly with a carrier or booking platform."""

    def request_space(self, request: SpaceRequest) -> SpaceBooking:
        """Ask for space; the answer may still be only "requested"."""
        ...

    def cancel_space(self, booking_ref: str) -> SpaceBooking:
        """Release space held under a booking reference."""
        ...


@runtime_checkable
class Schedules(Protocol):
    """Sailing and flight schedules between two places."""

    def sailings(
        self, origin: Locode, destination: Locode, from_day: date
    ) -> list[Sailing]:
        """Departures on or after ``from_day``, earliest first."""
        ...


@runtime_checkable
class Tracking(Protocol):
    """Container or vessel tracking events; untrusted (hard rule 5)."""

    def events(self, reference: str) -> list[TrackingEvent]:
        """Every event the partner holds for a container or booking reference."""
        ...


@runtime_checkable
class CustomsFiler(Protocol):
    """Submitting and following customs filings through a partner."""

    def submit(self, filing: CustomsFiling) -> CustomsStatus:
        """Hand a filing to the partner."""
        ...

    def status(self, reference: str) -> CustomsStatus:
        """Where a submitted filing stands."""
        ...
