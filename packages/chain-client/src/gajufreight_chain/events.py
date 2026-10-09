"""Recognise contract events without the contract source (spike E7b).

A Sophia event's first topic is the blake2b-256 hash of its constructor name, read as a
big-endian integer, so an indexer can tell ``Booked`` from ``RefundPaid`` by hash alone.
"""

import hashlib
from collections.abc import Iterable

from gajufreight_chain.models import Event


def event_topic(name: str) -> int:
    """Return the first topic a Sophia event named ``name`` logs."""
    digest = hashlib.blake2b(name.encode(), digest_size=32).digest()
    return int.from_bytes(digest, "big")


def event_name(event: Event, names: Iterable[str]) -> str | None:
    """Return which of ``names`` logged ``event``, or None if none did."""
    if not event.topics:
        return None
    return next((name for name in names if event_topic(name) == event.topics[0]), None)
