"""Client for the tx-builder service (ADR 0012).

It builds unsigned transactions with fee estimates, FATE hashes and decoded events, so
no Python service re-implements FATE encoding.

The tx-builder holds no keys. It returns an unsigned ``tx_…`` transaction for the
relay to hand to a wallet over GRIDS.
"""

from types import TracebackType
from typing import Self

import httpx2
from pydantic import BaseModel, ConfigDict

DEFAULT_URL = "http://127.0.0.1:8790"


class TxBuilderError(Exception):
    """The tx-builder refused a request; ``reason`` is its error text."""

    def __init__(self, status_code: int, reason: str) -> None:
        """Record the status and the service's reason."""
        super().__init__(f"tx-builder: HTTP {status_code}: {reason}")
        self.status_code = status_code
        self.reason = reason


class UnsignedTx(BaseModel):
    """An unsigned transaction and what signing it will cost.

    ``fee_estimate`` (puck) is dry-run gas plus the fixed per-call charge, times the gas
    price; it is ``None`` when the dry run failed (e.g. the caller's account doesn't
    exist yet). It runs about 1% low for large calls, whose fixed charge is a little
    higher.
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


class TxBuilderClient:
    """Talks to a tx-builder on localhost."""

    def __init__(
        self, base_url: str = DEFAULT_URL, http: httpx2.Client | None = None
    ) -> None:
        """Connect to the tx-builder at ``base_url``."""
        self._base_url = base_url.rstrip("/")
        self._http = http or httpx2.Client(timeout=30.0)

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
        self._http.close()

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
    ) -> UnsignedTx:
        """Build an unsigned call; ``args`` are Sophia literals, ``amount`` in puck."""
        request = {
            "contract": contract,
            "contract_name": contract_name,
            "function": function,
            "args": args,
            "caller": caller,
            "amount": amount,
        }
        return self._build("/calls", request, nonce, ttl)

    def build_create(
        self,
        *,
        contract_name: str,
        args: list[str],
        caller: str,
        amount: int = 0,
        nonce: int | None = None,
        ttl: int | None = None,
    ) -> UnsignedTx:
        """Build an unsigned contract create from the network's built contract."""
        request = {
            "contract_name": contract_name,
            "args": args,
            "caller": caller,
            "amount": amount,
        }
        return self._build("/creates", request, nonce, ttl)

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
            raise TxBuilderError(200, "expected a list of events")
        return [DecodedEvent.model_validate(event) for event in body]

    def _build(
        self, path: str, request: dict[str, object], nonce: int | None, ttl: int | None
    ) -> UnsignedTx:
        if nonce is not None:
            request["nonce"] = nonce
        if ttl is not None:
            request["ttl"] = ttl
        return UnsignedTx.model_validate(self._object("POST", path, request))

    def _object(
        self, method: str, path: str, body: dict[str, object] | None = None
    ) -> dict[str, object]:
        payload = self._request(method, path, body)
        if not isinstance(payload, dict):
            raise TxBuilderError(200, "expected a JSON object")
        return payload

    def _request(
        self, method: str, path: str, body: dict[str, object] | None = None
    ) -> object:
        response = self._http.request(method, f"{self._base_url}{path}", json=body)
        try:
            payload = response.json()
        except ValueError as error:
            raise TxBuilderError(
                response.status_code, "response is not JSON"
            ) from error
        if response.status_code >= 400:
            reason = (
                payload.get("error", "error") if isinstance(payload, dict) else "error"
            )
            raise TxBuilderError(response.status_code, str(reason))
        return payload
