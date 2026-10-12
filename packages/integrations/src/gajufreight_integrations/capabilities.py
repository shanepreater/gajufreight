"""One port per third-party capability (ADR 0021).

A partner's adapter implements one or more of these. Services depend only on the
protocol, so changing provider never touches the code that uses it.
"""

from datetime import date
from typing import Protocol

from gajufreight_integrations.models import (
    CustomsDeclaration,
    CustomsStatus,
    Departure,
    Locode,
    SpaceConfirmation,
    SpaceRequest,
    TrackingEvent,
)


class SpaceBooking(Protocol):
    """Booking space directly with a carrier or booking platform."""

    def request_space(self, request: SpaceRequest) -> SpaceConfirmation:
        """Ask for space; the answer may still be only "requested"."""
        ...

    def cancel_space(self, booking_ref: str) -> SpaceConfirmation:
        """Release space held under a booking reference."""
        ...


class Schedules(Protocol):
    """Sailing and flight schedules between two places."""

    def departures(
        self, origin: Locode, destination: Locode, from_day: date
    ) -> list[Departure]:
        """Departures on or after ``from_day``, earliest first."""
        ...


class Tracking(Protocol):
    """Container or vessel tracking events; untrusted (hard rule 5)."""

    def events(self, reference: str) -> list[TrackingEvent]:
        """Every event the partner holds for a container or booking reference."""
        ...


class CustomsFiling(Protocol):
    """Submitting and following customs declarations through a partner."""

    def submit(self, declaration: CustomsDeclaration) -> CustomsStatus:
        """Hand a declaration to the partner."""
        ...

    def status(self, reference: str) -> CustomsStatus:
        """Where a submitted declaration stands."""
        ...
