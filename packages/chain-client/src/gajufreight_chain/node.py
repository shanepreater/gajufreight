"""A typed client for the Gajumaru node HTTP API (the indexer and relay build on it).

Synchronous and small on purpose: one method per endpoint we use, each returning a
validated model. Polling is the baseline, because mainnet's node has no event
subscriptions yet (spike round 2).
"""

import httpx2
from pydantic import BaseModel

from gajufreight_chain.http import JsonClient, ServiceError
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


class NodeError(ServiceError):
    """The node refused a request or answered with something unusable."""

    service = "node"


class NodeClient(JsonClient):
    """Reads chain state from one node and posts signed transactions to it."""

    error = NodeError

    def __init__(self, network: Network, http: httpx2.Client | None = None) -> None:
        """Connect to ``network``'s node; pass ``http`` to supply a transport."""
        super().__init__(network.node_url, http, DEFAULT_TIMEOUT)
        self.network = network

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
        tx_hash = self._object("POST", "/transactions", {"tx": signed_tx}).get(
            "tx_hash"
        )
        if not isinstance(tx_hash, str) or not tx_hash:
            raise NodeError("/transactions", 200, "no transaction hash")
        return tx_hash

    def _get[M: BaseModel](self, path: str, model: type[M]) -> M:
        return self._model(model, "GET", path)
