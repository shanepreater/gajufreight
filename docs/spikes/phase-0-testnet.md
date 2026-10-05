# Phase 0 spike: verifying QPQ's answers on testnet

| | |
| :--- | :--- |
| **Status** | Complete except E9; E9b, E12 and E13 added by the design audit (2026-10-05) |
| **Last reviewed** | 2026-10-05 |
| **Related** | [HLD §7](../hld.md#7-open-questions) · [QPQ Q&A](../qpq-q-and-a.md) · [dev approach §3](../dev-approach.md#3-delivery-phases) · [probes](../../contracts/spike/README.md) |

QPQ answered most of the HLD §7 protocol questions. Phase 0 can't exit until those answers are checked on Groot testnet (hard rule 7). This spike deploys small probe contracts with GajuDesk, verifies each result read-only through the node HTTP API, and records the evidence. It's also our first real deployment, and the deploy runbook will be written from it.

**Who does what:** a developer runs GajuDesk and signs with their own testnet key, and every result is checked with `curl` against the node and recorded with its transaction hash. Keys never enter the repo or our services (hard rule 1).

**Scripted runs (amended 2026-10-05, approved by the project owner):** running each probe by hand in GajuDesk was slow and error-prone, so [run-probes.escript](../../contracts/spike/run-probes.escript) runs E2–E8, E10, E11 and E11b. It signs with a **throwaway testnet key** generated for the spike and held only on the developer's machine, outside the repo, funded with 1 test Gaju. It's a test key, not a user key, so it's within hard rule 1 and the `infra` skill's per-run test keys. E9 (GRIDS) still goes through a wallet.

## Environment

| Item | Value |
| :--- | :--- |
| Node | `http://groot.testnet.gajumaru.io:3013/v3` (`network_id` `groot.testnet`, node 0.1.0+287) |
| Wallet | GajuDesk 0.9.0 (`zxh run gajudesk`), Hakuzaru 0.9.1 |
| Compiler | Sophia 9.0.0 |

## Test accounts

Testnet only. Each key stays in the owner's GajuDesk wallet. An account exists on-chain only once it has received funds. On 2026-10-05 each was funded with 10 Gaju from the faucet, and the node reports each as `kind: basic`, `payable: true`.

| Role | Address | Used for |
| :--- | :--- | :--- |
| GajuFreight (platform) | `ak_YpyBQTAAj5jh7ZVZJkhK57XRTr4nLVXSJfAbWN4RoNsSibu3L` | Deploys `ProbeFactory` (E3, E4), as the platform will; later the fee treasury |
| Seller (shipper) | `ak_2PCbi13jh5vwzBqChzaqhaU9xugY3T6UWwJkL4GMhbHkeRF4ZH` | Deploys and funds `ProbeEscrow` (E2), as a shipper books; signs E9 |
| Forwarder | `ak_2AR1PLKMGzGqU96BbigPtvKz7RA6NiaJvzHkXcuUSc8Ps1Ao7c` | Phase 1 |
| Courier | `ak_2qUaM6oGvVFiDboExbhtXRo5FBwUPUuH2baWaaGs2prJAU1Zv9` | E6 payout recipient |
| Courier 02 | `ak_2srNcriPqhuTdEFLXwHBJqaLudA2LA2Pz5C29aEjGviYbDRF8x` | E6 second payout recipient |
| Consignee | `ak_238YPY9fCicRub3mUzdwj5EJPciqrur5aw5vnNqmRFFUy2DwPh` | Phase 1 |
| Admin 01–03 | `ak_QFLZkoenPCsh18sJbwQviTva7se9Tb8fCWTVdGWpQTngiS4Vi` · `ak_23miWnePojiwtF71C2fmMkiUdmWcZigVJLX4f6y58wPibhQxSw` · `ak_2vEyY54XZZZ2qkcRvjXYfz9hAcSs9zcojrxLKEeSjA3NTTFfTc` | Phase 1 `Platform` admin quorum |

## Findings before deployment

Found by compiling locally and reading the Hakuzaru and GajuDesk source (GPL3; read, not copied):

1. **`init` can't be `payable` in Sophia 9.** The compiler rejects it: value can be attached to a create transaction without the annotation. The HLD sketch's `payable entrypoint init` must drop `payable`; atomic booking still works if E2 passes.
2. **`Chain.clone(ref = c, value = v, ...)`** is documented in the Sophia 9 stdlib at a fixed gas cost, and `Chain.create(value = v, ...)` charges gas linear in the child's bytecode size. Both compile in a contract (`probe-factory.aes`).
3. **GRIDS for contract calls is a "dead drop".** The wallet opens `grids://<host>/1/d/<path>` (or `grid://` for HTTP), fetches JSON from `https://<host>/<path>` and posts the response back to the same URL. A transaction request is `{"grids": 1, "chain": "gajumaru", "network_id", "type": "tx", "public_id", "payload": <unsigned tx>}`. The response carries the signed transaction in `payload` with `"signed": true`, and the requesting service submits it. GajuDesk 0.9.0 supports `message`, `binary` and `tx` requests. E9 checks this end to end.
4. **The node has `POST /v3/dry_run`** (used by `hz:dry_run`), a candidate for showing a fee before signing (Q11 follow-up 2).

## Procedure

Every account is funded from the [faucet](https://faucet.testnet.gajumaru.io). Use `X = 1000000000000000` puck (0.001 Gaju) wherever an amount is needed. After each step, give the transaction hash and contract address so they can be checked and recorded.

1. **E1** Open `contracts/spike/probe-escrow.aes` and `probe-factory.aes` in GajuDesk and compile both. Note the compiler version GajuDesk reports.
2. **E2** As **Seller**, deploy `ProbeEscrow` with `init(X)` and amount `X`. Then try a second deploy with `init(X)` and amount `0`: it should fail with `WRONG_AMOUNT`.
3. **E5** Call `bump()` once.
4. **E6** As Seller, call `pay(<Courier>, 250000000000000)` and `pay(<Courier 02>, 250000000000000)`.
5. **E8** Call `fingerprint({ price = 100, location = "NLRTM" })` (a dry run is enough).
6. **E3** As **GajuFreight**, deploy `ProbeFactory` (no amount). Call `make()` with amount `X`. The returned `ProbeChild` address is the clone template.
7. **E4** Call `clone_funded(<template address>)` with amount `X`.
8. **E9** Sign one `bump()` call through a GRIDS dead-drop request (set up when we reach this step).

Added during the spike, and run by the runner: **E6b** a payout to a non-payable contract, **E7b** event topics decoded without the source, **E10** dry-run gas estimate, **E11** `Chain.bytecode_hash` of a clone and its template, and **E11b** of a caller still in `init` (both needed by the platform-fee design).

**GajuDesk gotchas** (for the deploy runbook):

- Each **Call Args** field takes a Sophia literal (`1000000000000000`, `"text"`, `{ price = 100, location = "NLRTM" }`). A blank field fails with `{error,[{1,"expected",unexpected_end_of_file}]}`, because GajuDesk 0.9.0 doesn't check for blanks yet. The **Amount** field (puck attached to the transaction) is separate from the arguments.
- **Always declare `init`.** Sophia lets a stateless contract omit it, but GajuDesk 0.9.0 then crashes, closing the whole app, when you open its deploy dialog (`{badkey,"init"}` in `gd_v_call:init/1`). `entrypoint init() = ()` avoids it and doesn't change the bytecode.
- The signing account defaults to the wallet's default key. Pick the right one in the deploy or call dialog before signing.

Read-only checks: `GET /transactions/{hash}/info` (gas used, return value, event log), `GET /contracts/{id}` and `GET /accounts/{id}` (balances), `GET /status` (`finalized`).

## Results

Scripted run on 2026-10-05 (runner account `ak_2h9aNfyyD3VNnS8NJqxJUkr8F1qdxWjh3NHSxuX51TbR24feig`, X = 10¹⁵ puck). Every hash below re-checks with `GET /transactions/{hash}/info`.

| # | Verifies | Pass if | Result | Evidence |
| :-: | :--- | :--- | :--- | :--- |
| E1 | Q9 Sophia 9 | Both probes compile in GajuDesk | ✅ Compiled and deployed from GajuDesk 0.9.0; all four probes compile on Sophia 9.0.0 | `th_7eVSK…` (GajuDesk deploy) |
| E2 | Q12 funded create | Balance = X; amount 0 fails `WRONG_AMOUNT` | ✅ **with a design change.** A create with amount X funds the contract with X in one transaction, but **inside `init`, `Call.value` is 0 and `Contract.balance` already holds X**. Checking `Call.value` reverted a correctly funded create (`th_2gehE…`); checking the balance passes. Amount 0 still fails `WRONG_AMOUNT` | `th_22nSXn5sih6HHQ68Niwi7JQ5kagFMnRYns98kCTjZMr8p2nXnG` (funded) · `th_6uoY4…` (amount 0, signed by Admin 03 by mistake; a revert doesn't depend on the signer) |
| E2b | What `init` sees of a create's amount | Record `Call.value` and `Contract.balance` in `init` | `(Call.value, Contract.balance) = (0, X)` | `th_2vMreAWeCYp7yDSYJgfTaRs2yj91mBp4NvsQtUA96WUeajckVs` · read by `th_2enQ55…` |
| E3 | Q12 `Chain.create` | Child exists, balance X, answers `funded()` | ✅ `make()` with value X created a funded child (balance X); its `init` also saw `Call.value` 0 and balance X | `th_VhYkmceorAxvv3ahYpTB4SVeBrwPZiTTD9yGDikbxFBD8MKF` |
| E4 | Q1 clone, follow-up 1.2 | Clone balance X and its `init` ran | ✅ `Chain.clone(ref = …, value = X)` works from a contract: the clone holds X and its `init` ran (same `Call.value` 0 / balance X) | `th_2A4NxYTAQiqMF7y9yGFvwBGxrRBnB128s7N9e5pF8XW3UgHhcv` |
| E5 | Q1, Q11 gas | Gas recorded for create, `Chain.create`, `Chain.clone`, `bump`, `pay` | ✅ See the gas table | |
| E6 | Q6 payouts | Both recipients' balances rise, no co-signature | ✅ Courier and Courier 02 each received exactly 2.5 × 10¹⁴ puck; no co-signature | `th_2QJfM7wji3PM2c3PHqkJKJVaCRw6mgpFVb3mhKkv8Rbcg7SnQZ` · `th_25YrDawh…` |
| E6b | Payee could be a contract (Q15) | A payout to a non-payable contract fails | ✅ It fails, but as return type **`error`**, not `revert`, and **uses all the gas given** (4,817,360 of 5,000,000) | `th_2vvy3D9r32ymqAMvzNVh5oAvgw2ZScMigCXcLeoUd72Q9SCsEa` |
| E7 | Q7 node API | Event found and decoded for a given contract | ✅ `GET /transactions/{hash}/info` returns each event's contract address, topics (event name hash, then indexed values) and data | `th_22nSXn…` (`Funded(X)`) · `th_2kBZrN…` (`Counted(1)`) |
| E7b | Q7 indexer | Each event's first topic is blake2b of its name | ✅ Both events matched, so the indexer can recognise events without the contract source | as E7 |
| E8 | Q7 follow-up 3 | Hash reproduced off-chain | ✅ `blake2b(gmb_fate_encoding:serialize({tuple, {100, <<"NLRTM">>}}))` equals the contract's `Crypto.blake2b` of the record | `th_2Bj4ur3t1dH2tPrk7T8ubNoGEtufTci9rGv3G8NZoBPjApF8Dz` |
| E9 | Q8 GRIDS | A call signed from a dead-drop request lands on-chain | Not run: needs a wallet; the format is known from the GajuDesk source (finding 3). Follow-up | |
| E10 | Q11 follow-up 2 | Dry-run gas estimate vs actual | ✅ `POST /dry_run` estimated 3,686 gas for `bump`; actual 3,686. (Earlier it returned `Internal server error`, apparently because the account didn't exist yet) | `th_2kBZrN…` |
| E11 | `Chain.bytecode_hash` (ADR 0010, PR #33) | A clone's hash equals its template's and differs from another contract's | ✅ Clone and template hashes match; `ProbeEscrow`'s differs | `th_VF5EyBC6NBeEYfZpiu5dw3HevXJMPwufhkRDhpv9dKDedbGgh` |
| E11b | `Chain.bytecode_hash` of a caller still in `init` | The hash read during `init` equals the caller's hash afterwards | ✅ Match: a contract can check its caller's code while that caller is in `init` | `th_2X7g16bCUcsuBMKYiDArvpKtPLg2GQfn8Z15P23ZD8CLQ2hwjZ` |

## Gas

Gas price 10⁹ puck throughout. A transaction also pays a size-based fee, which dominates for creates.

| Operation | Gas used |
| :--- | --: |
| Deploy `ProbeEscrow` (create tx, `init` checks and emits) | 1,996 |
| Deploy `ProbeFactory` (create tx, no `init` work) | 61 |
| Failed create (`WRONG_AMOUNT`) | 67 |
| `ProbeFactory.make` (`Chain.create` of a small child, funded) | 18,046 |
| `ProbeFactory.clone_funded` (`Chain.clone`, funded) | 12,232 |
| `bump` (small `put` and an event) | 3,686 |
| `pay` (`Chain.spend` and an event) | 9,001 |
| `pay` to a non-payable contract (fails, all gas used) | 4,817,360 |
| `code_hash` (`Chain.bytecode_hash`) | 5,169 |

The whole run cost the runner about 0.019 Gaju, a quarter of it the failed payout to a non-payable contract.

## Observations

- **A create transaction puts the compiled code and the full Sophia source on-chain** (`code` and `source` fields). That matches QPQ's point that storing them is the main cost of a create, which is what `Chain.clone` avoids. It also means our contract source is public, as the privacy standard assumes.
- **Gas is a small part of the cost.** The failed create used 67 gas at a gas price of 10⁹ puck (6.7 × 10¹⁰ puck), but the sender paid 1.04687 × 10¹⁴ puck. The rest is a size-based transaction fee.
- **`/status` reports `finalized` at height 0** (genesis) on testnet, so it isn't a usable finality signal yet (Q7 follow-up 2).
- **`referrer_ids` is empty** for both a created child and a clone, so a contract record doesn't reveal what it was cloned from. Use `Chain.bytecode_hash` (E11).
- **A transaction posted from an unfunded account stays pending on the public nodes but never reaches the miner**, so it blocks every later nonce. Two smoke tests did this; a funded transaction at the same nonce cleared it. The runner now takes its nonce from the mined account state.
- **Testnet has one miner** producing transactions only occasionally, so inclusion can take minutes.
- **The create's `ttl` (479127) was about 10,000 blocks after inclusion.** It looks like how long the transaction stays valid, not a data TTL (Q2 follow-up 1). This needs confirming.

## To report to QPQ

- GajuDesk 0.9.0 crashes deploying a contract with no explicit `init` (log above).
- GajuDesk 0.9.0 accepts a blank argument field and returns an opaque parse error.

## Still to run

From the [design audit](../design-audit.md), tracked in the [implementation blueprint](../implementation-blueprint.md) (S1–S3):

| # | Verifies | Pass if |
| :-: | :--- | :--- |
| E9 | Q8 GRIDS dead drop, end to end | A `Platform.book`-shaped payable call, built unsigned, fetched by GajuDesk from a dead-drop URL, signed and posted back, lands on-chain. Also try a create transaction over GRIDS (GRIDS follow-up 2) |
| E9b | GajuMobile | The same request opens from a deep link on the same phone and signs (GRIDS follow-ups 6, 7) |
| E12 | Zero spends and payability | Record what `Chain.spend(a, 0)` does, and what `Address.is_payable` returns for an unfunded account, a funded account, a payable contract and a non-payable contract |
| E13 | Finality (Q17) | Record microblock forks seen over a day of watching, and the deepest one, to set N |

## What it means for the design

- **Funding checks read `Contract.balance`, not `Call.value`, in `init`** (E2, E2b, E3, E4). Booking is still one transaction, and clones can still be funded in the same call, so atomic booking (ADR 0005) and the leg bond (ADR 0010) stand, but every `init` that checks `Call.value` must change. A create's address is predictable, so someone could send funds there first and make an exact-balance check fail; the booker retries (a new nonce gives a new address) and the sender loses what they sent.
- **`Chain.clone` and `Chain.create` work from a contract, with value** (Q1, Q12 verified). Clone used about a third less gas than create for a tiny child; the saving grows with the child's code size, and a clone also avoids the transaction size fee for the code and source.
- **Payouts to accounts need no co-signature** (Q6 verified). **A payee that is a contract must be payable**, or the payout fails and burns the transaction's gas (E6b): the org-level attestor contract (Q15) and any contract payee must be `payable`.
- **The indexer can recognise events by name hash and rebuild agreement hashes off-chain** (E7, E7b, E8), so it doesn't need contract sources at runtime.
- **The fee can be estimated before signing** with `POST /dry_run` (E10), for the "fee shown before you sign" UX.
- **`Chain.bytecode_hash` supports the platform-fee checks** (E11, E11b): leg parents and `Platform.add_leg` callers can be verified by code hash.
- **Still open:** E9 (GRIDS signing of a call, needs a wallet), finality (`finalized` reports genesis), and the Q&A follow-ups not covered here.
