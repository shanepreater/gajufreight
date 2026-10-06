# ADR 0010: Platform fee skimmed from payee payouts, with a refundable bond on legs

| | |
| :--- | :--- |
| **Status** | Accepted (decided 2026-10-05; revised the same day after review found a fee bypass). Mechanism amended 2026-10-06 by [ADR 0011](0011-agreed-booking-terms.md): the platform's registry replaces the bytecode-hash checks |
| **Last reviewed** | 2026-10-05 |
| **Related** | [HLD §5](../hld.md#5-contract-sketch-sophia) · [HLD §6.8](../hld.md#68-privacy-standard) · [ADR 0004](0004-staged-contracts.md) · [ADR 0005](0005-platform-booking-privacy.md) · [Phase 0 spike](../spikes/phase-0-testnet.md) |

## Context

GajuFreight had no way to earn. Options considered: a fee inside the escrow, the shipper paying price plus fee, an off-chain subscription, or a fixed amount of Gaju per contract. Benchmarks: GajuMarket's escrow pays the seller 98% and the platform 2% at settlement ([youtube references](../youtube-references.md)); forwarder margins are thin.

A fixed Gaju amount drifts in real value with the Gaju price and weighs heavily on small jobs. Charging the shipper on top makes refund rules harder, and refunds are a contract invariant. An off-chain subscription needs billing and can be bypassed.

The first version made legs fee-free if their quote named a genuine parent escrow. Review found that this could be gamed. Someone books a small main shipment to an account they control, runs the real work as legs against it, then lets the parent refund (or fall back to 0% in a dispute). Refunds pay no fee, so nothing is ever paid. Checking the parent when a leg pays out doesn't help, because legs normally finish before the main shipment does.

## Decision

1. **The main escrow takes the fee from payouts to its payee** (the forwarder) and sends it to a **treasury**. The shipper pays exactly the agreed price. Refunds, and the shipper's share of a dispute split, carry no fee.
2. **Rate: 1% with a minimum, never more than 10% of a payout.** Fee owed on everything the payee has received so far, `c`:
   `fee_due(c) = 0 if c = 0, else min(max(c × fee_bps / 10000, min_fee), c × 1000 / 10000)`.
   Each payout to the payee sends `fee_due(after) − fee_paid` to the treasury and the rest to the payee. The cumulative form keeps the total exact and puts any rounding on the last payout. The 10% ceiling also bounds the minimum, so a small payout never loses more than 10%.
3. **Settings are voted, like the others.** `fee_bps` (initially 100, at most 1000) and `min_fee` (initially 1 Gaju, ≥ 0) are `Platform` settings. The treasury address (`SetTreasury`) and the escrow and quote templates (`SetEscrowTemplate`, `SetQuoteTemplate`) are changes applied by the same M-of-N admin approval ([ADR 0005](0005-platform-booking-privacy.md)). (The first version voted the escrow template's bytecode hash, `SetEscrowCode`; [ADR 0011](0011-agreed-booking-terms.md) replaced it.)
4. **The fee is fixed when the quote is requested.** `Platform.new_quote` copies `fee_bps`, `min_fee` and `treasury` into the `QuoteRequest`, and the escrow takes them from its quote. Both sides negotiate knowing the fee, and a later vote never changes an open negotiation or a live shipment (as with `max_rounds`).
5. **Legs pay through a refundable bond.** A leg quote names its parent escrow. `new_quote` requires the parent to be:
   - genuine: an escrow the platform booked, found in its registry (`UNKNOWN_ESCROW`). Before ADR 0011 this compared bytecode hashes
   - a main escrow, not a leg (`NOT_MAIN`)
   - paying the caller (`NOT_PAYEE`)
   - still open (`BAD_STATE`)

   The leg escrow is funded with `price + bond`, where `bond = fee_due(price)` at the quote's rate (`WRONG_AMOUNT`). Its own payouts carry no fee. `Platform.book` keeps the total of a parent's legs within the parent's price (`LEG_TOO_LARGE`) before it clones the leg, and records the leg against its parent. (The first version had the leg's `init` call `Platform.add_leg`, checked by bytecode hash. Once the platform books every escrow itself, that would be a call back into the platform during its own call, so ADR 0011 moved it.) Once the parent is terminal or past its deadline, the leg's payer calls `settle_bond()`. That returns `bond × parent_paid_to_payee / parent_price` to the payer and sends the rest to the treasury (`FeePaid`), once (`BOND_SETTLED`, `PARENT_OPEN`).

## Consequences

- **Good:**
  - Transparent and enforced on-chain, with no invoicing or collections.
  - The shipper's price is the agreed price, and we earn only when the main payee is paid.
  - An honest forwarder gets every bond back in full, so legs are fee-free in effect.
  - Every escrow still conserves its funds: once terminal, with any bond settled, payee, treasury, shipper and bond-refund payouts sum to the funded amount.
- **Gaming closed:** a fake parent that is refunded, or split away from its payee, forfeits the legs' bonds to the treasury in the same proportion, so the fee is paid either way. The cap on total leg value stops a small, honestly delivered parent from backing unlimited fee-free legs. Leg-of-leg chains are refused (`NOT_MAIN`); a carrier subcontracting further opens a main quote and pays the fee.
- **Costs:**
  - No revenue from refunded shipments.
  - Forwarders lock a little more capital per leg until the parent ends, and sign one more transaction to settle each bond.
  - One more remote read at escrow creation, and one more spend per main payee payout.
- **No freeze:** a bond can be settled once the parent passes its deadline, so the parent's shipper can't trap it by never refunding.
- **Visible on-chain (privacy standard, HLD §6.8):** the fee settings, the treasury address, each quote's fee terms, each `FeePaid` event and each leg's bond, so anyone can total GajuFreight's fee income and see which escrows are legs of which parent. A zero fee alone doesn't mark an escrow as a leg, because fees can be voted to zero and a refunded main escrow pays none.
- **Dependencies:** none beyond `Chain.clone` (spike E4). The spike also verified `Chain.bytecode_hash` for the first version of this design (E11, E11b), but since ADR 0011 the platform's own registry identifies its escrows, so the design no longer needs it.
- **Not decided here:** whether taking a cut of escrowed funds needs regulatory advice (to raise with legal), discounts or per-customer rates, and fiat pricing.
