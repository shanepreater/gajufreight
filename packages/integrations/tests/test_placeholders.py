from datetime import date

import pytest

from gajufreight_integrations.capabilities import (
    CapacityBooking,
    CustomsFiler,
    Schedules,
    Tracking,
)
from gajufreight_integrations.models import (
    CustomsFiling,
    SpaceBooking,
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
FILING = CustomsFiling(
    shipment_id="GF-2026-0008", jurisdiction="NL", filing_type="import"
)


def test_the_default_set_satisfies_every_port() -> None:
    integrations = Integrations()
    assert isinstance(integrations.capacity, CapacityBooking)
    assert isinstance(integrations.schedules, Schedules)
    assert isinstance(integrations.tracking, Tracking)
    assert isinstance(integrations.customs, CustomsFiler)


@pytest.mark.parametrize(
    ("call", "capability"),
    [
        (lambda i: i.capacity.request_space(REQUEST), "capacity booking"),
        (lambda i: i.capacity.cancel_space("BK-1"), "capacity booking"),
        (
            lambda i: i.schedules.sailings("CNYTN", "NLRTM", date(2026, 10, 1)),
            "schedules",
        ),
        (lambda i: i.tracking.events("GJFU1234567"), "tracking"),
        (lambda i: i.customs.submit(FILING), "customs filing"),
        (lambda i: i.customs.status("CF-1"), "customs filing"),
    ],
)
def test_each_placeholder_refuses_and_names_its_capability(call, capability) -> None:  # type: ignore[no-untyped-def]
    with pytest.raises(IntegrationNotConfiguredError) as error:
        call(Integrations())
    assert error.value.capability == capability
    assert capability in str(error.value)


class FakeCarrier:
    """A partner adapter as a test double: implements only CapacityBooking."""

    def request_space(self, request: SpaceRequest) -> SpaceBooking:
        return SpaceBooking(provider="fake", booking_ref="BK-1", status="requested")

    def cancel_space(self, booking_ref: str) -> SpaceBooking:
        return SpaceBooking(
            provider="fake", booking_ref=booking_ref, status="cancelled"
        )


def test_configuring_a_partner_replaces_only_its_capability() -> None:
    integrations = Integrations(capacity=FakeCarrier())
    assert integrations.capacity.request_space(REQUEST).status == "requested"
    with pytest.raises(IntegrationNotConfiguredError):
        integrations.tracking.events("GJFU1234567")
