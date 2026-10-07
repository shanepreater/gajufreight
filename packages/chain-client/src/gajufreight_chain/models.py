"""Pydantic models for the node responses GajuFreight reads.

Only the fields we use are declared; the node returns more, and they are ignored so a
node upgrade that adds fields doesn't break us. Amounts are integers in puck
(10^18 puck = 1 Gaju), never floats.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict


class NodeModel(BaseModel):
    """Base for node responses: immutable, unknown fields ignored."""

    model_config = ConfigDict(frozen=True, extra="ignore")


class Finalized(NodeModel):
    """The key block the node reports as final, and how it decided."""

    hash: str
    height: int
    type: Literal["witness", "height"]


class Status(NodeModel):
    """The node's ``/status``: which network, which version, what is final."""

    network_id: str
    node_version: str
    top_key_block_hash: str
    finalized: Finalized | None = None


class KeyBlock(NodeModel):
    """A key block: one per generation, it fixes the generation's height."""

    hash: str
    height: int
    prev_key_hash: str
    time: int


class Generation(NodeModel):
    """A key block and the hashes of the microblocks mined on top of it."""

    key_block: KeyBlock
    micro_blocks: list[str]


class Account(NodeModel):
    """An account's balance (puck) and the nonce of its last mined transaction."""

    id: str
    balance: int
    nonce: int
    payable: bool = True


class Event(NodeModel):
    """A contract event as logged: topics[0] is blake2b of the event's name."""

    address: str
    topics: list[int]
    data: str


class CallInfo(NodeModel):
    """What a contract call or create did, from ``/transactions/{hash}/info``."""

    caller_id: str
    contract_id: str
    height: int
    gas_used: int
    gas_price: int
    return_type: Literal["ok", "revert", "error"]
    return_value: str
    log: list[Event]


class TransactionInfo(NodeModel):
    """The result of a mined transaction."""

    call_info: CallInfo


class MinedTransaction(NodeModel):
    """A transaction as a microblock lists it."""

    hash: str
    block_hash: str
    block_height: int
    tx: dict[str, object]


class MicroBlockTransactions(NodeModel):
    """The transactions in one microblock."""

    transactions: list[MinedTransaction]


class TransactionFinality(NodeModel):
    """A transaction's progress towards finality (testnet's node only)."""

    block_hash: str
    height: int
    depth: int
    status: str
