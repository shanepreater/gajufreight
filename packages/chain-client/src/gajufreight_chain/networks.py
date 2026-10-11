"""The Gajumaru networks GajuFreight talks to, and how each decides finality."""

from dataclasses import dataclass
from enum import StrEnum


class FinalitySource(StrEnum):
    """Where a network's finality comes from (spike round 2, HLD §7 Q17)."""

    WITNESS = "witness"  # the node's /status reports a witness-finalised key block
    DEPTH = "depth"  # no witnesses: a transaction is final at a fixed depth


@dataclass(frozen=True)
class Network:
    """A network's identity, node endpoint and finality rule.

    Attributes:
        name: Short name used in configuration and logs.
        network_id: The id the node reports, used when signing.
        node_url: Base URL of the node's HTTP API, including ``/v3``. The public
            nodes below serve plain HTTP only (QPQ Q&A, Node API follow-up 5), so they
            suit development, tests and the fork watch. Production points at our own
            node over TLS, set by deployment config (hosting ADR, #47).
        finality: Where finality comes from on this network.
        final_depth: Key blocks after which a transaction counts as final when the
            network has no witnesses. Set from probe E13 (2026-10-09): the deepest
            fork in 24 hours was 2 key blocks, so 3. Unused where witnesses report
            finality, which fails closed instead.
    """

    name: str
    network_id: str
    node_url: str
    finality: FinalitySource
    final_depth: int


TESTNET = Network(
    name="testnet",
    network_id="groot.testnet",
    node_url="http://groot.testnet.gajumaru.io:3013/v3",
    finality=FinalitySource.DEPTH,
    final_depth=3,
)

MAINNET = Network(
    name="mainnet",
    network_id="groot.mainnet",
    node_url="http://groot.mainnet.gajumaru.io:3013/v3",
    finality=FinalitySource.WITNESS,
    final_depth=3,
)

NETWORKS = {network.name: network for network in (TESTNET, MAINNET)}
