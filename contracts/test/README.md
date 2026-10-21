# Contract traces

The real contracts are tested by replaying the demo suite on a chain ([decision log](../../docs/decision-log.md) #33, [#70](https://github.com/shanepreater/gajufreight/issues/70)).

1. **Record.** `npm run test:traces --prefix scripts/demo` runs every demo test with the recorder on. Each test file writes `<dir>/<file>.jsonl`, one trace per line. The directory is `contracts/build/traces` (not committed) unless `TRACE_DIR` names another.
2. **Encode** offline, with [`replay.escript`](replay.escript). Every step of every trace is built and signed against the compiled contracts, with no node and no funds (below).
3. **Replay and compare** on a node, with [`replay.escript`](replay.escript)'s `run` mode (below). It deploys each trace's contracts, replays every step with throwaway keys, and checks every step's outcome, result, events and balance changes against the demo's.

## The runner

```sh
escript contracts/test/replay.escript plan   [options]   # which traces fit, and what they cost
escript contracts/test/replay.escript encode [options]   # build and sign every step offline
escript contracts/test/replay.escript run    [options]   # replay on a node and compare
```

| Option | Default | Meaning |
| :--- | :--- | :--- |
| `--traces DIR` | `contracts/build/traces` | Where the recorded traces are |
| `--libs DIR` or `zx` | `zx` | A [`build-toolchain.sh`](../tools/build-toolchain.sh) build, or the pinned zx packages |
| `--max-blocks N` | `plan`: 0; `encode`: any | Only traces that wait at most N key blocks in all |
| `--max-value PUCK` | `plan`: 10¹⁸ (1 Gaju); `encode`: any | Only traces whose accounts send at most this much in all |
| `--limit N` | all | At most N traces, sampled by `--seed` |
| `--seed N` | 1 | The sample's seed, so a run can be repeated |
| `--only FILE:N` | none | Just that trace, such as `shipment-escrow.test.js:245`, whatever the budget |
| `--node HOST:PORT` | `tsuriai.jp:4013` | `run`: the node. Groot testnet's own host has been down since 2026-10-18 ([QPQ Q&A](../../docs/qpq-q-and-a.md#node-api)) |
| `--funder FILE` | `gaju-private/testnet-funder.json` | `run`: the throwaway funder key ([decision log](../../docs/decision-log.md) #36), never committed |
| `--concurrency N` | 8 | `run`: traces replayed at once. Each uses only its own accounts |

`encode` does what a live run does up to submitting each transaction:

- It compiles `Platform` and `QuoteRequest`, and each escrow template with its platform's address in place of `PLATFORM_ADDRESS`.
- It derives a key for every account from the trace and its label, and gives each contract a made-up address.
- It converts every argument to FATE by the contract's types, through Hakuzaru's typed conversion. It rebuilds each `$hash` the same way, and rebases heights.
- It builds and signs every deploy and call, and builds every view.

**What it proves, and what it doesn't:**

- **Call data matches the proven path.** Before encoding, a self-check builds calls with a hash, an option, a record, a tuple and variants both ways: from the runner's FATE, and through Hakuzaru's Sophia-literal path, which the Phase 0 spike used on testnet. The call data must be identical.
- **Why that check exists.** Hakuzaru 0.9.1's `{erlang, …}` conversion leaves `hash` and `bytes` values as bare binaries, which FATE serialises as strings. So the runner wraps them as `{bytes, …}` itself and passes `{fate, …}`. The tx-builder uses the Sophia-literal path, so it isn't affected.
- **Rebuilt hashes aren't checked against the chain here.** `encode` proves they convert, not that they're the value the contract computes. The first live run pins them: a wrong terms hash fails `accept` with `TERMS_CHANGED`, and a wrong job hash fails `book` with `NOT_AGREED`.

All 1,759 replayable traces encode. CI encodes a fixed sample of them on every PR, so a demo change the contracts' ABI can't carry fails before any chain run. Running all of them locally takes about 2.5 minutes.

`run` does what `encode` does, then sends each step and compares it:

- **Funding.** The funder tops up every account the chosen traces use: the value it sends, a gas allowance per step, and one gas limit, which the node checks a caller can cover. Keys come from each trace's id, so a re-run needs only the difference.
- **Outcome and result.** A step that the demo rejected must revert with the same code. A step that succeeded must return the same value, converted to FATE by the function's return type. A contract that a call creates is labelled from the address the chain returns. A view is a dry run from an account the node is told exists.
- **Events** must match in the order they were emitted: name, contract, and every field. The node lists a call's log newest first, so the runner reverses it. An `int` field may also differ by the run's height offset, as events don't name their fields.
- **Balances.** Every watched account must change exactly as the trace says. Only the caller pays gas, and nothing else creates or destroys value, so the caller's change in value is minus everyone else's change. What's left of its balance change is the gas, which must be positive and within the limit. That makes every value check exact, without knowing the transaction's size-based charge.
- **Not sendable:** steps the demo failed with `INSUFFICIENT_BALANCE`, `UNKNOWN_ACCOUNT` or `BAD_VALUE` are counted and skipped (below).
- **Timing.** Testnet keeps producing blocks while a trace runs. A step that expired early (`BAD_DEADLINE`, `CONFIRM_EXPIRED`, …) when the demo succeeded, or succeeded when the demo was still waiting (`NOT_EXPIRED`, `CHALLENGE_OPEN`, …), is reported as **timing-sensitive** rather than a mismatch, but only once the chain is past the step's mapped height. Re-run such a trace alone with `--only`, and on a local chain once there is one.
- **Testnet hardening.** The funder funds in mined batches of 10 and counts its own nonces. A post the node rejects is retried for a minute, and reads are retried when the node times out. Creates are built one at a time, because Hakuzaru 0.9.1 bundles a create's source by changing the whole VM's working directory.
- **Gas.** The report lists execution gas per entrypoint and per create, including `Platform.book` and `Platform.new_quote` (#63).

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

- **Absolute heights.** The demo starts at height 1, and every step happens at a height it chooses. The runner gives each trace one offset: the chain's height when the trace starts, minus 1. That offset applies to every height alike, in arguments, in rebuilt hashes and in results, so a quote's terms and the hash accepted later agree. The heights are `deadline`, `valid_until`, `deliver_by` and `expires`.
  - An `advance` waits until the chain reaches the mapped height.
  - On testnet the chain also moves between steps, so deadlines come effectively sooner. Traces that test an exact boundary (a refund at the deadline, then one block after) can diverge there. The report flags those as timing-sensitive (above); they need a local chain that produces blocks on demand (ADR 0014 option A).
- **Arbiter payout order.** FATE maps list their keys in sorted order, so `ArbiterPaid` events come in address order on the chain and in voting order in the demo. Compare each run of `ArbiterPaid` events as an unordered set.
- **Funding.** The demo's opening balances can be large. The runner funds each account with what its trace sends, plus gas, not the recorded `balance`.
