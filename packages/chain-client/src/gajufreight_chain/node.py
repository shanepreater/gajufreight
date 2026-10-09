"""A typed client for the Gajumaru node HTTP API (the indexer and relay build on it).

Synchronous and small on purpose: one method per endpoint we use, each returning a
validated model. Polling is the baseline, because mainnet's node has no event
subscriptions yet (spike round 2).
"""

from types import TracebackType
from typing import Self

import httpx2
from pydantic import BaseModel, ValidationError

from gajufreight_chain.models import (
    Account,
    Generation,
    KeyBlock,
    MicroBlockTransactions,
    Status,
    TransactionFinality,
    TransactionInfo,
)
from gajufreight_chain.networks import Network

DEFAULT_TIMEOUT = 10.0


class NodeError(Exception):
    """The node refused a request or answered with something unusable."""

    def __init__(self, path: str, status_code: int, reason: str) -> None:
        """Record which request failed and why."""
        super().__init__(f"{path}: HTTP {status_code}: {reason}")
        self.path = path
        self.status_code = status_code
        self.reason = reason


class NodeClient:
    """Reads chain state from one node and posts signed transactions to it."""

    def __init__(self, network: Network, http: httpx2.Client | None = None) -> None:
        """Connect to ``network``'s node; pass ``http`` to supply a transport."""
        self.network = network
        self._http = http or httpx2.Client(timeout=DEFAULT_TIMEOUT)

    def __enter__(self) -> Self:
        """Use the client as a context manager so connections are closed."""
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        """Close the underlying connections."""
        self.close()

    def close(self) -> None:
        """Close the underlying connections."""
        self._http.close()

    def status(self) -> Status:
        """Return the node's network, version and finalised key block."""
        return self._get("/status", Status)

    def current_key_block(self) -> KeyBlock:
        """Return the top key block."""
        return self._get("/key-blocks/current", KeyBlock)

    def generation(self, height: int) -> Generation:
        """Return the key block at ``height`` and its microblock hashes."""
        return self._get(f"/generations/height/{height}", Generation)

    def current_generation(self) -> Generation:
        """Return the top generation."""
        return self._get("/generations/current", Generation)

    def micro_block_transactions(self, micro_block: str) -> MicroBlockTransactions:
        """Return the transactions in one microblock."""
        return self._get(
            f"/micro-blocks/hash/{micro_block}/transactions", MicroBlockTransactions
        )

    def transaction_info(self, tx_hash: str) -> TransactionInfo:
        """Return what a mined transaction did, including its event log."""
        return self._get(f"/transactions/{tx_hash}/info", TransactionInfo)

    def transaction_finality(self, tx_hash: str) -> TransactionFinality:
        """Return a transaction's depth and finality status (testnet's node only)."""
        return self._get(f"/transactions/{tx_hash}/finality", TransactionFinality)

    def account(self, account_id: str) -> Account | None:
        """Return an account, or None if it has never received funds."""
        try:
            return self._get(f"/accounts/{account_id}", Account)
        except NodeError as error:
            if error.status_code == 404:
                return None
            raise

    def post_transaction(self, signed_tx: str) -> str:
        """Submit a signed ``tx_…`` transaction and return its hash."""
        response = self._send("POST", "/transactions", {"tx": signed_tx})
        body = self._json(response, "/transactions")
        tx_hash = body.get("tx_hash")
        if not isinstance(tx_hash, str) or not tx_hash:
            raise NodeError(
                "/transactions", response.status_code, "no transaction hash"
            )
        return tx_hash

    def _get[M: BaseModel](self, path: str, model: type[M]) -> M:
        response = self._send("GET", path)
        try:
            return model.model_validate(self._json(response, path))
        except ValidationError as error:
            # The body may be large or hostile: report only how many fields failed.
            reason = f"unexpected response shape ({error.error_count()} field errors)"
            raise NodeError(path, response.status_code, reason) from None

    def _send(self, method: str, path: str, body: object = None) -> httpx2.Response:
        """Send a request; a timeout or refused connection is a NodeError (status 0)."""
        try:
            return self._http.request(
                method, f"{self.network.node_url}{path}", json=body
            )
        except httpx2.RequestError as error:
            raise NodeError(path, 0, str(error) or type(error).__name__) from error

    @staticmethod
    def _json(response: httpx2.Response, path: str) -> dict[str, object]:
        try:
            body = response.json()
        except ValueError as error:
            raise NodeError(
                path, response.status_code, "response is not JSON"
            ) from error
        if response.status_code >= 400 or not isinstance(body, dict):
            reason = (
                body.get("reason", "unexpected response")
                if isinstance(body, dict)
                else "unexpected response"
            )
            raise NodeError(path, response.status_code, str(reason))
        return body
