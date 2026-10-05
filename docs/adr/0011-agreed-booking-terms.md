# ADR 0011: Booking terms the payee agrees to, booking through the platform, and payee release

| | |
| :--- | :--- |
| **Status** | Proposed (2026-10-05): from the [design audit](../design-audit.md); needs acceptance before the Phase 1 escrow is built |
| **Last reviewed** | 2026-10-05 |
| **Related** | [HLD §5](../hld.md#5-contract-sketch-sophia) · [ADR 0002](0002-arbiter-panel.md) · [ADR 0004](0004-staged-contracts.md) · [ADR 0005](0005-platform-booking-privacy.md) · [ADR 0006](0006-final-mile-proof-of-delivery.md) · [ADR 0010](0010-platform-fee.md) · [Phase 0 spike](../spikes/phase-0-testnet.md) |

## Context

The design audit found six gaps in how an escrow comes to exist and how it can end:

1. **The payee never agrees the dispute terms.** The terms hash covers only the price and milestone schedule. The shipper alone sets the attestors, arbiter panel, quorum, arbitration window and fallback split when booking (the booking wireframe offers a 0% fallback and a 1-day window). A shipper could pick a panel they control, or a 0% fallback, then raise a dispute after the goods arrive and take back the unpaid remainder. They could also name no attestors, so no milestone could ever fire.
2. **Booking depends on two unverified paths.** A shipper creates the escrow with a create transaction, signed over GRIDS. Whether GRIDS can carry a create is an open question (GRIDS follow-up 2), and E9 hasn't run. Every create also pays the size fee for the full code and source (spike observations). The fallback named in ADR 0005, `Platform.book`, isn't a drop-in: inside a clone's `init`, `Call.caller` is the platform, but the sketch uses it as the shipper.
3. **A payee can't step back.** A forwarder who can't perform has no way to return the funds; the shipper waits for the deadline.
4. **A refunded leg still uses up its parent's leg budget** (`leg_total`), so a forwarder can't replace a carrier who failed.
5. **No exposure limit for the pilot, and no way to stop new bookings.** Until the contracts have run in production for a while, the value at risk in any one escrow should be capped. If a live contract has a bug, the incident plan is to stop new quotes and bookings and let existing escrows run out (`security-consultant` skill), but nothing can stop them.
6. **Deployment order and versioning aren't written down.** The escrow template has the platform address compiled in, and the platform holds the template's code hash. That's circular, and nobody has said how a fixed contract ships.

## Decision

1. **The agreed terms cover everything that decides who gets paid.** The terms record becomes `{ price, schedule, attestors, panel, quorum, window, fallback, challenge }` (`challenge` from ADR 0006), and its hash is what both sides propose and accept. The escrow recomputes it from what it's given, as today (`NOT_AGREED`). Either side can counter any of these terms. The API also refuses to build terms where an attestor belongs to the payee's own organisation. The contract can only check the payee's address (ADR 0006 `CONFLICTED_ATTESTOR`); the API can also see staff wallets.
2. **Every escrow is booked through the platform as a clone.** `Platform.book(quote, terms, manifest, consignee, deadline)` is a `payable` entrypoint. It checks the quote is registered (`UNKNOWN_QUOTE`) and the pilot cap (`OVER_LIMIT`), then clones the escrow template with `value = Call.value`, passing `shipper = Call.caller`. It emits `EscrowBooked(escrow, quote, shipper)` so the indexer discovers the escrow. The escrow's `init` requires `Call.caller == platform()` (`NOT_PLATFORM`) and takes `shipper` as an argument; every other check in `init` stays. Booking is one ordinary contract call over GRIDS, with no dependency on signing a create, and it pays for state only. `new_quote` likewise clones a quote template.
3. **The payee can release the escrow back to the payer.** `release_to_payer()` can be called only by the payee, while the escrow is `Funded`, `InTransit` or `Delivered`. It refunds the unpaid remainder to the payer and ends in `Refunded` (`ONLY_PAYEE`, `BAD_STATE`). Paid milestones stay paid. It can only give away the payee's own claim, so it needs no one else's consent.
4. **A refunded leg returns its unused budget.** `Platform.add_leg` records each leg against its parent. Once a leg is terminal, anyone can call `Platform.release_leg(leg)`, once, to subtract the part of its price never paid to its carrier from the parent's `leg_total` (`NOT_LEG`, `LEG_OPEN`, `LEG_RELEASED`). It's a pull, so no refund path ever depends on a call into the platform.
5. **Pilot cap and booking switch.**
   - A new `max_price` setting (0 means no cap), checked by `Platform.book` for main and leg escrows (`OVER_LIMIT`). It starts low on mainnet, is raised by admin vote, and changes nothing for escrows already booked.
   - A `bookings_open` setting (1 or 0), checked by `new_quote` and `book` (`BOOKINGS_CLOSED`). Like every setting, it's changed by admin quorum. It never touches a live escrow: every path out of an escrow (delivery, dispute, fallback, refund, bond) stays open.
6. **Deployment and versioning.**
   - **Order:** deploy `Platform` → build the templates with that address substituted for `PLATFORM_ADDRESS` → deploy both templates → the admins vote `SetEscrowTemplate(address)` and `SetQuoteTemplate(address)`. The platform reads the escrow template's code hash with `Chain.bytecode_hash`, which replaces `SetEscrowCode(hash)`. The deployment manifest records every address, compiler version and source hash.
   - **No upgrades to live contracts, and no pause.** Admins never control escrowed funds. A fix ships as a new template, voted in, and escrows already booked run to completion on the code they started with. A platform fix means a new platform and new templates; the old platform stays live for its open escrows.

## Consequences

- **Good:**
  - Every term that moves money is agreed by both sides. The panel and fallback stop being a weapon.
  - Booking needs no GRIDS create.
  - Clones are cheaper.
  - The indexer finds every escrow from platform events.
  - A forwarder can exit cleanly.
  - Failed legs can be replaced.
  - Pilot exposure is bounded, and a contract bug can be contained without touching anyone's funds.
- **Cost:**
  - Negotiation screens gain the dispute and attestor terms (more to compare, so the defaults matter: 50% fallback, 3-day window).
  - New error codes: `NOT_PLATFORM`, `ONLY_PAYEE`, `OVER_LIMIT`, `BOOKINGS_CLOSED`, `NOT_LEG`, `LEG_OPEN`, `LEG_RELEASED`.
  - The demo model and its tests change with the contracts.
- **Attestors chosen after booking** still need ADR 0006's `add_attestor` (shipper only), because the leg carriers' handlers aren't known when the price is agreed.
- **Supersedes:** the "create transaction" booking path in ADR 0005 (atomic, one-signature booking stands) and `SetEscrowCode` in ADR 0010.
