# Contract traces

The real contracts are tested by replaying the demo suite on a chain ([decision log](../../docs/decision-log.md) #33, [#70](https://github.com/shanepreater/gajufreight/issues/70)).

1. **Record.** `npm run test:traces --prefix scripts/demo` runs every demo test with the recorder on (`TRACE_DIR=<dir>`). Each test file writes `<dir>/<file>.jsonl`, one trace per line.
2. **Replay** (next PR). A runner deploys the contracts on a node, replays each trace with throwaway keys, and writes what the chain did.
3. **Compare** (next PR). Every step's outcome, events and balance changes must match the demo's.

This file defines the trace format, the interface between the recorder ([`scripts/demo/lib/trace-recorder.js`](../../scripts/demo/lib/trace-recorder.js)) and the runner.

## A trace

```json
{ "version": 1, "unreplayable": null, "steps": [ … ] }
```

`unreplayable` is `null`, or the first reason the chain can't replay the trace. The runner skips these traces. Reasons include:

- a forked microblock;
- a contract that isn't one of ours;
- an entrypoint the contract lacks;
- an error outside any contract.

## Steps

Each step is one thing a wallet could do, in order.

| `op` | Fields | Meaning |
| :--- | :--- | :--- |
| `account` | `account`, `balance` | An account exists, holding `balance` |
| `deploy` | `height`, `caller`, `contract`, `args`, `value`, then `as` or `error` | `caller` creates `contract` (`Platform`, `QuoteRequest` or `ShipmentEscrow`), known from then on as `as` |
| `call` | `height`, `caller`, `contract`, `function`, `args`, `value`, then `result` or `error` | `caller` calls `function` on the contract labelled `contract` |
| `view` | `height`, `contract`, `function`, `args`, then `result` or `error` | A read-only call (a dry run) |
| `advance` | `keyblocks` | That many key blocks pass |

**Arguments** are positional, in the order of the contract's ACI ([`contracts/interface/`](../interface/)). The model's argument names are mapped to the contract's in [`scripts/demo/lib/contract-interface.js`](../../scripts/demo/lib/contract-interface.js), and drift tests check that mapping against the ACI.

**A step that succeeded** also records:

- `events`: `[{ contract, event: [name, …fields] }]`, in the order they were emitted, with fields in the contract's order.
- `balances`: `{ label: change }` for every balance that changed. The demo has no gas, so the runner adds each caller's transaction costs back before comparing.

**A step that failed** records `error`: the contract's error code, such as `BAD_STATE`. Nothing else changes.

## Values

| JSON | Meaning | The runner encodes it as |
| :--- | :--- | :--- |
| number, string, boolean, array | Itself | The ACI type at that position |
| `null` | No value | `None` for an `option`; for any other type, a model bug |
| `{ "$int": "123" }` | An amount in puck, or any `int` too large for JSON | `int` |
| `{ "$addr": "shipper" }` | An account, by name | The account's generated key |
| `{ "$addr": "ShipmentEscrow#2" }` | A contract, by kind and creation order in this trace | The address it got on the chain |
| `{ "$hash": { "kind": "job", "of": … } }` | A hash the contracts compute themselves | `Crypto.blake2b` of `of`, built as the contract builds it (below) |
| any other 64-character string at a `hash` position | Opaque evidence, a manifest or a commitment's salt | The same 32 bytes for the same string, e.g. `blake2b(string)` |
| `{ "type": "SetSetting", "key": …, "value": … }` | A variant: the constructor, then its arguments in order | That constructor |

Record fields are in the contract's `snake_case`.

The `$hash` kinds are:

| Kind | `of` | The contract computes |
| :--- | :--- | :--- |
| `job` | `{ manifest, consignee }` | `Crypto.blake2b((manifest, consignee))` |
| `terms` | The quoted terms | `Crypto.blake2b(terms)`, the `quote_terms` record |
| `commitment` | `{ name, country, number, salt }` | `Crypto.blake2b((name, country, number, salt))` |

## What a live chain can't reproduce

- **Absolute heights.** The demo starts at height 1, and every step happens at a height it chooses. Arguments that are heights (`deadline`, `valid_until`, `deliver_by`, `expires`) must be rebased onto the chain's height when the trace starts. On testnet the height also moves between steps, so a trace that tests an exact boundary (a refund at the deadline, then one block after) can't be pinned there. Those traces need a local chain that produces blocks on demand (ADR 0014 option A).
- **Arbiter payout order.** FATE maps list their keys in sorted order, so `ArbiterPaid` events come in address order on the chain and in voting order in the demo. Compare each run of `ArbiterPaid` events as an unordered set.
- **Funding.** The demo's opening balances can be large. The runner funds each account with what its trace sends, plus gas, not the recorded `balance`.
