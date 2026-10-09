from collections.abc import Callable

from gajufreight_chain.finality import is_final
from gajufreight_chain.models import Status
from gajufreight_chain.networks import MAINNET, TESTNET


def test_mainnet_uses_witness_finality(load_recording: Callable[[str], object]) -> None:
    status = Status.model_validate(load_recording("mainnet-status"))
    assert status.finalized is not None
    height = status.finalized.height
    # Ulf (QPQ, 2026-10-08): a transaction in generation G is final once key block G + 1
    # is sealed; G itself being final isn't enough, as a micro-fork can still drop it.
    assert is_final(MAINNET, height - 1, height + 1, status)
    assert not is_final(MAINNET, height, height + 1, status)


def test_testnet_has_no_witnesses_so_uses_depth(
    load_recording: Callable[[str], object],
) -> None:
    status = Status.model_validate(load_recording("testnet-status"))
    assert status.finalized is not None
    assert status.finalized.type == "height"  # genesis, not a witness
    assert is_final(TESTNET, 100, 102, status)
    assert not is_final(TESTNET, 100, 101, status)


def test_witness_network_without_a_witness_record_is_never_final(
    load_recording: Callable[[str], object],
) -> None:
    # Missing testimonies mean a netsplit or a witness outage: wait (QPQ, 2026-10-08).
    # Depth alone must not make a mainnet transaction final, however deep it is.
    status = Status.model_validate(load_recording("testnet-status"))
    assert not is_final(MAINNET, 100, 102, status)
    assert not is_final(MAINNET, 100, 10_000, status)
    no_finality = status.model_copy(update={"finalized": None})
    assert not is_final(MAINNET, 100, 10_000, no_finality)
