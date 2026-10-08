"""Decide whether a transaction is final, by each network's rule (HLD §7 Q17).

Mainnet finalises key blocks by witness, and its node reports the latest sealed one in
``/status``. A transaction in a microblock of generation G is final once key block
G + 1 is sealed: until then a micro-fork can drop that microblock (Ulf, QPQ,
2026-10-08). Testnet has no witnesses, so a transaction counts as final once it is
``final_depth`` key blocks deep.
"""

from gajufreight_chain.models import Status
from gajufreight_chain.networks import FinalitySource, Network


def is_final(network: Network, tx_height: int, top_height: int, status: Status) -> bool:
    """Return whether a transaction mined at ``tx_height`` is final now.

    Args:
        network: The network the transaction is on.
        tx_height: Height of the key block whose generation holds the transaction.
        top_height: The current top key-block height.
        status: The node's current status (carries witness finality on mainnet).
    """
    if network.finality is FinalitySource.WITNESS:
        finalized = status.finalized
        if finalized is not None and finalized.type == "witness":
            return tx_height < finalized.height
    return top_height - tx_height >= network.final_depth
