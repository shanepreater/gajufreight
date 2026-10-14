# Contract traces

The real contracts are tested by replaying the demo suite on a chain ([decision log](../../docs/decision-log.md) #33, [#70](https://github.com/shanepreater/gajufreight/issues/70)).

1. **Record.** `npm run test:traces --prefix scripts/demo` runs every demo test with the recorder on. Each test file writes `<dir>/<file>.jsonl`, one trace per line. The directory is `contracts/build/traces` (not committed) unless `TRACE_DIR` names another.
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
| `deploy` | `height`, `caller`, `contract`, `args`, `value`, then `as` or `error`; a `ShipmentEscrow` also has `platform` | `caller` creates `contract` (`Platform`, `QuoteRequest` or `ShipmentEscrow`), known from then on as `as`. An escrow is compiled with its `platform`'s address in place of `PLATFORM_ADDRESS` |
| `call` | `height`, `caller`, `contract`, `function`, `args`, `value`, then `result` or `error` | `caller` calls `function` on the contract labelled `contract` |
| `view` | `height`, `contract`, `function`, `args`, then `result` or `error` | A read-only call (a dry run) |
| `advance` | `keyblocks` | That many key blocks pass |

**Arguments** are positional, in the order of the contract's ACI ([`contracts/interface/`](../interface/)). The model's argument names are mapped to the contract's in [`scripts/demo/lib/contract-interface.js`](../../scripts/demo/lib/contract-interface.js), and drift tests check that mapping against the ACI.

**A step that succeeded** also records:

- `events`: `[{ contract, event: [name, …fields] }]`, in the order they were emitted, with fields in the contract's order.
- `balances`: `{ label: change }` for every balance that changed. The demo has no gas, so the runner adds each caller's transaction costs back before comparing.

**A step that failed** records `error`: the contract's error code, such as `BAD_STATE`. Nothing else changes.

## Values

Every argument, result and event field is encoded as the contract's ACI type at that position, so the runner can build it directly. A model value that doesn't fit its type marks the trace unreplayable, with the reason. Examples are a fraction where an `int` goes, an account where a contract goes, or a field the record lacks.

| ACI type | JSON | Notes |
| :--- | :--- | :--- |
| `int` | a number, or `{ "$int": "123" }` | `$int` for amounts in puck and anything else that was a bigint in the model |
| `bool`, `string` | itself | |
| `address` | `{ "$addr": "shipper" }` or `{ "$addr": "ShipmentEscrow#2" }` | An account by name, or a contract by kind and creation order in this trace. The runner maps each to its real address |
| a contract (`QuoteRequest`) | `{ "$addr": "QuoteRequest#2" }` | Always a contract label, never an account |
| `hash`, `bytes(32)` | a 64-character string, or `{ "$hash": { "kind", "of" } }` | A plain string is opaque (evidence, a manifest, a salt): the runner turns the same string into the same 32 bytes, e.g. `blake2b(string)`. `$hash` is a hash the contracts compute themselves (below), and appears only at `hash` positions |
| `option(t)` | `null` for `None`, otherwise the `t` value | An option field the model leaves out is `None` |
| `list(t)`, `tuple(…)` | an array | A unit result `()` is `[]` |
| a record | an object with the contract's `snake_case` fields, in the contract's order | |
| a variant | `{ "$variant": ["Name", …args] }` | E.g. `{ "$variant": ["Arbiter"] }`, `{ "$variant": ["SetSetting", "fee_bps", 5] }` |

**Results** that the model returns in a shape the contract doesn't use are recorded as `{ "$untyped": reason }`. The comparator skips them, and the trace stays replayable.

**Calls the model makes looser than a client could.** A quote's terms keep only the `quote_terms` fields, with `attestors: []` and `replace: None` when absent. This happens in [`contract-interface.js`](../../scripts/demo/lib/contract-interface.js) (`ARG_TO_CONTRACT`), as the typed record does on-chain.

The `$hash` kinds are:

| Kind | `of` | The contract computes |
| :--- | :--- | :--- |
| `job` | `{ manifest, consignee }` | `Crypto.blake2b((manifest, consignee))` |
| `terms` | The quoted terms | `Crypto.blake2b(terms)`, the `quote_terms` record |
| `commitment` | `{ name, country, number, salt }` | `Crypto.blake2b((name, country, number, salt))` |

## Errors

`error` is the contract's code, for example `BAD_STATE`, which the chain returns as the call's revert message. SimChain also has codes for failures that happen before any contract code runs. On a chain, the runner matches each of these against a rejected transaction rather than a revert message:

| SimChain code | On a chain |
| :--- | :--- |
| `NOT_PAYABLE` | Value sent to an entrypoint that isn't `payable` |
| `INSUFFICIENT_BALANCE` | The caller can't cover the value |
| `UNKNOWN_ACCOUNT`, `BAD_VALUE` | No valid transaction to send |

## What a live chain can't reproduce

- **Absolute heights.** The demo starts at height 1, and every step happens at a height it chooses. Arguments that are heights (`deadline`, `valid_until`, `deliver_by`, `expires`) must be rebased onto the chain's height when the trace starts. On testnet the height also moves between steps, so a trace that tests an exact boundary (a refund at the deadline, then one block after) can't be pinned there. Those traces need a local chain that produces blocks on demand (ADR 0014 option A).
- **Arbiter payout order.** FATE maps list their keys in sorted order, so `ArbiterPaid` events come in address order on the chain and in voting order in the demo. Compare each run of `ArbiterPaid` events as an unordered set.
- **Funding.** The demo's opening balances can be large. The runner funds each account with what its trace sends, plus gas, not the recorded `balance`.
