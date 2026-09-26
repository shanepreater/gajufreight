"""FastAPI application for the GajuFreight API.

The API builds unsigned transactions and ingests evidence. It never holds or
uses user keys (AGENTS.md, hard rule 1). Only the health endpoint exists so far.
"""

from typing import Literal

from fastapi import FastAPI
from pydantic import BaseModel

from gajufreight_api import __version__


class Health(BaseModel):
    """Liveness response."""

    status: Literal["ok"]
    version: str


def create_app() -> FastAPI:
    """Build the application. Use this in tests to get a fresh instance."""
    app = FastAPI(title="GajuFreight API", version=__version__)

    @app.get("/health", tags=["ops"])
    async def health() -> Health:
        """Report that the service is running."""
        return Health(status="ok", version=__version__)

    return app


app = create_app()
