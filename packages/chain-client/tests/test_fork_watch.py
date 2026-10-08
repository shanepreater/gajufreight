import io
import itertools
import json
from collections.abc import Callable
from pathlib import Path
from typing import cast

from gajufreight_chain.models import Generation, KeyBlock
from gajufreight_chain.networks import MAINNET, TESTNET
from gajufreight_chain.node import NodeClient
from gajufreight_chain.tools.fork_watch import (
    ForkDetector,
    main,
    poll,
    summarise,
    watch,
)

Make = Callable[..., NodeClient]


def gen(height: int, key_block: str, micro: list[str]) -> Generation:
    block = KeyBlock(hash=key_block, height=height, prev_key_hash="kh_prev", time=0)
    return Generation(key_block=block, micro_blocks=micro)


def test_growth_of_the_top_generation_is_not_a_fork() -> None:
    detector = ForkDetector()
    assert detector.observe(gen(10, "kh_a", ["mh_1"]), 10) == []
    assert detector.observe(gen(10, "kh_a", ["mh_1", "mh_2"]), 10) == []
    assert detector.observe(gen(10, "kh_a", ["mh_1", "mh_2"]), 10) == []


def test_a_replaced_key_block_is_a_fork_with_its_depth() -> None:
    detector = ForkDetector()
    detector.observe(gen(10, "kh_a", []), 10)
    [fork] = detector.observe(gen(10, "kh_b", []), 12)
    assert fork == {
        "kind": "fork",
        "fork": "key_block",
        "height": 10,
        "depth": 2,
        "was": "kh_a",
        "now": "kh_b",
    }


def test_a_dropped_microblock_is_a_fork() -> None:
    detector = ForkDetector()
    detector.observe(gen(10, "kh_a", ["mh_1", "mh_2"]), 10)
    [fork] = detector.observe(gen(10, "kh_a", ["mh_1", "mh_3"]), 11)
    assert fork["fork"] == "micro_block"
    assert fork["dropped"] == ["mh_2"]


def test_a_reordered_list_with_nothing_dropped_is_not_a_fork() -> None:
    detector = ForkDetector()
    detector.observe(gen(10, "kh_a", ["mh_1", "mh_2"]), 10)
    assert detector.observe(gen(10, "kh_a", ["mh_2", "mh_1"]), 10) == []


def test_old_heights_are_forgotten() -> None:
    detector = ForkDetector(keep=2)
    detector.observe(gen(1, "kh_a", []), 1)
    detector.observe(gen(9, "kh_z", []), 9)
    assert detector.observe(gen(1, "kh_b", []), 9) == []  # height 1 was forgotten


def test_poll_reports_the_top_and_mainnet_witness_lag(
    make_client: Make, mainnet_routes: dict[str, tuple[int, str]]
) -> None:
    records = list(
        poll(make_client(MAINNET, mainnet_routes), ForkDetector(), recheck=0)
    )
    assert [r["kind"] for r in records] == ["top", "lag"]
    assert (
        records[1]["lag"] == 1
    )  # top 505333, witness-final 505332 (recorded together)


def test_poll_rechecks_lower_generations(make_client: Make) -> None:
    records = list(poll(make_client(), ForkDetector(), recheck=1))
    assert [r["kind"] for r in records] == [
        "top"
    ]  # the re-read generation hasn't changed


class MismatchedNode:
    """A node whose by-height read of top - 1 returns the top with a stale list.

    Seen on mainnet 2026-10-08: ``/generations/height/506404`` answered with key
    block 506405 and one microblock fewer than ``/generations/current``.
    """

    network = TESTNET

    def current_generation(self) -> Generation:
        return gen(11, "kh_top", ["mh_a", "mh_b"])

    def generation(self, height: int) -> Generation:
        return gen(11, "kh_top", ["mh_a"]) if height == 10 else gen(height, "kh", [])


def test_a_generation_from_the_wrong_height_is_an_anomaly_not_a_fork() -> None:
    client = cast(NodeClient, MismatchedNode())
    detector = ForkDetector()
    rounds = [list(poll(client, detector, recheck=1)) for _ in range(2)]
    kinds = [[r["kind"] for r in records] for records in rounds]
    assert kinds == [["top", "anomaly"], ["top", "anomaly"]]
    assert rounds[0][1] == {"kind": "anomaly", "requested": 10, "returned": 11}


def test_watch_writes_jsonl_and_survives_a_failed_poll(make_client: Make) -> None:
    out = io.StringIO()
    ticks = itertools.chain([0.0, 0.0, 0.0], itertools.repeat(100.0))  # one round
    watch(
        [make_client(), make_client(routes={})],
        out,
        interval=0,
        recheck=0,
        until=50.0,
        clock=lambda: next(ticks),
        sleep=lambda _: None,
    )
    lines = [json.loads(line) for line in out.getvalue().splitlines()]
    assert [line["kind"] for line in lines] == ["top", "error"]
    assert all(line["network"] == "testnet" for line in lines)


def test_summarise_counts_forks_lag_and_gaps() -> None:
    lines = [
        {
            "t": "2026-10-07T10:00:00+00:00",
            "network": "mainnet",
            "kind": "top",
            "height": 100,
        },
        {
            "t": "2026-10-07T10:00:03+00:00",
            "network": "mainnet",
            "kind": "lag",
            "height": 100,
            "lag": 1,
        },
        {
            "t": "2026-10-07T10:01:03+00:00",
            "network": "mainnet",
            "kind": "top",
            "height": 103,
        },
        {
            "t": "2026-10-07T10:01:03+00:00",
            "network": "mainnet",
            "kind": "fork",
            "fork": "micro_block",
            "height": 102,
            "depth": 1,
        },
        {
            "t": "2026-10-07T10:01:06+00:00",
            "network": "mainnet",
            "kind": "error",
            "error": "timeout",
        },
        {
            "t": "2026-10-07T10:01:06+00:00",
            "network": "mainnet",
            "kind": "anomaly",
            "requested": 102,
            "returned": 103,
        },
    ]
    summary = summarise(json.dumps(line) for line in lines)["mainnet"]
    assert summary["key_blocks"] == 3
    assert summary["forks"] == 1
    assert summary["micro_block_forks"] == 1
    assert summary["deepest_fork"] == 1
    assert summary["lag_max"] == 1
    assert summary["errors"] == 1
    assert summary["anomalies"] == 1
    assert summary["longest_gap_s"] == 60.0


def test_main_summarises_a_file(tmp_path: Path) -> None:
    run = tmp_path / "run.jsonl"
    run.write_text(
        json.dumps(
            {
                "t": "2026-10-07T10:00:00+00:00",
                "network": "testnet",
                "kind": "top",
                "height": 5,
            }
        )
        + "\n"
    )
    assert main(["--summarise", str(run)]) == 0


def test_main_with_no_time_left_polls_nothing(tmp_path: Path) -> None:
    out = tmp_path / "out.jsonl"
    assert main(["--hours", "0", "--output", str(out), "--networks", "testnet"]) == 0
    assert out.read_text() == ""
