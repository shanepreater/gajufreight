# gajufreight-chain

A typed client for the Gajumaru node HTTP API, shared by GajuFreight's Python services. There's no SDK: the node's HTTP API is the interface ([HLD §7 Q7](../../docs/hld.md#7-open-questions)).

| Module | What it does |
| :--- | :--- |
| `networks` | Testnet and mainnet: node URL, network id, finality rule |
| `node` | `NodeClient`: status, key blocks, generations, microblock transactions, transaction info and finality, accounts, posting signed transactions |
| `models` | Pydantic models of the responses we read; amounts are `int` puck |
| `events` | Recognising contract events by the hash of their name (spike E7b) |
| `finality` | `is_final`: witness finality on mainnet, a depth elsewhere (HLD §7 Q17) |
| `tools.fork_watch` | `gajufreight-fork-watch`: records forks and witness lag (spike E13) |

```sh
uv run pytest packages/chain-client            # unit tests, on recorded responses
uv run pytest -m live packages/chain-client    # smoke tests against the public nodes
uv run gajufreight-fork-watch --hours 24 --output e13.jsonl
uv run gajufreight-fork-watch --summarise e13.jsonl
```

The test fixtures are real responses recorded from testnet and mainnet on 2026-10-07.
