# ADR 0011: Booking terms the payee agrees to, booking through the platform, and payee release

| | |
| :--- | :--- |
| **Status** | Accepted (2026-10-06, [decision log](../decision-log.md) #2), with decision 1 amended by #4: the agreed terms are stored on-chain in full |
| **Last reviewed** | 2026-10-05 |
| **Related** | [HLD §5](../hld.md#5-contract-sketch-sophia) · [ADR 0002](0002-arbiter-panel.md) · [ADR 0004](0004-staged-contracts.md) · [ADR 0005](0005-platform-booking-privacy.md) · [ADR 0006](0006-final-mile-proof-of-delivery.md) · [ADR 0010](0010-platform-fee.md) · [Phase 0 spike](../spikes/phase-0-testnet.md) |

## Context

The design audit found six gaps in how an escrow comes to exist and how it can end:

1. **The payee never agrees the dispute terms.** The terms hash covers only the price and milestone schedule. The shipper alone sets the attestors, arbiter panel, quorum, arbitration window and fallback split when booking (the booking wireframe offers a 0% fallback and a 1-day window). A shipper could pick a panel they control, or a 0% fallback, then raise a dispute after the goods arrive and take back the unpaid remainder. They could also name no attestors, so no milestone could ever fire.
2. **Booking had two paths and no decision.** A shipper could create the escrow with a create transaction signed over GRIDS, or call `Platform.book` to clone it. [Spike round 2](../spikes/phase-0-testnet.md#round-2-2026-10-06) showed that **both work with GajuDesk** (E9). Cloning a realistic 4.4 KB escrow was only 10% cheaper than creating it, and about a third cheaper at full size (E14, E18). The clone path still isn't a drop-in, though: inside a clone's `init`, `Call.caller` is the platform, but the sketch uses it as the shipper.
3. **A payee can't step back.** A forwarder who can't perform has no way to return the funds; the shipper waits for the deadline.
4. **A refunded leg still uses up its parent's leg budget** (`leg_total`), so a forwarder can't replace a carrier who failed.
5. **No exposure limit for the pilot, and no way to stop new bookings.** Until the contracts have run in production for a while, the value at risk in any one escrow should be capped. If a live contract has a bug, the incident plan is to stop new quotes and bookings and let existing escrows run out (`security-consultant` skill), but nothing can stop them.
6. **Deployment order and versioning aren't written down.** The escrow template has the platform address compiled in, and the platform holds the template's code hash. That's circular, and nobody has said how a fixed contract ships.

## Decision

1. **The agreed terms cover everything that decides who gets paid, and are stored on-chain in full** ([decision log](../decision-log.md) #4). The terms record becomes `{ price, schedule, deadline, attestors, panel, quorum, window, fallback, challenge }` (`challenge` from ADR 0006). The deadline moves out of the job hash into the terms, so every agreed commercial term is readable on-chain; the job hash keeps only the goods manifest and the consignee, which are personal or commercial data ([decision log](../decision-log.md) #4, #8). Each offer stores the whole record on the quote, so both sides and any later reader can see it. `accept` still names the hash of the terms the accepter saw (`TERMS_CHANGED`). The escrow reads the agreed record from the quote and books exactly that, so it no longer recomputes a hash (`NOT_AGREED` remains for a quote that isn't agreed or doesn't match the booking). Either side can counter any of these terms. The API also refuses to build terms where an attestor belongs to the payee's own organisation. The contract can only check the payee's address (ADR 0006 `CONFLICTED_ATTESTOR`); the API can also see staff wallets.
2. **Every escrow is booked through the platform as a clone.** `Platform.book(quote, terms, manifest, consignee, deadline)` is a `payable` entrypoint. It checks the quote is registered (`UNKNOWN_QUOTE`) and the pilot cap (`OVER_LIMIT`), then clones the escrow template with `value = Call.value`, passing `shipper = Call.caller`. It emits `EscrowBooked(escrow, quote, shipper)` so the indexer discovers the escrow. The escrow's `init` requires `Call.caller == platform()` (`NOT_PLATFORM`) and takes `shipper` as an argument. **Every use of `Call.caller` that means the payer is replaced by that argument:**
   - the quote's requester must equal `shipper` (`NOT_AGREED`);
   - no arbiter may be `shipper` (`CONFLICTED_ARBITER`);
   - `shipper` must be payable (`NOT_PAYABLE_PARTY`);
   - `state.shipper = shipper`.

   `Call.caller` then appears in `init` only in the `NOT_PLATFORM` check. Every other check stays as it is. The HLD sketch changes to match when this ADR is accepted (D1). Booking is one ordinary contract call over GRIDS, with no dependency on signing a create, and it pays for state only. `new_quote` likewise clones a quote template.
3. **The payee can release the escrow back to the payer.** `release_to_payer()` can be called only by the payee, while the escrow is `Funded`, `InTransit` or `Delivered`. It refunds the unpaid remainder to the payer and ends in `Refunded` (`ONLY_PAYEE`, `BAD_STATE`). Paid milestones stay paid. It can only give away the payee's own claim, so it needs no one else's consent.
4. **A refunded leg returns its unused budget.** `Platform.book` records each leg against its parent. Once a leg is terminal, anyone can call `Platform.release_leg(leg)`, once, to subtract the part of its price never paid to its carrier from the parent's `leg_total` (`NOT_LEG`, `LEG_OPEN`, `LEG_RELEASED`). It's a pull, so no refund path ever depends on a call into the platform.
5. **Pilot cap and booking switch.**
   - A new `max_price` setting (0 means no cap), checked by `Platform.book` for main and leg escrows (`OVER_LIMIT`). It starts low on mainnet, is raised by admin vote, and changes nothing for escrows already booked.
   - A `bookings_open` setting (1 or 0), checked by `new_quote` and `book` (`BOOKINGS_CLOSED`). Like every setting, it's changed by admin quorum. It never touches a live escrow: every path out of an escrow (delivery, dispute, fallback, refund, bond) stays open.
6. **Deployment and versioning.**
   - **Order:** deploy `Platform` → build the templates with that address substituted for `PLATFORM_ADDRESS` → deploy both templates → the admins vote `SetEscrowTemplate(address)` and `SetQuoteTemplate(address)`. These replace `SetEscrowCode(hash)`. The platform keeps a registry of every escrow it books, so it no longer needs code hashes to recognise its own. The deployment manifest records every address, compiler version and source hash.
   - **No upgrades to live contracts, and no pause.** Admins never control escrowed funds. A fix ships as a new template, voted in, and escrows already booked run to completion on the code they started with. A platform fix means a new platform and new templates; the old platform stays live for its open escrows.

## Consequences

- **Good:**
  - Every term that moves money is agreed by both sides. The panel and fallback stop being a weapon.
  - Booking is the same contract call for every shipment and leg, and the platform's `EscrowBooked` event lets the indexer discover each escrow (E15).
  - No booking stores another copy of the code and source on-chain, so bookings cost about a third less at full size.
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
- **Supersedes:**
  - the "create transaction" booking path in ADR 0005 (atomic, one-signature booking stands), and the escrow's own `platform().is_quote` check, which `Platform.book` now makes;
  - `SetEscrowCode`, `Platform.add_leg` and the bytecode-hash checks in ADR 0010, replaced by the platform's escrow registry.
- **No call back into a running contract:** the platform passes its limits (`max_panel`, `max_attestors`, `max_price`) into the escrow it clones, rather than the escrow calling the platform during booking. Re-entrant calls aren't verified on Gajumaru, and the design never needs one (HLD §5).
