# Phase 0 spike: verifying QPQ's answers on testnet

| | |
| :--- | :--- |
| **Status** | In progress (started 2026-10-05) |
| **Last reviewed** | 2026-10-05 |
| **Related** | [HLD §7](../hld.md#7-open-questions) · [QPQ Q&A](../qpq-q-and-a.md) · [dev approach §3](../dev-approach.md#3-delivery-phases) · [probes](../../contracts/spike/README.md) |

QPQ answered most of the HLD §7 protocol questions. Phase 0 can't exit until those answers are checked on Groot testnet (hard rule 7). This spike deploys small probe contracts with GajuDesk, verifies each result read-only through the node HTTP API, and records the evidence. It's also our first real deployment, and the deploy runbook will be written from it.

**Who does what:** a developer runs GajuDesk and signs with their own testnet key. Keys never enter the repo or our services (hard rule 1). Every result is checked with `curl` against the node and recorded with its transaction hash.

## Environment

| Item | Value |
| :--- | :--- |
| Node | `http://groot.testnet.gajumaru.io:3013/v3` (`network_id` `groot.testnet`, node 0.1.0+287) |
| Wallet | GajuDesk 0.9.0 (`zxh run gajudesk`), Hakuzaru 0.9.1 |
| Compiler | Sophia 9.0.0 |

## Findings before deployment

Found by compiling locally and reading the Hakuzaru and GajuDesk source (GPL3; read, not copied):

1. **`init` can't be `payable` in Sophia 9.** The compiler rejects it: value can be attached to a create transaction without the annotation. The HLD sketch's `payable entrypoint init` must drop `payable`; atomic booking still works if E2 passes.
2. **`Chain.clone(ref = c, value = v, ...)`** is documented in the Sophia 9 stdlib at a fixed gas cost, and `Chain.create(value = v, ...)` charges gas linear in the child's bytecode size. Both compile in a contract (`probe-factory.aes`).
3. **GRIDS for contract calls is a "dead drop".** The wallet opens `grids://<host>/1/d/<path>` (or `grid://` for HTTP), fetches JSON from `https://<host>/<path>` and posts the response back to the same URL. A transaction request is `{"grids": 1, "chain": "gajumaru", "network_id", "type": "tx", "public_id", "payload": <unsigned tx>}`. The response carries the signed transaction in `payload` with `"signed": true`, and the requesting service submits it. GajuDesk 0.9.0 supports `message`, `binary` and `tx` requests. E9 checks this end to end.
4. **The node has `POST /v3/dry_run`** (used by `hz:dry_run`), a candidate for showing a fee before signing (Q11 follow-up 2).

## Procedure

Use the GajuDesk testnet account funded from the [faucet](https://faucet.testnet.gajumaru.io). Use `X = 1000000000000000` puck (0.001 Gaju) wherever an amount is needed. After each step, give the transaction hash and contract address so they can be checked and recorded.

1. **E1** Open `contracts/spike/probe-escrow.aes` and `probe-factory.aes` in GajuDesk and compile both. Note the compiler version GajuDesk reports.
2. **E2** Deploy `ProbeEscrow` with `init(X)` and amount `X`. Then try a second deploy with `init(X)` and amount `0`: it should fail with `WRONG_AMOUNT`.
3. **E5** Call `bump()` once.
4. **E6** Call `pay(<a fresh address>, X / 4)` and `pay(<your GajuMobile address>, X / 4)`.
5. **E8** Call `fingerprint({ price = 100, location = "NLRTM" })` (a dry run is enough).
6. **E3** Deploy `ProbeFactory` (no amount). Call `make()` with amount `X`. The returned `ProbeChild` address is the clone template.
7. **E4** Call `clone_funded(<template address>)` with amount `X`.
8. **E9** Sign one `bump()` call through a GRIDS dead-drop request (set up when we reach this step).

Read-only checks: `GET /transactions/{hash}/info` (gas used, return value, event log), `GET /contracts/{id}` and `GET /accounts/{id}` (balances), `GET /status` (`finalized`).

## Results

| # | Verifies | Pass if | Result | Evidence |
| :-: | :--- | :--- | :--- | :--- |
| E1 | Q9 Sophia 9 | Both probes compile in GajuDesk | Compiles locally on 9.0.0; GajuDesk pending | |
| E2 | Q12 funded create | Balance = X; amount 0 fails `WRONG_AMOUNT` | | |
| E3 | Q12 `Chain.create` | Child exists, balance X, answers `funded()` | | |
| E4 | Q1 clone, follow-up 1.2 | Clone balance X and its `init` ran | | |
| E5 | Q1, Q11 gas | Gas recorded for create, `Chain.create`, `Chain.clone`, `bump`, `pay` | | |
| E6 | Q6 payouts | Both recipients' balances rise, no co-signature | | |
| E7 | Q7 node API | Event found and decoded for a given contract | | |
| E8 | Q7 follow-up 3 | Hash reproduced off-chain, or recorded as blocked | | |
| E9 | Q8 GRIDS | A call signed from a dead-drop request lands on-chain | | |

## Gas

| Operation | Gas used | Gas price | Fee (Gaju) |
| :--- | --: | --: | --: |
| Deploy `ProbeEscrow` (full create) | | | |
| `ProbeFactory.make` (`Chain.create`) | | | |
| `ProbeFactory.clone_funded` (`Chain.clone`) | | | |
| `bump` (small `put`) | | | |
| `pay` (`Chain.spend`) | | | |

## What it means for the design

Filled in when the results are in.
