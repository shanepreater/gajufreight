"""Tests for the health endpoint."""

from fastapi.testclient import TestClient

from gajufreight_api import __version__
from gajufreight_api.main import create_app


def test_health_reports_ok_and_version() -> None:
    client = TestClient(create_app())

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "version": __version__}


def test_unknown_route_returns_404() -> None:
    client = TestClient(create_app())

    assert client.get("/nope").status_code == 404


def test_health_rejects_non_get_methods() -> None:
    client = TestClient(create_app())

    assert client.post("/health").status_code == 405
