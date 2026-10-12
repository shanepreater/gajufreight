from datetime import UTC, date, datetime

import pytest
from pydantic import ValidationError

from gajufreight_integrations.models import CustomsFiling, SpaceRequest, TrackingEvent


def request(**changes: object) -> dict[str, object]:
    base: dict[str, object] = {
        "shipment_id": "GF-2026-0008",
        "mode": "ocean",
        "origin": "CNYTN",
        "destination": "NLRTM",
        "ready_by": date(2026, 10, 1),
        "containers": 1,
    }
    return base | changes


def test_a_valid_space_request() -> None:
    assert SpaceRequest.model_validate(request()).containers == 1


@pytest.mark.parametrize(
    "changes",
    [
        {"origin": "Rotterdam"},
        {"destination": "nlrtm"},
        {"containers": 0},
        {"mode": "rail"},
        {"surprise": "field"},
    ],
)
def test_bad_space_requests_are_refused(changes: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        SpaceRequest.model_validate(request(**changes))


def test_tracking_events_are_always_untrusted() -> None:
    event = TrackingEvent(
        provider="p",
        reference="r",
        kind="gate-in",
        occurred_at=datetime(2026, 10, 1, tzinfo=UTC),
    )
    assert event.trusted is False
    with pytest.raises(ValidationError):
        TrackingEvent(
            provider="p",
            reference="r",
            kind="gate-in",
            occurred_at=datetime(2026, 10, 1, tzinfo=UTC),
            trusted=True,
        )


def test_customs_jurisdiction_is_a_country_code() -> None:
    with pytest.raises(ValidationError):
        CustomsFiling(shipment_id="s", jurisdiction="Netherlands", filing_type="import")
