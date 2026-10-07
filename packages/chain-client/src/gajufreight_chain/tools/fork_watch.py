"""Watch networks for forks and witness-finality lag (spike probe E13, HLD §7 Q17).

Polls each network's top generation, re-reads the last few, and records any height
whose key block changed or whose microblocks were dropped, with its depth below the
top. On networks with witness finality it records how far finality trails the top.
Writes one JSON object per line; ``--summarise`` turns a run into the numbers E13 needs.

    gajufreight-fork-watch --hours 24 --output e13.jsonl
    gajufreight-fork-watch --summarise e13.jsonl
"""

import argparse
import itertools
import json
import statistics
import sys
import time
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import TextIO

from gajufreight_chain.models import Generation
from gajufreight_chain.networks import NETWORKS, FinalitySource
from gajufreight_chain.node import NodeClient, NodeError

Record = dict[str, object]


@dataclass(frozen=True)
class Seen:
    """What was last observed at one height."""

    key_block: str
    micro_blocks: tuple[str, ...]


class ForkDetector:
    """Remembers recent generations and reports when one changes.

    A key block replaced at a height, or a microblock that disappears from a height's
    list, is a fork. The top generation's microblock list only grows, so growth alone
    is never reported.
    """

    def __init__(self, keep: int = 50) -> None:
        """Remember the last ``keep`` heights."""
        self._keep = keep
        self._seen: dict[int, Seen] = {}

    def observe(self, generation: Generation, top: int) -> list[Record]:
        """Record ``generation`` and return any forks it reveals."""
        height = generation.key_block.height
        now = Seen(generation.key_block.hash, tuple(generation.micro_blocks))
        before = self._seen.get(height)
        self._seen[height] = now
        for old in [h for h in self._seen if h < top - self._keep]:
            del self._seen[old]
        if before is None or before == now:
            return []
        depth = top - height
        if before.key_block != now.key_block:
            return [
                {
                    "kind": "fork",
                    "fork": "key_block",
                    "height": height,
                    "depth": depth,
                    "was": before.key_block,
                    "now": now.key_block,
                }
            ]
        dropped = [mb for mb in before.micro_blocks if mb not in now.micro_blocks]
        if dropped:
            return [
                {
                    "kind": "fork",
                    "fork": "micro_block",
                    "height": height,
                    "depth": depth,
                    "dropped": dropped,
                }
            ]
        return []


def poll(client: NodeClient, detector: ForkDetector, recheck: int) -> Iterator[Record]:
    """Read one network's top and the ``recheck`` generations below it."""
    top = client.current_generation()
    top_height = top.key_block.height
    yield {
        "kind": "top",
        "height": top_height,
        "key_block": top.key_block.hash,
        "micro_blocks": len(top.micro_blocks),
    }
    yield from detector.observe(top, top_height)
    for height in range(max(top_height - recheck, 0), top_height):
        yield from detector.observe(client.generation(height), top_height)
    if client.network.finality is FinalitySource.WITNESS:
        finalized = client.status().finalized
        if finalized is not None and finalized.type == "witness":
            yield {
                "kind": "lag",
                "height": top_height,
                "finalized": finalized.height,
                "lag": top_height - finalized.height,
            }


def watch(
    clients: Iterable[NodeClient],
    out: TextIO,
    *,
    interval: float,
    recheck: int,
    until: float,
    clock: Callable[[], float] = time.time,
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    """Poll every client each ``interval`` until ``clock()`` reaches ``until``."""
    pairs = [(client, ForkDetector()) for client in clients]
    while clock() < until:
        for client, detector in pairs:
            stamp = datetime.fromtimestamp(clock(), UTC).isoformat()
            try:
                records = list(poll(client, detector, recheck))
            except (
                NodeError,
                OSError,
            ) as error:  # one failed poll must not end a long run
                records = [{"kind": "error", "error": str(error)}]
            for record in records:
                out.write(
                    json.dumps({"t": stamp, "network": client.network.name, **record})
                    + "\n"
                )
        out.flush()
        sleep(interval)


def summarise(lines: Iterable[str]) -> dict[str, Record]:
    """Summarise a watch per network: span, forks, deepest fork, lag and gaps."""
    by_network: dict[str, list[Record]] = {}
    for line in lines:
        if line.strip():
            record = json.loads(line)
            by_network.setdefault(str(record["network"]), []).append(record)
    return {name: _summarise_network(records) for name, records in by_network.items()}


def _summarise_network(records: list[Record]) -> Record:
    stamps = sorted({datetime.fromisoformat(str(r["t"])) for r in records})
    gaps = [(b - a).total_seconds() for a, b in itertools.pairwise(stamps)]
    tops = [int(str(r["height"])) for r in records if r["kind"] == "top"]
    forks = [r for r in records if r["kind"] == "fork"]
    lags = [int(str(r["lag"])) for r in records if r["kind"] == "lag"]
    return {
        "from": stamps[0].isoformat() if stamps else None,
        "to": stamps[-1].isoformat() if stamps else None,
        "key_blocks": (max(tops) - min(tops)) if tops else 0,
        "forks": len(forks),
        "key_block_forks": sum(1 for f in forks if f["fork"] == "key_block"),
        "micro_block_forks": sum(1 for f in forks if f["fork"] == "micro_block"),
        "deepest_fork": max((int(str(f["depth"])) for f in forks), default=0),
        "lag_median": statistics.median(lags) if lags else None,
        "lag_max": max(lags) if lags else None,
        "errors": sum(1 for r in records if r["kind"] == "error"),
        "longest_gap_s": max(gaps) if gaps else 0.0,
    }


def main(argv: list[str] | None = None) -> int:
    """Run a watch, or summarise one."""
    parser = argparse.ArgumentParser(
        description=__doc__.splitlines()[0] if __doc__ else None
    )
    parser.add_argument(
        "--networks", nargs="+", default=list(NETWORKS), choices=list(NETWORKS)
    )
    parser.add_argument(
        "--interval", type=float, default=3.0, help="seconds between polls"
    )
    parser.add_argument(
        "--recheck", type=int, default=5, help="generations re-read below the top"
    )
    parser.add_argument("--hours", type=float, default=24.0)
    parser.add_argument(
        "--output", type=Path, help="JSONL file to append to (default stdout)"
    )
    parser.add_argument("--summarise", type=Path, metavar="JSONL")
    args = parser.parse_args(argv)
    if args.summarise:
        with args.summarise.open() as run:
            json.dump(summarise(run), sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 0
    clients = [NodeClient(NETWORKS[name]) for name in args.networks]
    out = args.output.open("a") if args.output else sys.stdout
    try:
        watch(
            clients,
            out,
            interval=args.interval,
            recheck=args.recheck,
            until=time.time() + args.hours * 3600,
        )
    finally:
        for client in clients:
            client.close()
        if out is not sys.stdout:
            out.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
