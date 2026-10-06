# Design audit before implementation

| | |
| :--- | :--- |
| **Status** | Complete (2026-10-05). Fixes that don't change who may do what are applied. Decisions taken on 2026-10-06 are in the Status column and the [decision log](decision-log.md) |
| **Last reviewed** | 2026-10-05 |
| **Related** | [HLD](hld.md) · [Architecture](architecture-blueprint.md) · [Dev approach](dev-approach.md) · [ADR 0011](adr/0011-agreed-booking-terms.md) · [ADR 0012](adr/0012-transaction-building-and-grids-relay.md) · [ADR 0013](adr/0013-off-chain-data.md) · [Implementation blueprint](implementation-blueprint.md) |

The whole design (HLD, architecture, dev approach, ADRs 0001–0010, the Phase 0 spike, the QPQ Q&A, the UX journeys and the wireframes) was reviewed through each specialist skill's lens: `solutions-architect`, `sophia-contracts`, `security-consultant`, `backend-services`, `ux-designer`, `ui-typescript`, `infra`, `sre` and `sdet`.

## Verdict

The core model is sound: staged contracts, atomic booking, milestone payouts, the arbiter panel with a fallback, the fee with leg bonds, and app-level privacy. The spike verified the protocol features they rely on. Three things aren't ready for a build, though:

1. **The escrow can be set against its payee.** The shipper alone chooses the dispute terms and attestors (F1).
2. **The path from "the API builds a call" to "a wallet signs it" is neither designed nor tested** (F5, F6). That path is hard rule 1, and every screen depends on it.
3. **Off-chain data has no clear owner, protection or rebuild story** (F7), and several identity questions about real companies and consignees are still open (F8, F9).

None of these needs a redesign. Each has a proposed fix below. Phase 0 can exit once the decisions in the blueprint's milestone M0 are made.

## Findings

Severity: **critical** puts funds or keys at risk, or blocks the build; **high** is another party's data or actions, or a missing component; **medium** needs unusual conditions or is a gap with a workaround; **low** is hardening or drift. "Applied" means the fix is in this PR.

