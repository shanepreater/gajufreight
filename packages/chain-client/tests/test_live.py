"""Smoke tests against the public nodes, deselected by default: ``pytest -m live``."""

import pytest

from gajufreight_chain.finality import is_final
from gajufreight_chain.networks import MAINNET, TESTNET
from gajufreight_chain.node import NodeClient

pytestmark = pytest.mark.live


def test_testnet_answers_and_models_validate() -> None:
    with NodeClient(TESTNET) as client:
        status = client.status()
        assert status.network_id == TESTNET.network_id
        top = client.current_generation()
        assert (
            client.generation(top.key_block.height - 1).key_block.height
            == top.key_block.height - 1
        )


def test_mainnet_reports_witness_finality() -> None:
    with NodeClient(MAINNET) as client:
        status = client.status()
        top = client.current_key_block().height
        assert status.finalized is not None
        assert status.finalized.type == "witness"
        # Generation G is final once key block G + 1 is sealed (QPQ, 2026-10-08).
        assert is_final(MAINNET, status.finalized.height - 1, top, status)
        assert not is_final(MAINNET, status.finalized.height, top, status)
