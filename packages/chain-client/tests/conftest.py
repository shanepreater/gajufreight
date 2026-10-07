"""Shared fixtures: a node client that answers from responses recorded on testnet."""

import json
from collections.abc import Callable
from pathlib import Path

import httpx2
import pytest

from gajufreight_chain.networks import TESTNET, Network
from gajufreight_chain.node import NodeClient

FIXTURES = Path(__file__).parent / "fixtures"

# Recorded on 2026-10-07 (see tests/fixtures). The booking is the GajuMobile-signed
# transaction from spike E9b, which logged the clone's Booked event.
BOOKING_TX = "th_2FQ5szDEYJzaZBDNKtg22GzMzrNsBjA6VjL2cZ5hhk8Bx1TXsn"
FUNDED = "ak_bc9Lb7CT9aZxZYY1DCDmSCvTiuzuCahBDzxVLg1sz5K3kNF17"
MISSING = "ak_kqLib5RtLL7s1oQwXZSCsN5QmjrfRGKbSdgKkeo5FJ5tvin2n"


def load(name: str) -> object:
    """Return a recorded node response."""
    return json.loads((FIXTURES / f"{name}.json").read_text())


ROUTES: dict[str, tuple[int, str]] = {
    "/status": (200, "testnet-status"),
    "/key-blocks/current": (200, "testnet-key-block"),
    "/generations/height/470042": (200, "testnet-generation"),
    "/generations/height/470041": (200, "testnet-generation"),
    "/generations/current": (200, "testnet-generation"),
    f"/transactions/{BOOKING_TX}/info": (200, "testnet-transaction-info"),
    f"/transactions/{BOOKING_TX}/finality": (200, "testnet-transaction-finality"),
    f"/accounts/{FUNDED}": (200, "testnet-account"),
    f"/accounts/{MISSING}": (404, "testnet-account-missing"),
}


def recorded(
    request: httpx2.Request, routes: dict[str, tuple[int, str]]
) -> httpx2.Response:
    """Answer a request from the recorded responses."""
    path = request.url.path.removeprefix("/v3")
    if path.startswith("/micro-blocks/hash/"):
        return httpx2.Response(200, json=load("testnet-micro-block-transactions"))
    if request.method == "POST" and path == "/transactions":
        return httpx2.Response(200, json={"tx_hash": BOOKING_TX})
    status, name = routes.get(path, (404, ""))
    body = load(name) if name else {"reason": "Not found"}
    return httpx2.Response(status, json=body)


@pytest.fixture
def make_client() -> Callable[..., NodeClient]:
    """Build a client for a network whose node answers from recordings."""

    def build(
        network: Network = TESTNET, routes: dict[str, tuple[int, str]] | None = None
    ) -> NodeClient:
        table = routes if routes is not None else ROUTES
        transport = httpx2.MockTransport(lambda request: recorded(request, table))
        return NodeClient(network, httpx2.Client(transport=transport))

    return build


@pytest.fixture
def mainnet_routes() -> dict[str, tuple[int, str]]:
    """Mainnet answers, recorded together: top generation and witness finality."""
    return {
        **ROUTES,
        "/status": (200, "mainnet-status"),
        "/generations/current": (200, "mainnet-generation"),
    }


@pytest.fixture
def load_recording() -> Callable[[str], object]:
    """Give a test the recorded-response loader."""
    return load


@pytest.fixture
def booking_tx() -> str:
    """The GajuMobile-signed booking from spike E9b."""
    return BOOKING_TX


@pytest.fixture
def funded() -> str:
    """A funded testnet account."""
    return FUNDED


@pytest.fixture
def missing() -> str:
    """A valid account id that has never received funds."""
    return MISSING
