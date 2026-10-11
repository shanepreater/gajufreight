# ADR 0018: Payee confirms each booking with a fee bond

| | |
| :--- | :--- |
| **Status** | Accepted (2026-10-11). Supersedes [ADR 0010](0010-platform-fee.md) decisions 1 (fee skimmed from payee payouts) and 5 (refundable leg bond); its rate, minimum, 10% limit, voting and fixing at quote time stand |
| **Last reviewed** | 2026-10-11 |
| **Related** | [HLD §4](../hld.md#4-shipment-lifecycle) · [HLD §6.8](../hld.md#68-privacy-standard) · [ADR 0010](0010-platform-fee.md) · [ADR 0011](0011-agreed-booking-terms.md) · [Decision log](../decision-log.md) #27 |

## Context

Under ADR 0010 the fee came only from payouts to the forwarder. A shipment that failed (missed deadline, forwarder stepping back) or a dispute settled mostly for the shipper earned the platform little or nothing, although the platform did its work either way. The owner wants the fee always collected, always from the forwarder, and the forwarder to carry the cost of failing. Charging the shipper on a refund would make the shipper pay for the forwarder's failure, and an off-chain fee debt can be walked away from.

A bond also gives the payee something to lose by not performing. Sized at the fee (1%) it is no deterrent to theft, whose answer is business verification, carrier liability and insurance; a larger, voted performance bond can add a real incentive against non-performance later without a new contract.

## Decision

1. **Confirmation.** An escrow booked by `Platform.book` starts `Unconfirmed`, funded by the payer with exactly the price. The payee calls `confirm` within `confirm_window` key blocks (a voted setting, initially 480, about a day), attaching exactly the bond. The escrow becomes `Funded`.
2. **The bond** is `max(fee, price × bond_bps / 10000)`. `fee = min(max(price × fee_bps / 10000, min_fee), price × 10%)`. `bond_bps` is a voted setting, initially 0, bounded 0–10% like `fee_bps`. The 10% limit on the fee is a constant in the contract, so no vote can raise it, and it overrides the minimum.
3. **The fee goes to the treasury at confirmation**, so it is paid however the shipment ends. Payouts to the payee carry no fee, and the payer always pays exactly the price.
4. **The rest of the bond is held** and paid in the same call as the escrow ends: back to the payee on `Released`; to the payer on `Refunded` (deadline refund or the payee stepping back), as compensation; split by the ruling on `Resolved`, pct% to the payee and the rest, with any rounding, to the payer.
5. **Before confirmation either side can `cancel_booking`:** the payer at any time, the payee to decline. The payer gets the whole price back and no fee is charged, because the payee never committed. Nothing else can happen to an unconfirmed escrow: no checkpoints, disputes, refunds or legs.
6. **Legs carry no fee.** The main escrow's fee covers the whole job, so a leg quote's `fee_bps` and `min_fee` are 0. Its carrier confirms the same way, staking `bond_bps` of the leg price (0 at first, so confirming is just a signature). The leg bond and `settle_bond` are removed. The cap on a parent's total leg value stays (ADR 0010, ADR 0011).
7. **Fixed at quote time.** `Platform.new_quote` copies `fee_bps`, `min_fee`, `bond_bps`, `confirm_window` and the treasury into the quote as a `fees` record, so a later vote never changes an open negotiation or a live shipment.

## Consequences

- **Good:**
  - Revenue on every confirmed shipment, including failed and disputed ones, paid by the forwarder.
  - The shipper's price stays the agreed price and refunds stay whole; a forfeited bond adds to the shipper's refund.
  - Simpler contract: one fee path, no cumulative fee state, no leg bond or `settle_bond`.
  - Forwarders and carriers explicitly commit to a booking, which freight already expects.
  - Raising `bond_bps` later adds a performance incentive without a new template.
- **Conservation:** in every terminal state, payouts to the payee, treasury and payer, including bond returns, equal the funded price plus the payee's bond; an unconfirmed escrow cancelled pays back exactly the price (AGENTS.md contract invariants).
- **Costs:**
  - One more signature per booking, and the payee needs the bond in cash (the fee, while `bond_bps` is 0).
  - A shipper's funds sit in an unconfirmed escrow until the payee confirms or the shipper cancels; the shipper can cancel at any time, so nothing is trapped.
  - A forwarder can decline after booking at no cost. Repeated no-shows are visible on-chain (`Cancelled` events) and recorded against the organisation in the directory (ADR 0009).
- **Visible on-chain (HLD §6.8):** the bond and fee settings, each quote's `fees`, and every `Confirmed`, `FeePaid`, `Cancelled` and `BondReleased` event, so anyone can see who confirmed, who cancelled and who forfeited a bond.
- **Not decided here:** a non-zero `bond_bps` (an admin vote, a commercial decision), late-delivery penalties, and discounts or per-customer rates.
