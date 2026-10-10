# Phase 0 spike: verifying QPQ's answers on testnet

| | |
| :--- | :--- |
| **Status** | Round 1 complete 2026-10-05; round 2 (E9, E9b, E12, E14–E18 and a node API survey) complete 2026-10-06. E13's 24-hour fork watch complete 2026-10-09 |
| **Last reviewed** | 2026-10-09 (E13) |
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
| E9 | Q8 GRIDS | A call signed from a dead-drop request lands on-chain | ✅ Run in round 2: see [round 2](#round-2-2026-10-06) | |
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
- GajuDesk 0.9.0's transaction signing dialog shows only the raw `tx_…` data, so the user can't see the contract, function, amount or fee they're signing (round 2, E9). Its window is also titled "Message Signature Request".
- Mainnet's node (0.1.0+211) lacks testnet's finality endpoint and SSE subscriptions, and its `/api` returns 500.
- `POST /dry_run` with `tx_events: true`, as Hakuzaru's `hz:dry_run` sends it, returns "Internal server error" on testnet's node, every time (2026-10-07). Without `tx_events` it works. It probably caused E10's earlier failures.

## Round 2 (2026-10-06)

QPQ hadn't yet answered the follow-ups, so round 2 settled what experiments can: cloning cost, the node API, GRIDS, the handover question and fees, plus the design audit's probe E12.

- **Scripted probes:** `run-probes.escript <key-file> round2` and `… fees`, with the same throwaway runner key. Round 2 and the fee run together cost the runner about 0.007 test Gaju.
- **E9:** a developer signed three requests in GajuDesk 0.9.0 as **Seller**. The requests were built by `run-probes.escript grids-build`, served by [grids_dead_drop.py](../../contracts/spike/grids_dead_drop.py) on `localhost`, and checked and submitted by `grids-submit`. No key left the wallet.
- **New probes:** [probe-sized-escrow.aes](../../contracts/spike/probe-sized-escrow.aes) (the HLD escrow's own logic, 4.4 KB of bytecode), [probe-booker.aes](../../contracts/spike/probe-booker.aes), [probe-leg.aes](../../contracts/spike/probe-leg.aes) with [probe-handover.aes](../../contracts/spike/probe-handover.aes), and [probe-payability.aes](../../contracts/spike/probe-payability.aes).

| # | Verifies | Result | Evidence |
| :-: | :--- | :--- | :--- |
| E9 | GRIDS dead drop, payable contract call (Q8, GRIDS follow-ups 1, 4) | ✅ GajuDesk fetched `grid://localhost:8765/1/d/book.json` over HTTP, showed the signing dialog, and **posted** `{grids, chain, network_id, type, public_id, payload: <signed tx>, signed: true}` back to the same URL. It **doesn't submit the transaction itself**: the requesting service does. The relay checks passed (the inner transaction was byte-identical to the one built, and the Ed25519 signature over network id + transaction hash was valid for `public_id`). Once submitted, Seller's `book` call cloned and funded an escrow, `ct_g6Q3Rq3U5GffqLurmFRkAJgy16RP3DBmpbv2zwanjsfTTkCY8`, in one signature | `th_2VostEFgHfbwqqU2jvDtmDPAANpmTjqHqL9V7q58B44cJFwYPH` |
| E9 | GRIDS create (GRIDS follow-up 2) | ✅ A **funded contract create** signed over GRIDS works the same way: Seller deployed a probe escrow holding 0.001 Gaju | `th_CNxBRKBy9kSrgWcex5v7N3Ncp277mc7JAYHpLcuusAGLhcX6r` (`ct_kgvNqGSTG6FHMUW3yg6bLQs5aM2gom96UqGN5onCS59eSQW5o`) |
| E9 | What the wallet shows (GRIDS follow-up 3) | ⚠️ The dialog shows the account, chain, network ID, originating URL and the **raw `tx_…` data**: no contract, function, arguments, amount or fee ([screenshot](images/gajudesk-tx-signature-dialog.png)). The text matched the served payload byte for byte. A user can't see what they're signing, which is design audit F11's payload-swap risk | screenshot |
| E12 | `Address.is_payable` | **True for an account that has never received funds**, true for funded accounts and payable contracts, false for a non-payable contract. The HLD's `NOT_PAYABLE_PARTY` check won't block new accounts | dry runs on `ct_gpSPAbzfKkVCkHGuVyFaoEAMrLQCLJhEtom8rYB3sLX6vYKAe` |
| E12 | `Chain.spend(a, 0)` | Succeeds to a funded account and to an unfunded one (which **creates** that account with balance 0). To a non-payable contract it fails as `error`, using 17,380 of the 200,000 gas given. Skipping zero amounts (the HLD's `pay` helper) avoids both effects | `th_jQtZAaueQNQgF9tDd4rooyfrpNakCWihMS5QbdM5bASoWGi32` · `th_b7DXe8zwoWfSj2z2h17hB5ZmAktH7b9s3HhML6nVPRwFzPRtA` · `th_2gnN4UWXWGnJVpFJcNgVnaqxy8x73w2FKBeWKCdQ1bi6SxoWeu` |
| E14 | Clone vs create at a realistic size (Cloning follow-up 3) | Create of the 4.4 KB escrow (7.4 KB source): **2.23 × 10¹⁴ puck** in total. A funded clone through a booking contract: **2.01 × 10¹⁴ puck**. That's only 10% cheaper at this size, because a call's fixed charge is larger than a create's (E18). The gap grows with size: each byte of code plus source adds about 11.5 gas to a create, so a full escrow (estimated 6–7 KB of code and 12 KB of source) would cost about 3 × 10¹⁴ to create against about 2 × 10¹⁴ to clone | `th_tfY45HZNR6Dt4ksG8TthF9EcauaJPb3TpQmpgZGxrdEuYsyr1` · `th_GN2FyCvAjqJXaDXe4AyFVsa7Zke3sVkG9xFm6A749JTmK5jUj` |
| E15 | Clone events reach an indexer | ✅ The clone's `init` event (`Booked`) is in the **booking transaction's** log, under the clone's own address. An indexer following the booking contract discovers each new escrow from it | `th_GN2FyCvAjqJXaDXe4AyFVsa7Zke3sVkG9xFm6A749JTmK5jUj` |
| E16 | One contract call for a handover (batching follow-up 1) | ❌ **A wrapper can't act for its signer.** A leg that requires `Call.caller == attestor` rejected the wrapper (`UNAUTHORIZED`). The leg saw the wrapper as `Call.caller` and the signer only as `Call.origin`. If the second inner call fails, the first rolls back. Trusting `Call.origin` would let any contract a user calls act as them, so a handover stays two signatures | `th_29YBXoQHxck3pbvhHnHKx75fpKN6ZNTtMTW4jjSVtVqNDA9rAH` · `th_2kciS8ioDGXr9pqPC6SVLRgAgaJS7xydnh5XyduMBcj86BV7rw` · `th_2JHPvANLj4L6LxiHj1B3YM8qftyrqopWgAve5My8QD74VxWZyv` |
| E17 | Minimum gas price (Fees follow-up 1) | A call at 10⁸ or 999,999,999 puck/gas is **rejected when posted** (`Invalid tx`), so it never sits in the pool blocking later nonces. 10⁹ is the floor (Hakuzaru's `min_gas_price`, from the node's `minimum_miner_gas_price`). The last 60 transactions on mainnet all paid 10⁹ or 10⁹ + 2 | post responses; mainnet scan of heights 504,567–504,765 |
| E18 | What a transaction costs (Fees follow-up 1) | **Unused gas isn't charged:** the same call cost the same with a 200k or a 5M limit. Every **contract call** carries a fixed charge of about **182,600 gas** (1.83 × 10¹⁴ puck, 0.00018 Gaju) plus its execution gas (114 for a read, about 5,000 for a spend, 16,313 for a clone with `init`). A **create** carries about 88,000 plus about 11.5 per byte of code and source. So a booking costs about 0.0002 Gaju, and each quote round or checkpoint about 0.00019 | `th_ugxDNK1HNdRxcsV7HAiy6dDMF1UaJt7rfMHkgoLWHM83Bgq5D` · `th_2CjwtYnbjZDtr7pCiooAEyGiV27xXCvqe44haNYN3yRsuXLJMn` · `th_2e9e1dujzHQ3fQC4gbPMjtbH1N7tifkL5ELizQk9bjntJPSNhu` · `th_d5njDaG6Ve97d6JU12SK4nD2Uvcb8egygsR7KiWZUDvtobJDR` |

### Node API survey (Node API follow-ups 1–5)

Read-only, against both networks on 2026-10-06.

| Question | Finding |
| :--- | :--- |
| Where is the spec? | The node serves its **OpenAPI document at `GET /api`** (testnet; mainnet returns 500). It lists every endpoint, including internal ones |
| Events and microblocks (1) | `GET /generations/height/{h}` → `/micro-blocks/hash/{mb}/transactions` → `/transactions/{h}/info` (log with contract address, topics, data). **Testnet's node (0.1.0+287) also pushes Server-Sent Events:** `/contracts/{id}/events/subscribe` (optionally filtered by payload), `/contracts/{id}/calls/subscribe`, `/headers/top/subscribe` and `/accounts/{id}/balance/subscribe`, each with optional key-block heartbeats. A `top_changed` stream was received live. **Mainnet's node (0.1.0+211) has none of these (404)**, so for now the indexer polls on mainnet and can subscribe on testnet |
| Finality (2) | Testnet has `GET /transactions/{h}/finality`, which returns a status (`pending → on_chain → parent_progress → parent_final → final_progress → final`), the microblock and its `depth` in key blocks. Testnet has **no witnesses**: `/status` reports `finalized` at genesis, key blocks carry no testimonies, and a transaction 734 key blocks deep is still `on_chain`. **Mainnet has witness finality:** `/status` reports `finalized` at top − 1 (`type: witness`), and `/key-blocks/height/{h}/testimonies` lists signed testimonies. Mainnet's node lacks the finality endpoint |
| An encoding endpoint (3) | `POST /debug/contracts/call` and `/debug/contracts/create` return an unsigned transaction, but they take **pre-encoded call data** and are internal (not on the public port). No endpoint encodes FATE values, so the tx-builder ([ADR 0012](../adr/0012-transaction-building-and-grids-relay.md)) is still needed |
| Rate limits (4) | None seen: 120 requests at 12-way concurrency all returned 200, with no limit headers. The spec caps concurrent SSE subscriptions per node (`http_event_subscribe`, 503 when full) |
| HTTPS (5) | Not yet for the API: `https://groot.testnet.gajumaru.io/v3/status` and the mainnet equivalent return 404, and port 3013 doesn't speak TLS |

### E9b: GajuMobile (2026-10-06)

**Setup:**
- GajuMobile 0.2.1 (`swiss.qpq.gajumobile`) in an Android 17 emulator (arm64), with the developer's testnet account `ak_bc9Lb7CT9aZxZYY1DCDmSCvTiuzuCahBDzxVLg1sz5K3kNF17`. The key stayed in the emulator.
- Requests were sent as `adb shell am start -a android.intent.action.VIEW -d <grids URL>`, exactly what tapping a link does.
- The dead drop was reached through a temporary Cloudflare quick tunnel to [grids_dead_drop.py](../../contracts/spike/grids_dead_drop.py), closed straight after the test. After review, the dead drop now serves and accepts only request names carrying a 128-bit random token, so the tunnel host alone isn't enough to answer a request first.
- An emulator doesn't test the camera, real field connectivity or iOS. The pilot (H3) covers those.

| Check | Result | Evidence |
| :--- | :--- | :--- |
| Deep links (GRIDS follow-up 6) | ✅ GajuMobile registers `grid://` and `grids://` as browsable view links on its main activity, and Android routes our dead-drop URLs to it. A link in the field web app opens the wallet directly | `dumpsys package`, `query-activities` |
| HTTP vs HTTPS | ⚠️ **GajuMobile only fetches over HTTPS.** It has no cleartext permission (targetSdk 37), so a `grid://` (HTTP) request fails silently: it logs the fetch, and the request never arrives. `grids://` over the tunnel worked. The phone dead drop must be a trusted public HTTPS host (ADR 0012) | logcat `GajuRouter`; dead-drop log |
| Sign-in message | ✅ Shows the account's wallet name and address, the originating URL and the full message ([screenshot](images/gajumobile-message-signature.png)). It posts back the same response format as GajuDesk, and the signature verifies against the issued challenge | dead-drop log; `grids-submit` |
| Payable contract call | ✅ Signed and posted back. Our relay checks passed, and the call booked and funded a clone (`ct_KYZRPCf1sWAU4xzq9oYXYoadCWdgLoCqc5AAd18QVekt6Vk5x`, 0.001 Gaju). ⚠️ As in GajuDesk, the screen shows only the raw `tx_…` data: no contract, function, amount or fee ([screenshot](images/gajumobile-tx-signature.png)) | `th_2FQ5szDEYJzaZBDNKtg22GzMzrNsBjA6VjL2cZ5hhk8Bx1TXsn` |
| Offline (GRIDS follow-up 7) | ❌ **It can't sign offline, and fails silently.** In airplane mode it tried to fetch, then returned to the wallet home screen with no error. When the network came back it didn't retry, so the request was lost and the link must be opened again | logcat; no request reached the dead drop |
| Screenshots | GajuMobile marks its window secure, so screenshots from inside Android are black (good for a wallet). The emulator window can be captured from the host | `dumpsys window` |
| Balance display | Showed 木10 when the account held 9.9988 Gaju after the booking: rounded, or read before the payment | account at `/v3/accounts` |

## Still to run

| # | Verifies | Pass if |
| :-: | :--- | :--- |
| E13 | Finality depth (Q17) | Watch testnet and mainnet microblocks for a day, record every fork and the deepest, and compare mainnet's witness finality lag with that depth. **Result (24 h to 2026-10-09 19:45 UTC):** testnet, 0 forks in 715 key blocks. Mainnet, 1 microblock fork in 726 key blocks: at 14:14 UTC two microblocks of generation 506,975 (key block `kh_2aNzGD9Y…EjpK7B`) were dropped, `mh_2prTNTiV…YYdHqB` and `mh_ceLBF623…uATaF3`, 2 key blocks below the top (`kh_1L83yGAc…zJ1u` at 506,977), while witness finality sat at 506,974, so nothing dropped had been final under the witness rule. Witness lag: median 1, max 2. Mainnet's node also answered a by-height read of the generation below the top with the top one 3,064 times (logged as anomalies, reported to QPQ). **Testnet depth set to 3** (deepest fork plus one). The fork record with full hashes, the readings where lag reached 2, the key blocks around the fork and the run summary are in [`e13-fork-watch-extract.jsonl`](e13-fork-watch-extract.jsonl); the full 8 MB recording is kept by the project owner, outside the repo |

## What it means for the design

- **Funding checks read `Contract.balance`, not `Call.value`, in `init`** (E2, E2b, E3, E4). Booking is still one transaction, and clones can still be funded in the same call, so atomic booking (ADR 0005) and the leg bond (ADR 0010) stand, but every `init` that checks `Call.value` must change. A create's address is predictable, so someone could send funds there first and make an exact-balance check fail; the booker retries (a new nonce gives a new address) and the sender loses what they sent.
- **`Chain.clone` and `Chain.create` work from a contract, with value** (Q1, Q12 verified). Round 2 measured the *total* cost, not just gas (E14, E18). A clone costs a contract call's fixed charge (about 182,600 gas) instead of a create's per-byte charge for code and source. At 4.4 KB that's only 10% cheaper; at the full escrow's size it's about a third cheaper, and the chain stores no new copy of the code.
- **Payouts to accounts need no co-signature** (Q6 verified). **A payee that is a contract must be payable**, or the payout fails and burns the transaction's gas (E6b): the org-level attestor contract (Q15) and any contract payee must be `payable`.
- **The indexer can recognise events by name hash and rebuild agreement hashes off-chain** (E7, E7b, E8), so it doesn't need contract sources at runtime.
- **The fee can be estimated before signing, but not from `/dry_run` alone** (E10, E18). A dry run returns execution gas only. The fee shown must add the fixed per-transaction charge (about 182,600 gas for a call), or the app would show about 3% of the real fee for a simple call. Unused gas isn't charged, so a generous limit costs nothing. At the 10⁹ floor, a quote round or checkpoint costs about 0.00019 Gaju, and a booking about 0.0002.
- **`Chain.bytecode_hash` supports the platform-fee checks** (E11, E11b): leg parents and `Platform.add_leg` callers can be verified by code hash.
- **Wallet signing works today, and the relay design holds** (E9, [ADR 0012](../adr/0012-transaction-building-and-grids-relay.md)):
  - GajuDesk signs and posts back without submitting, so our relay submits and can check every response first. Those checks are proven.
  - Both a payable call and a funded create work over GRIDS, so booking doesn't depend on either path ([ADR 0011](../adr/0011-agreed-booking-terms.md)).
- **The wallet shows raw transaction data** (E9), so nothing in the wallet stops a swapped payload. The dashboard must pin contract addresses and show contract, function and amount before signing, until GRIDS's safer call request ships (design audit F11, issue #118).
- **A handover stays two signatures** (E16). A batching contract can only act as itself.
- **The payability and zero-spend guards in the HLD sketch are right** (E12): `is_payable` doesn't refuse new accounts, and skipping zero amounts avoids creating empty accounts or erroring on contracts.
- **The indexer can discover clones from the booking transaction's log** (E15). On a node with SSE it can subscribe instead of polling, but mainnet's node doesn't have SSE yet, so the indexer must support polling and treat subscriptions as an optimisation. That's another reason to run our own node, at a known version.
- **Finality differs by network.** Mainnet finalises by witness at about top − 1. Testnet has no witnesses, so it relies on depth. N stays a per-network setting (Q17), read from witness finality where the node offers it.
- **Compiling the HLD escrow found two sketch bugs.** The `Refunded(int)` event clashes with the `Refunded` status (constructors must be unique across datatypes), and a continuation line can't start with `&&`. Both are fixed in the HLD.
- **Phones need an HTTPS dead drop, and signing is online only** (E9b):
  - GajuMobile refuses plain HTTP and drops a request it can't fetch, without telling the user.
  - The field app must therefore keep its own offline queue (ADR 0012 decision 5), open the link again once there's signal, and show the request as unsigned until the dead drop receives the response.
- **Still open:** the Q&A follow-ups that only QPQ can answer (chased 2026-10-09).
