"""Client for the tx-builder service (ADR 0012).

It builds unsigned transactions with fee estimates, FATE hashes and decoded events, so
no Python service re-implements FATE encoding.

The tx-builder holds no keys. It returns an unsigned ``tx_…`` transaction for the
relay to hand to a wallet over GRIDS.
"""

import httpx2
from pydantic import BaseModel, ConfigDict

from gajufreight_chain.http import JsonClient, ServiceError

DEFAULT_URL = "http://127.0.0.1:8790"


class TxBuilderError(ServiceError):
    """The tx-builder refused a request; ``reason`` is its error text."""

    service = "tx-builder"


class UnsignedTx(BaseModel):
    """An unsigned transaction and what signing it will cost.

    ``fee_estimate`` (puck) is dry-run gas plus the charge a call or a create carries
    beyond it (spike E18), times the gas price; it is ``None`` when the dry run failed
    (e.g. the caller's account doesn't exist yet). It runs about 1% low for large calls,
    whose fixed charge is a little higher.
    """

    model_config = ConfigDict(frozen=True)

    tx: str
    nonce: int
    ttl: int
    dry_run_gas: int | None
    fee_estimate: int | None


class HashPart(BaseModel):
    """A Sophia value to hash, typed by a function argument it could be passed as."""

    model_config = ConfigDict(frozen=True)

    contract_name: str
    function: str
    argument: str
    value: str


class DecodedEvent(BaseModel):
    """A logged event with its name and fields, or ``event=None`` if unknown."""

    model_config = ConfigDict(frozen=True)

    event: str | None
    address: str
    fields: list[object]


class TxBuilderClient(JsonClient):
    """Talks to a tx-builder on localhost."""

    error = TxBuilderError

    def __init__(
        self, base_url: str = DEFAULT_URL, http: httpx2.Client | None = None
    ) -> None:
        """Connect to the tx-builder at ``base_url``."""
        super().__init__(base_url, http, 30.0)

    def health(self) -> list[str]:
        """Return the contracts the service has loaded."""
        contracts = self._object("GET", "/health").get("contracts", [])
        return [str(name) for name in contracts] if isinstance(contracts, list) else []

    def build_call(
        self,
        *,
        contract: str,
        contract_name: str,
        function: str,
        args: list[str],
        caller: str,
        amount: int = 0,
        nonce: int | None = None,
        ttl: int | None = None,
        gas: int | None = None,
        dry_run: bool = True,
    ) -> UnsignedTx:
        """Build an unsigned call; ``args`` are Sophia literals, ``amount`` in puck.

        ``gas`` overrides the service's gas limit; ``dry_run=False`` skips the estimate.
        """
        request = {
            "contract": contract,
            "contract_name": contract_name,
            "function": function,
            "args": args,
            "caller": caller,
            "amount": amount,
        }
        return self._build("/calls", request, nonce, ttl, gas, dry_run)

    def build_create(
        self,
        *,
        contract_name: str,
        args: list[str],
        caller: str,
        amount: int = 0,
        nonce: int | None = None,
        ttl: int | None = None,
        gas: int | None = None,
        dry_run: bool = True,
    ) -> UnsignedTx:
        """Build an unsigned contract create from the network's built contract."""
        request = {
            "contract_name": contract_name,
            "args": args,
            "caller": caller,
            "amount": amount,
        }
        return self._build("/creates", request, nonce, ttl, gas, dry_run)

    def hash(self, parts: list[HashPart]) -> str:
        """Return the blake2b hash (``#…``) a contract computes of these values."""
        body = self._object(
            "POST", "/hash", {"parts": [part.model_dump() for part in parts]}
        )
        return str(body["hash"])

    def decode_events(
        self, contract_name: str, log: list[dict[str, object]]
    ) -> list[DecodedEvent]:
        """Name and decode each logged event, using the contract's interface."""
        body = self._request(
            "POST", "/events/decode", {"contract_name": contract_name, "log": log}
        )
        if not isinstance(body, list):
            raise TxBuilderError("/events/decode", 200, "expected a list of events")
        return [DecodedEvent.model_validate(event) for event in body]

    def _build(
        self,
        path: str,
        request: dict[str, object],
        nonce: int | None,
        ttl: int | None,
        gas: int | None,
        dry_run: bool,
    ) -> UnsignedTx:
        optional = {"nonce": nonce, "ttl": ttl, "gas": gas}
        request |= {key: value for key, value in optional.items() if value is not None}
        if not dry_run:
            request["dry_run"] = False
        return self._model(UnsignedTx, "POST", path, request)
