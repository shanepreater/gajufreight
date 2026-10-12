"""What crosses the integration boundary (ADR 0021).

Models are immutable and reject unknown fields: a partner's adapter maps its own
format onto these, so a change on the partner's side fails loudly at the adapter
rather than leaking into GajuFreight. Places are UN/LOCODEs, as on-chain.
"""

from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

Locode = Annotated[str, Field(pattern=r"^[A-Z]{2}[A-Z2-9]{3}$")]
Mode = Literal["ocean", "air", "road"]


class BoundaryModel(BaseModel):
    """Base for integration data: immutable, unknown fields refused."""

    model_config = ConfigDict(frozen=True, extra="forbid")


class SpaceRequest(BoundaryModel):
    """Space a forwarder asks a carrier for on one shipment's leg."""

    shipment_id: str
    mode: Mode
    origin: Locode
    destination: Locode
    ready_by: date
    containers: int = Field(gt=0)


class SpaceBooking(BoundaryModel):
    """A carrier's answer: an off-chain record that never moves money."""

    provider: str
    booking_ref: str
    status: Literal["requested", "confirmed", "cancelled"]
    vessel: str | None = None


class Sailing(BoundaryModel):
    """One scheduled sailing or flight between two places."""

    provider: str
    mode: Mode
    origin: Locode
    destination: Locode
    departs: datetime
    arrives: datetime
    vessel: str


class TrackingEvent(BoundaryModel):
    """A partner's tracking event. Always untrusted: it may only prompt an attestor."""

    provider: str
    reference: str
    kind: str
    location: Locode | None = None
    occurred_at: datetime
    trusted: Literal[False] = False


class CustomsFiling(BoundaryModel):
    """A filing a customs-software partner submits for one shipment."""

    shipment_id: str
    jurisdiction: str = Field(pattern=r"^[A-Z]{2}$")
    filing_type: str


class CustomsStatus(BoundaryModel):
    """Where a customs filing stands at the partner."""

    provider: str
    reference: str
    status: Literal["submitted", "accepted", "rejected", "held"]
