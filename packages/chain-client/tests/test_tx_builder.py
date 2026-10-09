import json
import os
from collections.abc import Callable

import httpx2
import pytest

from gajufreight_chain.tx_builder import HashPart, TxBuilderClient, TxBuilderError

UNSIGNED = {
    "tx": "tx_abc",
    "nonce": 3,
    "ttl": 99,
    "dry_run_gas": 16313,
    "fee_estimate": 198913000000000,
}


def answering(handler: Callable[[httpx2.Request], httpx2.Response]) -> TxBuilderClient:
    transport = httpx2.MockTransport(handler)
    return TxBuilderClient("http://tx-builder", httpx2.Client(transport=transport))


def test_builds_a_call_and_sends_only_what_was_given() -> None:
    seen: list[dict[str, object]] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        seen.append(json.loads(request.content))
        return httpx2.Response(200, json=UNSIGNED)

    with answering(handler) as client:
        tx = client.build_call(
            contract="ct_1",
            contract_name="platform",
            function="book",
            args=["ct_q"],
            caller="ak_1",
            amount=5,
        )
    assert tx.fee_estimate == 198913000000000
    assert seen == [
        {
            "contract": "ct_1",
            "contract_name": "platform",
            "function": "book",
            "args": ["ct_q"],
            "caller": "ak_1",
            "amount": 5,
        }
    ]


def test_builds_a_create_with_a_fixed_nonce_and_ttl() -> None:
    seen: list[dict[str, object]] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        seen.append(json.loads(request.content))
        return httpx2.Response(
            200, json={**UNSIGNED, "dry_run_gas": None, "fee_estimate": None}
        )

    tx = answering(handler).build_create(
        contract_name="platform", args=["[]"], caller="ak_1", nonce=4, ttl=100
    )
    assert tx.fee_estimate is None
    assert seen[0]["nonce"] == 4
    assert seen[0]["ttl"] == 100


@pytest.mark.parametrize("build", ["build_call", "build_create"])
def test_a_gas_limit_and_no_dry_run_are_forwarded(build: str) -> None:
    seen: list[dict[str, object]] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        seen.append(json.loads(request.content))
        return httpx2.Response(200, json=UNSIGNED)

    args: dict[str, object] = {
        "contract_name": "platform",
        "args": [],
        "caller": "ak_1",
    }
    if build == "build_call":
        args |= {"contract": "ct_1", "function": "book"}
    getattr(answering(handler), build)(**args, gas=250_000, dry_run=False)
    assert seen[0]["gas"] == 250_000
    assert seen[0]["dry_run"] is False


def test_hashes_and_decodes_events() -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        if request.url.path == "/hash":
            return httpx2.Response(200, json={"hash": "#ab"})
        return httpx2.Response(
            200, json=[{"event": "RefundPaid", "address": "ct_x", "fields": [5]}]
        )

    client = answering(handler)
    part = HashPart(
        contract_name="quote-request", function="propose", argument="t", value="{}"
    )
    assert client.hash([part]) == "#ab"
    [event] = client.decode_events("shipment-escrow", [{"topics": [1]}])
    assert event.event == "RefundPaid"


def test_health_lists_contracts() -> None:
    client = answering(
        lambda _: httpx2.Response(200, json={"status": "ok", "contracts": ["platform"]})
    )
    assert client.health() == ["platform"]


def test_errors_carry_the_service_reason() -> None:
    client = answering(
        lambda _: httpx2.Response(400, json={"error": "{missing,[caller]}"})
    )
    with pytest.raises(TxBuilderError) as raised:
        client.build_call(
            contract="ct", contract_name="p", function="f", args=[], caller="ak"
        )
    assert raised.value.reason == "{missing,[caller]}"


@pytest.mark.parametrize(
    ("response", "message"),
    [
        (httpx2.Response(200, text="nope"), "not JSON"),
        (httpx2.Response(200, json=[1]), "unexpected response"),
        (httpx2.Response(500, json=["x"]), "unexpected response"),
    ],
)
def test_bad_responses_raise(response: httpx2.Response, message: str) -> None:
    with pytest.raises(TxBuilderError, match=message):
        answering(lambda _: response).hash([])


def test_decode_expects_a_list() -> None:
    client = answering(lambda _: httpx2.Response(200, json={"not": "a list"}))
    with pytest.raises(TxBuilderError, match="list of events"):
        client.decode_events("shipment-escrow", [])


@pytest.mark.live
@pytest.mark.skipif(
    "TX_BUILDER_URL" not in os.environ, reason="needs a running tx-builder"
)
def test_live_tx_builder_builds_and_estimates() -> None:
    # Started with TX_BUILDER_CONTRACTS=contracts/spike against testnet (README).
    with TxBuilderClient(os.environ["TX_BUILDER_URL"]) as client:
        assert "probe-booker" in client.health()
        tx = client.build_call(
            contract="ct_QWM9Btm6yfg6s3xN7fg5hb4pv4QyfyksSpcLeDXY9EwuQ5N1V",
            contract_name="probe-booker",
            function="book",
            args=[
                "ct_D49yFRtcTMPgkcUCyyL7H69nc4Gpi2bMEEoGVt9BSerGTfKt1",
                "ak_2qUaM6oGvVFiDboExbhtXRo5FBwUPUuH2baWaaGs2prJAU1Zv9",
                "ak_2srNcriPqhuTdEFLXwHBJqaLudA2LA2Pz5C29aEjGviYbDRF8x",
                "[]",
                "[ak_29Jhdvwx8YDLLXghH2Qd8pGRbVqnqatXuVZokvFva6jVuxKXMP]",
                "999999",
            ],
            caller="ak_2h9aNfyyD3VNnS8NJqxJUkr8F1qdxWjh3NHSxuX51TbR24feig",
            amount=10**15,
        )
        assert tx.tx.startswith("tx_")
        assert tx.dry_run_gas == 16313  # what the same call used on testnet (E14)
        assert tx.fee_estimate == (16313 + 182600) * 10**9


def test_a_transport_failure_is_a_tx_builder_error() -> None:
    # The relay calls this client and the node client alike: neither may leak httpx2.
    def handler(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ConnectError("connection refused", request=request)

    with pytest.raises(TxBuilderError, match="connection refused") as raised:
        answering(handler).health()
    assert raised.value.status_code == 0


def test_a_malformed_decoded_event_is_a_tx_builder_error() -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(200, json=[{"event": "Paid"}])  # no address or fields

    with pytest.raises(TxBuilderError, match="unexpected response shape"):
        answering(handler).decode_events("platform", [])
