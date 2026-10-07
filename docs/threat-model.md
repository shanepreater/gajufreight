# Threat model

| | |
| :--- | :--- |
| **Status** | Draft (2026-10-07), for review. Residual risks below need the project owner's acceptance |
| **Last reviewed** | 2026-10-07 |
| **Related** | [Architecture §2–4](architecture-blueprint.md#4-trust-boundaries) · [HLD §5–6](hld.md#5-contract-sketch-sophia) · [ADR 0011](adr/0011-agreed-booking-terms.md) · [ADR 0012](adr/0012-transaction-building-and-grids-relay.md) · [ADR 0013](adr/0013-off-chain-data.md) · [Design audit F11](design-audit.md) · issue [#46](https://github.com/shanepreater/gajufreight/issues/46) |

**The biggest risk is a swapped transaction.** Both wallets show only raw transaction data (spikes E9, E9b), so a compromised API or relay could get a user to sign a payment to the wrong contract, and nothing in the wallet would warn them. Until QPQ ship the safer call request ([#118](https://github.com/shanepreater/gajufreight/issues/118)), the dashboard has to decode and show what is being signed, itself and independently of the API.

The contracts already carry the controls that matter most for funds: role, then status, then arguments; spends last; no path that freezes funds; agreed terms on-chain. The rest of this document covers what sits around them.

## What we protect

| Asset | Worst case |
| :--- | :--- |
| Escrowed funds | Paid to the wrong party, or locked forever |
| What a user signs | A swapped or malicious transaction signed in good faith |
| Custody and delivery records | A payee attests its own milestone; fake scans or a false delivery |
| Evidence and personal data | Swapped documents; consignee names, addresses and photos leaked |
| Sessions and the API | Acting as another party, or reading their prices and margins |
| Platform admin, treasury, deployer and maintainer keys | A malicious settings change or deployment; a rewritten repository |

## Data flow and trust boundaries

```
  Browser (dashboard, field app)                 Wallet (GajuDesk / GajuMobile)
        │ ① HTTPS + session                            │ ② fetches the request, posts it signed
        ▼                                              ▼
  ┌─────────────────────────── API (public HTTPS) ───────────────────────────┐
  │ sessions · organisations · evidence ingest · GRIDS relay (dead drop)      │
  └───┬───────────────┬──────────────────┬──────────────────────┬────────────┘
      │ ③ localhost   │ ④                │ ⑤                     │ ⑥ submit signed tx
      ▼               ▼                  ▼                       ▼
  tx-builder    operational store   evidence store         Gajumaru node ── ⑦ ── chain
  (no keys)     (PostgreSQL)        (private S3)                 ▲
                                                                 │ ⑧ events, finality
                                                          indexer → read model
  ⑨ external feeds (signed webhooks) → API      ⑩ GitHub: repository, CI, maintainer account
```

## Threats

Likelihood and impact are H, M or L. A **Control** cell names the control in each layer; **Test** is how it's proven. **Owner** is the issue that builds the control.

### Signing and the GRIDS relay (boundaries ② ③ ⑥)

| # | STRIDE | Threat | L / I | Controls | Test | Owner |
| :-: | :-: | :--- | :-: | :--- | :--- | :--- |
| T1 | T | A compromised API or relay swaps the unsigned transaction: another contract, function, amount or payee | M / H | **UI:** the dashboard decodes the unsigned transaction itself (`packages/grids`), checks the contract against addresses pinned at build time, and shows the contract, function, arguments, amount and fee. **Relay:** builds only through the tx-builder. **Later:** the safer GRIDS call request | Playwright: a swapped payload is refused before the QR is shown | [#91](https://github.com/shanepreater/gajufreight/issues/91), [#118](https://github.com/shanepreater/gajufreight/issues/118) |
| T2 | S, E | Someone answers a dead-drop request before the wallet does, or reads someone else's request | M / M | Request names are 128-bit capability URLs; a response must name the request's signer and type; the relay checks the inner transaction and the signature before submitting (the spike's `grids-submit`) | Unit tests: wrong signer, tampered transaction, guessable name | [#77](https://github.com/shanepreater/gajufreight/issues/77) |
| T3 | D | A user's account jams on a transaction that will never be mined (nonce lock) | M / M | Nonce from mined state; one open request per account until its nonce is mined; short TTL | Integration: an abandoned request doesn't block the next | [#77](https://github.com/shanepreater/gajufreight/issues/77) |
| T4 | D | Flooding the public dead drop or sign-in endpoints | M / M | Rate limits per IP and per account at the API edge; request size caps (the spike's drop caps at 64 KiB) | Load test with abusive clients | [#77](https://github.com/shanepreater/gajufreight/issues/77), [#105](https://github.com/shanepreater/gajufreight/issues/105) |
| T5 | I | A plain-HTTP dead drop is read or altered in transit | L / M | Phones need HTTPS anyway (decision log #10); HTTPS everywhere with HSTS | Config check in deployment | [#74](https://github.com/shanepreater/gajufreight/issues/74) |
| T6 | T | The tx-builder runs on unpinned libraries: it loads whichever zx packages are newest on the host | M / H | Pin Hakuzaru and Sophia versions for the service, as `build-sophia.sh` does for the compiler, with checksums; the service image carries exactly those | CI builds the image from pinned sources | **Gap G1** |

### Sessions, the API and data (boundaries ① ④ ⑤)

| # | STRIDE | Threat | L / I | Controls | Test | Owner |
| :-: | :-: | :--- | :-: | :--- | :--- | :--- |
| T7 | S | A sign-in challenge is replayed, or reused on another site | M / H | Challenge bound to domain, network, account, nonce and expiry; verified against the challenge issued, never the text echoed (E9 tamper test); single use | Replay and tampered-message tests | [#82](https://github.com/shanepreater/gajufreight/issues/82) |
| T8 | E | Broken object-level authorisation: `/shipments/{id}` for someone else's shipment | H / H | Every endpoint authorises by party and status, reads included; no payload built for an action the caller can't take | Every endpoint called as every other role | [#81](https://github.com/shanepreater/gajufreight/issues/81) |
| T9 | I | Prices, margins or personal data leak through the API, exports or logs | M / H | Responses filtered by role; logs carry ids and hashes only (security skill); personal data encrypted per shipment | Role-filter tests; log-redaction tests | [#79](https://github.com/shanepreater/gajufreight/issues/79), [#101](https://github.com/shanepreater/gajufreight/issues/101) |
| T10 | T | An evidence document is swapped after its hash went on-chain | L / H | Content-addressed; digest verified on upload and every read; object lock | Swapped-object test | [#80](https://github.com/shanepreater/gajufreight/issues/80) |
| T11 | T, E | A malicious upload: oversized, wrong type, or active content | M / M | Size limits, type sniffing, served as a download with `nosniff`, outside the web root | Upload abuse tests | [#80](https://github.com/shanepreater/gajufreight/issues/80) |
| T12 | S | A guessed delivery code releases payment at once | M / M | 6 digits checked off-chain by the API, locked after 5 tries, and a signed check record in the evidence; without it, the challenge window holds the payment | Brute-force test | [#85](https://github.com/shanepreater/gajufreight/issues/85) |
| T13 | I | A walletless consignee's tracking link is forwarded or guessed | M / M | Unguessable, expiring, revocable capability links showing only the consignee's view | Link-scope tests | [#98](https://github.com/shanepreater/gajufreight/issues/98) |
| T14 | S, T | A forged external feed event (carrier TMS, port) | M / M | Signed webhooks (Ed25519 preferred), a timestamp window, dedupe; feeds only prompt an attestor and never change state | Forged and replayed webhook tests | [#114](https://github.com/shanepreater/gajufreight/issues/114) |

### Contracts and the chain (boundaries ⑥ ⑦ ⑧)

| # | STRIDE | Threat | L / I | Controls | Test | Owner |
| :-: | :-: | :--- | :-: | :--- | :--- | :--- |
| T15 | E | A payee pays itself: attests its own milestone or delivery | M / H | `CONFLICTED_ATTESTOR` in the contract; the API also refuses the payee's staff wallets; removing an attestor needs both parties | Contract and API tests | [#68](https://github.com/shanepreater/gajufreight/issues/68), [#84](https://github.com/shanepreater/gajufreight/issues/84) |
| T16 | D | One party freezes funds: the consignee never confirms, the panel deadlocks, a dispute is raised and abandoned | M / H | Attestors can confirm; deadline refund; arbitration-window fallback; challenge-window release; payee release (ADR 0011) | Liveness tests per path; differential tests | [#65](https://github.com/shanepreater/gajufreight/issues/65)–[#68](https://github.com/shanepreater/gajufreight/issues/68), [#70](https://github.com/shanepreater/gajufreight/issues/70) |
| T17 | T | A look-alike quote or escrow is passed to the platform | L / H | Registry: only quotes and escrows the platform cloned; escrow `init` accepts only the platform as caller (`NOT_PLATFORM`) | Contract tests with look-alikes | [#63](https://github.com/shanepreater/gajufreight/issues/63) |
| T18 | D | Someone pre-funds a predictable clone address so a booking reverts (`WRONG_AMOUNT`) | L / L | The attacker loses what they sent; the booker retries at a new address | Documented (ADR 0005) | Accepted |
| T19 | T | A micro-fork drops a checkpoint or payout the UI already showed | M / M | Pending vs final; final by the network's rule (witness on mainnet); the indexer is reorg-safe; dropped transactions re-posted | Reorg test; fork watch E13 | [#78](https://github.com/shanepreater/gajufreight/issues/78), [#53](https://github.com/shanepreater/gajufreight/issues/53) |
| T20 | E | A bug in a live contract | L / H | External audit; pilot cap; `bookings_open` stops new bookings without touching live escrows; no upgrades to live escrows | Audit; runbook drill | [#107](https://github.com/shanepreater/gajufreight/issues/107), [#103](https://github.com/shanepreater/gajufreight/issues/103) |
| T21 | E | A captured admin quorum changes settings or templates | L / H | M-of-N with proposal expiry; bounded settings (the fee capped at 10%); live escrows keep their terms; keys in hardware wallets | Contract tests on bounds | [#63](https://github.com/shanepreater/gajufreight/issues/63), [#104](https://github.com/shanepreater/gajufreight/issues/104) |
| T22 | D | Gaming the arbitration: a stacked panel or a 0% fallback | M / H | Dispute terms are agreed by both sides and on-chain in full (ADR 0011) | Contract test: an escrow books only the agreed terms | [#64](https://github.com/shanepreater/gajufreight/issues/64), [#65](https://github.com/shanepreater/gajufreight/issues/65) |

### Repository, CI and the maintainer account (boundary ⑩)

| # | STRIDE | Threat | L / I | Controls | Test | Owner |
| :-: | :-: | :--- | :-: | :--- | :--- | :--- |
| T23 | S | A phishing email or stolen session takes the maintainer's GitHub account | M / H | 2FA (passkey or key); review of SSH and GPG keys and tokens; the security log | Account review in the runbook | [#104](https://github.com/shanepreater/gajufreight/issues/104) |
| T24 | T | `main` is rewritten or bypassed | L / H | Ruleset (2026-10-06): signed commits, PR-only, the Quality gate required, no deletion or force push, bypass only through a PR | Ruleset verified by the API | Done |
| T25 | T, E | A malicious workflow from a fork PR, or a malicious dependency | M / H | Approval required for all outside contributors' workflows; actions pinned to SHAs; `permissions: contents: read`; lockfiles; Dependabot; CodeQL | actionlint; CI hygiene review | Done; [#73](https://github.com/shanepreater/gajufreight/issues/73) |
| T26 | T | A compiler or library swapped at its source | L / H | Compiler built from full commit hashes and shown byte-identical to zx (ADR 0014); the same for the tx-builder's libraries (G1) | CI builds from pinned commits | [#50](https://github.com/shanepreater/gajufreight/issues/50), **G1** |
| T27 | I | A secret leaks into the repository or CI logs | L / H | No secrets in the repository; the secret store; CI by OIDC; feedback tokens server-side | Secret scanning on push | [#47](https://github.com/shanepreater/gajufreight/issues/47), [#87](https://github.com/shanepreater/gajufreight/issues/87) |

## Residual risks for acceptance

| # | Risk | Why it remains | Until |
| :-: | :--- | :--- | :--- |
| R1 | A user signs a swapped transaction if both the API and the dashboard's own assets are compromised together | Wallets show raw data only, and the dashboard is the only place that decodes it | The safer GRIDS call request ([#118](https://github.com/shanepreater/gajufreight/issues/118)) |
| R2 | On-chain data is public: agreed terms, leg prices and margins, votes, fee income | A design decision (decision log #4, #5; HLD §6.8) | Permanent, by decision |
| R3 | A physical package label can be copied | Labels identify, signatures authorise (ADR 0003); cloning is made visible, not impossible | Permanent |
| R4 | An attestor is trusted for what it signs | Named per escrow and agreed by both sides; a false attestation surfaces in a dispute | M-of-N attestation ([#113](https://github.com/shanepreater/gajufreight/issues/113)) |
| R5 | Pre-funding a predictable clone address reverts a booking | Costs the attacker the funds sent; the booker retries | Permanent, low impact |

## Gaps found

Each needs your approval before it becomes an issue, or an amendment to the issue named:

| # | Gap | Proposed handling |
| :-: | :--- | :--- |
| G1 | The tx-builder loads whichever zx package versions are newest on the host, including unrelated GajuDesk packages | New issue: pin Hakuzaru and Sophia for the service from source with checksums (as `build-sophia.sh` does), and ship them in its image |
| G2 | Showing what's signed relies on the API's own description | Amend [#91](https://github.com/shanepreater/gajufreight/issues/91): the dashboard decodes the unsigned transaction itself and checks its contract against build-time pinned addresses |
| G3 | No rate limits are specified for the public relay, sign-in and feedback endpoints | Amend [#77](https://github.com/shanepreater/gajufreight/issues/77), [#82](https://github.com/shanepreater/gajufreight/issues/82) and [#87](https://github.com/shanepreater/gajufreight/issues/87) with per-IP and per-account limits and size caps |
| G4 | No incident runbook for a compromised API host | Amend [#103](https://github.com/shanepreater/gajufreight/issues/103): containment (rotate service keys, switch `bookings_open` off), what funds in flight are exposed (none held by us), and who we tell |
