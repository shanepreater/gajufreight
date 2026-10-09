"""The JSON-over-HTTP plumbing the node and tx-builder clients share.

One place decides how a request fails: a timeout or refused connection, a body that
isn't JSON, an error status, or an unexpected shape all raise the client's own error,
so callers never handle ``httpx2`` or ``pydantic`` exceptions themselves.
"""

from types import TracebackType
from typing import Self

import httpx2
from pydantic import BaseModel, ValidationError


class ServiceError(Exception):
    """A service refused a request or answered with something unusable.

    ``status_code`` is 0 when the request never got an answer.
    """

    service = "service"

    def __init__(self, path: str, status_code: int, reason: str) -> None:
        """Record which request failed and why."""
        super().__init__(f"{self.service} {path}: HTTP {status_code}: {reason}")
        self.path = path
        self.status_code = status_code
        self.reason = reason


class JsonClient:
    """Sends JSON requests to one service; subclasses name their ``error`` type."""

    error: type[ServiceError] = ServiceError

    def __init__(
        self, base_url: str, http: httpx2.Client | None, timeout: float
    ) -> None:
        """Talk to ``base_url``; pass ``http`` to supply a transport."""
        self._base_url = base_url.rstrip("/")
        self._http = http or httpx2.Client(timeout=timeout)

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

    def _request(self, method: str, path: str, body: object = None) -> object:
        """Send a request and return its decoded JSON body."""
        try:
            response = self._http.request(method, f"{self._base_url}{path}", json=body)
        except httpx2.RequestError as error:
            raise self.error(path, 0, str(error) or type(error).__name__) from error
        try:
            payload = response.json()
        except ValueError as error:
            raise self.error(
                path, response.status_code, "response is not JSON"
            ) from error
        if response.status_code >= 400:
            raise self.error(path, response.status_code, _reason(payload))
        return payload

    def _object(self, method: str, path: str, body: object = None) -> dict[str, object]:
        """Send a request whose answer must be a JSON object."""
        payload = self._request(method, path, body)
        if not isinstance(payload, dict):
            raise self.error(path, 200, "unexpected response")
        return payload

    def _model[M: BaseModel](
        self, model: type[M], method: str, path: str, body: object = None
    ) -> M:
        """Send a request and validate its JSON object as ``model``."""
        payload = self._object(method, path, body)
        try:
            return model.model_validate(payload)
        except ValidationError as error:
            # The body may be large or hostile: report only how many fields failed.
            reason = f"unexpected response shape ({error.error_count()} field errors)"
            raise self.error(path, 200, reason) from None


def _reason(payload: object) -> str:
    """The node says ``reason``; the tx-builder says ``error``."""
    if isinstance(payload, dict):
        for key in ("reason", "error"):
            if key in payload:
                return str(payload[key])
    return "unexpected response"
