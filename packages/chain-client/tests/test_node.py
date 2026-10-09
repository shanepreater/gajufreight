from collections.abc import Callable

import httpx2
import pytest

from gajufreight_chain.networks import TESTNET
from gajufreight_chain.node import NodeClient, NodeError

Make = Callable[..., NodeClient]


def test_reads_status_and_key_block(make_client: Make) -> None:
    with make_client() as client:
        assert client.status().network_id == "groot.testnet"
        assert client.current_key_block().height > 470042


def test_reads_a_generation_and_its_transactions(
    make_client: Make, booking_tx: str
) -> None:
    client = make_client()
    generation = client.generation(470042)
    assert generation.key_block.height == 470042
    assert client.current_generation() == generation
    transactions = client.micro_block_transactions(generation.micro_blocks[0])
    assert transactions.transactions[0].hash == booking_tx


def test_reads_a_transaction_result_and_finality(
    make_client: Make, booking_tx: str
) -> None:
    client = make_client()
    info = client.transaction_info(booking_tx)
    assert info.call_info.return_type == "ok"
    assert info.call_info.gas_used == 16313
    finality = client.transaction_finality(booking_tx)
    assert finality.status == "on_chain"
    assert finality.height == 470042


def test_an_unfunded_account_is_none(
    make_client: Make, funded: str, missing: str
) -> None:
    client = make_client()
    account = client.account(funded)
    assert account is not None
    assert account.balance == 9998798667000000000
    assert client.account(missing) is None


def test_other_errors_raise_with_the_node_reason(make_client: Make) -> None:
    client = make_client(routes={})
    with pytest.raises(NodeError) as raised:
        client.status()
    assert raised.value.status_code == 404
    assert raised.value.reason == "Not found"


def test_an_account_error_other_than_404_raises(make_client: Make, funded: str) -> None:
    client = make_client(
        routes={f"/accounts/{funded}": (500, "testnet-account-missing")}
    )
    with pytest.raises(NodeError):
        client.account(funded)


def test_posts_a_signed_transaction(make_client: Make, booking_tx: str) -> None:
    assert make_client().post_transaction("tx_signed") == booking_tx


def test_a_non_json_or_non_object_body_raises() -> None:
    def answer(request: httpx2.Request) -> httpx2.Response:
        if request.url.path.endswith("/status"):
            return httpx2.Response(200, text="not json")
        return httpx2.Response(500, json=["unexpected"])

    client = NodeClient(TESTNET, httpx2.Client(transport=httpx2.MockTransport(answer)))
    with pytest.raises(NodeError, match="not JSON"):
        client.status()
    with pytest.raises(NodeError, match="unexpected response"):
        client.current_key_block()


def test_a_transport_failure_is_a_node_error() -> None:
    # A slow public node ended a 24-hour fork watch: timeouts must surface as NodeError.
    def answer(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ReadTimeout("timed out", request=request)

    client = NodeClient(TESTNET, httpx2.Client(transport=httpx2.MockTransport(answer)))
    with pytest.raises(NodeError, match="timed out") as raised:
        client.status()
    assert raised.value.status_code == 0


@pytest.mark.parametrize("body", [{}, {"tx_hash": 7}, {"tx_hash": ""}])
def test_a_post_without_a_usable_hash_is_a_node_error(body: dict[str, object]) -> None:
    client = NodeClient(
        TESTNET,
        httpx2.Client(
            transport=httpx2.MockTransport(
                lambda request: httpx2.Response(200, json=body)
            )
        ),
    )
    with pytest.raises(NodeError, match="no transaction hash"):
        client.post_transaction("tx_signed")


def test_a_malformed_body_is_a_node_error_without_the_body() -> None:
    # A 2xx body that fails validation must not escape as a pydantic error: the fork
    # watch only survives NodeError. The body may be large or hostile, so leave it out.
    client = NodeClient(
        TESTNET,
        httpx2.Client(
            transport=httpx2.MockTransport(
                lambda request: httpx2.Response(200, json={"height": "secret-garbage"})
            )
        ),
    )
    with pytest.raises(NodeError, match="unexpected response shape") as raised:
        client.current_key_block()
    assert "secret-garbage" not in str(raised.value)


def test_errors_keep_the_status_the_node_answered_with() -> None:
    def answer(request: httpx2.Request) -> httpx2.Response:
        if request.url.path.endswith("/transactions"):
            return httpx2.Response(202, json={})
        return httpx2.Response(201, json={"height": "garbage"})

    client = NodeClient(TESTNET, httpx2.Client(transport=httpx2.MockTransport(answer)))
    with pytest.raises(NodeError) as shape:
        client.current_key_block()
    assert shape.value.status_code == 201
    with pytest.raises(NodeError) as missing:
        client.post_transaction("tx_signed")
    assert missing.value.status_code == 202
