# ADR 0010: Platform fee skimmed from payee payouts

| | |
| :--- | :--- |
| **Status** | Accepted (decided 2026-10-05) |
| **Last reviewed** | 2026-10-05 |
| **Related** | [HLD §5](../hld.md#5-contract-sketch-sophia) · [HLD §6.8](../hld.md#68-privacy-standard) · [ADR 0004](0004-staged-contracts.md) · [ADR 0005](0005-platform-booking-privacy.md) · [Phase 0 spike](../spikes/phase-0-testnet.md) |

## Context

GajuFreight had no way to earn. Options considered: a fee inside the escrow, the shipper paying price plus fee, an off-chain subscription, or a fixed amount of Gaju per contract. Benchmarks: GajuMarket's escrow pays the seller 98% and the platform 2% at settlement ([youtube references](../youtube-references.md)); forwarder margins are thin.

A fixed Gaju amount drifts in real value with the Gaju price and weighs heavily on small jobs. Charging the shipper on top makes refund rules harder, and refunds are a contract invariant. An off-chain subscription needs billing and can be bypassed.

## Decision

1. **The escrow takes the fee from payouts to its payee** (the forwarder) and sends it to a **treasury**. The shipper pays exactly the agreed price. Refunds, and the shipper's share of a dispute split, carry no fee.
2. **Rate: 1% with a minimum.** Fee owed on everything the payee has received so far, `c`:
   `fee_due(c) = 0 if c = 0, else min(c, max(c × fee_bps / 10000, min_fee))`.
   Each payout to the payee sends `fee_due(after) − fee_paid` to the treasury and the rest to the payee. Like milestone rounding, the cumulative form keeps the total exact and puts any rounding on the last payout.
3. **Settings are voted, like the others.** `fee_bps` (initially 100, bounded 0–1000 so a captured admin quorum can't take more than 10%) and `min_fee` (initially 1 Gaju, ≥ 0) are `Platform` settings. The treasury address (`SetTreasury`) and the escrow template's bytecode hash (`SetEscrowCode`) are changes applied by the same M-of-N admin approval ([ADR 0005](0005-platform-booking-privacy.md)).
4. **An escrow keeps the fee it was created with.** `init` reads `fee_bps`, `min_fee` and `treasury` from `Platform` and stores them, so a vote never changes the fee on a live shipment (as quotes keep `max_rounds`).
5. **Only the main escrow pays.** A leg quote names its parent escrow: `Platform.new_quote(invited, job, Some(parent))` requires that the parent's bytecode hash matches the voted template hash (`UNKNOWN_ESCROW`) and that the caller is the parent's payee while it's still open (`NOT_PAYEE`). An escrow created from a leg quote has a zero fee, and its price can't exceed its parent's (`LEG_TOO_LARGE`). Clones share the template's bytecode, so their hash matches.

## Consequences

- **Good:**
  - Transparent and enforced on-chain, with no invoicing or collections.
  - The shipper's price is the agreed price, and we earn only when the payee is paid.
  - Every escrow still conserves its funds: payee, treasury and shipper payouts sum to the funded amount.
- **Costs:**
  - No revenue from refunded shipments.
  - Forwarders will price the fee in.
  - One more remote read at escrow creation, and one more spend per payee payout.
- **Gaming:** a forwarder could try to book a main shipment as a "leg" of a fake parent to avoid the fee. The parent must be a genuine, open escrow that the caller is paid by, and at least as large as the leg, so the fake parent pays at least the fee it was meant to avoid.
- **Visible on-chain (privacy standard, HLD §6.8):** the fee settings, the treasury address and every `FeePaid` event, so anyone can total GajuFreight's fee income. Leg escrows show a zero fee, which marks them as legs.
- **Dependencies:** `Chain.bytecode_hash` is in the Sophia 9 stdlib. The Phase 0 spike (E11) verifies on testnet that a clone shares its template's hash. If it doesn't, Platform registers escrows at `init` instead, and this ADR is amended.
- **Not decided here:** whether taking a cut of escrowed funds needs regulatory advice (to raise with legal), discounts or per-customer rates, and fiat pricing.
