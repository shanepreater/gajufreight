from collections.abc import Callable
from datetime import date

import pytest

from gajufreight_integrations.models import (
    CustomsDeclaration,
    SpaceConfirmation,
    SpaceRequest,
)
from gajufreight_integrations.placeholders import (
    IntegrationNotConfiguredError,
    Integrations,
)

REQUEST = SpaceRequest(
    shipment_id="GF-2026-0008",
    mode="ocean",
    origin="CNYTN",
    destination="NLRTM",
    ready_by=date(2026, 10, 1),
    containers=1,
)
DECLARATION = CustomsDeclaration(
    shipment_id="GF-2026-0008", jurisdiction="NL", declaration_type="import"
)


@pytest.mark.parametrize(
    ("call", "capability"),
    [
        (lambda i: i.space.request_space(REQUEST), "space booking"),
        (lambda i: i.space.cancel_space("BK-1"), "space booking"),
        (
            lambda i: i.schedules.departures("CNYTN", "NLRTM", date(2026, 10, 1)),
            "schedules",
        ),
        (lambda i: i.tracking.events("GJFU1234567"), "tracking"),
        (lambda i: i.customs.submit(DECLARATION), "customs filing"),
        (lambda i: i.customs.status("CF-1"), "customs filing"),
    ],
)
def test_each_placeholder_refuses_and_names_its_capability(
    call: Callable[[Integrations], object], capability: str
) -> None:
    with pytest.raises(IntegrationNotConfiguredError) as error:
        call(Integrations())
    assert error.value.capability == capability
    assert capability in str(error.value)


class FakeCarrier:
    """A partner adapter as a test double: implements only SpaceBooking."""

    def request_space(self, request: SpaceRequest) -> SpaceConfirmation:
        return SpaceConfirmation(
            provider="fake", booking_ref="BK-1", status="requested"
        )

    def cancel_space(self, booking_ref: str) -> SpaceConfirmation:
        return SpaceConfirmation(
            provider="fake", booking_ref=booking_ref, status="cancelled"
        )


def test_configuring_a_partner_replaces_only_its_capability() -> None:
    integrations = Integrations(space=FakeCarrier())
    assert integrations.space.request_space(REQUEST).status == "requested"
    with pytest.raises(IntegrationNotConfiguredError):
        integrations.tracking.events("GJFU1234567")