| # | Sev. | Lens | Finding | Fix | Status |
| :-: | :-: | :--- | :--- | :--- | :--- |
| F1 | Critical | contracts, security | **The payee never agrees the dispute or attestor terms.** Only the price and schedule are hashed. The shipper sets the panel, quorum, window and fallback (0% is offered) and the attestors at booking, so they can stack the panel or fallback, dispute on arrival and take back the unpaid remainder. They can also name no attestors, so milestones never pay | Put every term that moves money in the agreed terms hash; the API also rejects attestors from the payee's own organisation | [ADR 0011](adr/0011-agreed-booking-terms.md), accepted ([decision log](decision-log.md) #2) |
| F2 | Critical | contracts | **A non-payable payee, payer or treasury freezes payouts.** A spend to a non-payable contract fails and burns the gas (spike E6b). `SetTreasury` accepted any address, so a mistaken vote would break every later payout | `Address.is_payable` checks in `init` and on `SetTreasury`. Probe E12 checks how `is_payable` treats an account that has never been funded | Applied to the HLD sketch; probe S3 |
| F3 | Critical | contracts | **Zero-value spends are normal but untested.** A 0% or 100% split, a schedule that pays 100% before delivery, a zero fee and a fully refunded bond all spend 0. If the node rejects a zero spend, those escrows freeze | One `pay` helper that skips zero amounts; probe E12 records the node's behaviour anyway | Applied; probe S3 |
| F4 | High | contracts, architecture | **Booking rests on unverified ground.** A GRIDS create transaction is unconfirmed, E9 hasn't run, every create pays to store the code and source, and the `Platform.book` fallback isn't a drop-in (`Call.caller` in a clone is the platform) | Book every escrow by `Platform.book` cloning a template | ADR 0011, accepted |
| F5 | High | backend, security | **The signing path is missing from the architecture.** GRIDS calls use a dead drop that our HTTPS host serves and receives, and E9 hasn't run. A transaction that never reaches the miner blocks the account's later nonces, and a handover needs two signatures. GajuMobile's support for call requests and deep links is unconfirmed | A GRIDS relay in the API, one open request per account, short TTLs, and spikes S1 and S2 | [ADR 0012](adr/0012-transaction-building-and-grids-relay.md) (proposed); E9 and E9b confirmed the signing path on GajuDesk and on GajuMobile for Android, with iOS untested ([decision log](decision-log.md) #10, #11) |
| F6 | High | backend | **Python can't build a contract call.** There's no SDK, and the node doesn't encode FATE calldata. ADR 0001's "thin HTTP client" isn't enough | A tx-builder sidecar on Hakuzaru and the Sophia compiler (prototype S4) | ADR 0012 |
| F7 | High | architecture, security | **Off-chain data is conflated.** Organisations, sessions and verification decisions aren't projections of the chain, so the "rebuildable app database" can't hold them. The preimages of terms, job and manifest hashes aren't stored anywhere durable, which breaks hard rule 3 for negotiations. IPFS (an option) would publish personal data permanently | Three stores: the read model, an operational store that's backed up, and a private, content-addressed evidence store that also holds the preimages | [ADR 0013](adr/0013-off-chain-data.md), accepted with terms on-chain ([decision log](decision-log.md) #4) |
| F8 | High | architecture, UX | **Company staff can't act for the company on-chain.** Requester, invitee, payer and payee are single addresses. ADR 0009 says staff use their own wallets, which works for attesting but not for quoting, funding or being paid | MVP: each company names one operating wallet; the org account contract moves to FOC. Q15 widened | Decided: operating wallet ([decision log](decision-log.md) #7) |
| F9 | High | UX, contracts | **The consignee must have a wallet, but the parcel journeys assume they don't.** `init` takes the consignee's address, and only a party can dispute. Door-to-door delivery codes and tracking links imply a consignee reached by email or SMS | MVP: B2B consignees with a wallet; walletless consignees move to FOC. New Q16 | Decided: consignee optional ([decision log](decision-log.md) #8) |
| F10 | High | architecture, UX | **The round 5 journeys rely on ADR 0006, which is still proposed** (the 24 h hold, the delivery code, `add_attestor`, `CONFLICTED_ATTESTOR`) | Accept or amend before the escrow is built | Accepted ([decision log](decision-log.md) #3) |
| F11 | High | security | **No threat model.** It's the architect's responsibility 6. In particular, **a compromised API could have users sign a payable call to a look-alike contract**, because the wallet may show only raw call data (GRIDS follow-up 3) | STRIDE threat model. The dashboard pins the platform address at build time and shows contract, function and amount; adopt GRIDS's safer call request when it ships | D8; X9 |
| F12 | High | backend, UX, SRE | **No notifications component.** Delivery codes (ADR 0006), the "Needs your action" queue and reminders before refund deadlines, arbitration windows and challenge windows all need one, and a missed deadline is the main way a user loses money | Add a notifications component (email first, in-app queue) | Blueprint B12, U3 |
| F13 | Medium | contracts | **Checkpoints were a list in contract state.** The carrier (the payee) could add them freely, growing state and raising everyone's gas | Checkpoints are events only | Applied |
| F14 | Medium | contracts, backend | **The events weren't enough to index without reading state:** no event at creation, no `LegAdded`, a bond refund and a deadline refund with no amount | The indexer rebuilds each escrow from its creation's call data (on-chain, decoded with the ACI), events, and the hash preimages in the evidence store. Added `Booked` and `Job` (content hashes of the immutable inputs), `RefundPaid` (renamed from `Refunded` after spike round 2), `BondSettled` and `LegAdded`; `EscrowBooked` comes with ADR 0011 | Applied |
| F15 | Medium | contracts | **Unbounded lists at creation.** Attestors (ADR 0009 assumed a platform limit that didn't exist) and invitees | `max_attestors` and `max_invited` settings | Applied |
| F16 | Medium | contracts | **A refunded leg still uses up its parent's leg budget**, so a failed carrier can't be replaced | `Platform.release_leg`, a pull with no call in any refund path | ADR 0011, accepted |
| F17 | Medium | contracts, UX | **A payee can't step back** and return the funds; the shipper waits for the deadline | `release_to_payer()` for the payee | ADR 0011, accepted |
| F18 | Medium | security, SRE | **No exposure cap for the pilot, and no way to stop new bookings** if a live contract has a bug | `max_price` and `bookings_open` settings; live escrows are never touched | ADR 0011, accepted |
| F19 | Medium | contracts, infra | **Deployment order and versioning aren't written down** (the platform address compiled into the template, the template hash voted into the platform) | Written order, no upgrades to live contracts, manifest | ADR 0011, accepted; blueprint C11 |
| F20 | Medium | security | **An attestor can't be revoked mid-shipment.** A stolen attestor key can confirm delivery. A shipper-only removal would let the shipper block milestones, so it needs both payer and payee | Decide with ADR 0006: `remove_attestor` signed by payer and payee, or accept the risk with the challenge window | Decided: payer and payee both ([decision log](decision-log.md) #3) |
| F21 | Medium | UX | **The offline promise can't be kept.** "Signed, will send when online": a dead-drop wallet must fetch the request, and the nonce is fixed when the payload is built | "Saved, sign when you have signal" until S2 says otherwise | ADR 0012; U2 |
| F22 | Medium | architecture | **Finality is assumed to be 2 keyblocks**, but `/status` reports `finalized` at genesis on testnet | A per-network setting; asked of QPQ (new Q17) | Applied to HLD §7 |
| F23 | Medium | infra, SRE, UI | **Undecided platform choices:** hosting and the secret store, whether to run our own Groot node, the observability backend, the dashboard and field-app framework (camera, offline queue and WebAuthn point to a PWA), and how contract tests run (the local demo chain is unverified; a standalone compiler in CI is a QPQ follow-up) | One ADR each | D9–D12 |
| F24 | Medium | business, security | **Legal and business items marked "decided before the build"** in ADR 0009 and 0010: whether taking a fee from escrowed funds is regulated, listing fees, the KYB provider, document retention, and the terms of service and privacy notice | Business and legal decisions | D7 |
| F25 | Low | sdet | **The conservation property in dev approach §4 predates fees and bonds** | Restated to match AGENTS.md | Applied |
| F26 | Low | sdet | **Contract tests have no oracle.** The demo model is a full executable specification | Differential tests: the same seeded random call sequences against the demo model and the real contract | Blueprint C9 |
| F27 | Low | contracts | **Delivery and refund race after the deadline**, and a bond settled after the parent's deadline but before a late delivery forfeits more than it needed to | Documented in the sketch; the UI warns before settling a bond early | Applied (doc) |
| F28 | Low | contracts | **Platform proposals never expire**, so a stale one can be approved months later | Add an expiry when building `Platform` | Blueprint C3 |
| F29 | Low | business | **Arbiters aren't paid** and have no joining journey | FOC | Blueprint X7 |
| F30 | Low | docs | **Drift:** the architecture's factory row and testnet deploy steps, the dev approach's repo layout and Phase 0 exit criteria, the HLD actors (`settle_bond`), and the docs index | Updated | Applied |
| F31 | Low | architecture | **QPQ follow-ups looked unsent in the docs**, and new ones arose here (GajuMobile call requests and deep links, zero spends, `is_payable` on new accounts, finality) | Consolidated in the [QPQ Q&A](qpq-q-and-a.md). All of them have been sent (confirmed 2026-10-06), and spike round 2 answered several by experiment | Done |

## What's applied in this PR

- **HLD contract sketch:**
  - payability checks (`NOT_PAYABLE_PARTY`, `BAD_TREASURY`) and a zero-safe `pay` helper on every transfer;
  - checkpoints held only as events (`get_checkpoints` removed), and new events `Booked`, `Job`, `RefundPaid`, `BondSettled` and `LegAdded`, so the indexer rebuilds from creation call data, events and evidence-store preimages;
  - `max_attestors` and `max_invited` (`BAD_ATTESTORS`, `BAD_INVITED`), with `SetTreasury` validated;
  - a note on the delivery-versus-refund race.

  The demo model follows in blueprint C10, so the sketch is briefly ahead of `scripts/demo` (the `sophia-contracts` checklist).
- **HLD:** the `settle_bond` actor, the data note in §6.4, a widened Q15, and new Q16 and Q17.
- **Proposed ADRs** [0011](adr/0011-agreed-booking-terms.md), [0012](adr/0012-transaction-building-and-grids-relay.md) and [0013](adr/0013-off-chain-data.md).
- **Architecture, dev approach, QPQ Q&A, spike and docs index** brought in line.

## Decisions needed

These are in milestone M0 of the [implementation blueprint](implementation-blueprint.md), each with a recommendation:

| # | Decision | Recommendation |
| :-: | :--- | :--- |
| D1 | Accept ADR 0011 | Accept |
| D2 | Accept ADR 0006, and settle attestor revocation (F20) | Accept, with `remove_attestor` needing both payer and payee |
| D3 | Accept ADR 0012 after spikes S1, S2 and S4 | Accept if S1 passes |
| D4 | Accept ADR 0013 | Accept |
| D5 | Company operating wallet for the MVP (Q15) | Yes; the org account contract at FOC |
| D6 | B2B consignees with a wallet for the MVP (Q16) | Yes; walletless consignees at FOC |
| D7 | Legal and business items (F24) | Take legal advice before mainnet; KYB and retention before the organisation documents are built |
