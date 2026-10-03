# ADR 0004: Staged contracts for negotiation, execution and legs

| | |
| :--- | :--- |
| **Status** | Accepted (decided 2026-10-03) |
| **Last reviewed** | 2026-10-03 |
| **Related** | [HLD §4](../hld.md#4-shipment-lifecycle) · [HLD §5](../hld.md#5-contract-sketch-sophia) · [HLD §6.7](../hld.md#67-staged-contracts-and-milestones) · [ADR 0002](0002-arbiter-panel.md) |

## Context

The design assumed the price already existed: the shipper set the amount alone, and nothing on-chain showed the transport company had agreed to it. In practice a shipper wants goods moved to a consignee, and must first agree the cost with a **forwarder** (the transport and logistics company), who often subcontracts **carriers** for individual legs. The business wants negotiation fully on-chain with invited forwarders only, payment in milestones, and **each stage as a separate, simple entity** that is easy to debug and maintain.

## Decision

Two small contract types, composed per stage:

1. **`QuoteRequest`: negotiation. It holds no money.**
   - The requester (the shipper, or the forwarder for a leg) creates it with the hash of the job (goods, manifest, route, deadline) and the invited parties.
   - `propose(invitee, terms, valid_until)` by the requester or that invitee replaces the offer on their thread.
   - `accept(invitee, terms)` by the *other* side fixes the deal (`Agreed`, recording the counterparty and terms hash). All other threads close.
   - `withdraw()` cancels an open request.
   - Errors: `NOT_INVITED`, `ONLY_REQUESTER`, `NO_OFFER`, `OWN_OFFER`, `TERMS_CHANGED`, `OFFER_EXPIRED`, `BAD_STATE`.
2. **`ShipmentEscrow`: execution.** This is the existing contract, with two additions:
   - **It's created only from an agreed quote.** `init` receives the terms (price + milestone schedule), recomputes their hash, and calls `quote.agreement()` once (read-only). It requires an agreement whose requester is the caller, whose counterparty is the payee, whose terms hash matches, and whose **job** hash matches this escrow's manifest, consignee and deadline, so an agreed quote can't be reused for another shipment (`NOT_AGREED`). The agreed price and schedule are therefore enforced, not just referenced. Known gap: a look-alike contract exposing `agreement()` would also pass; ADR 0005's platform registry closes it.
   - **Milestones:** an ordered `(location, pct)` schedule (each 1–100, unique locations, total at most 100; else `BAD_SCHEDULE`). Milestones pay **in order**: only the next unpaid one, once, when an **attestor** signs a `ScanIn` at its location. Each pays its cumulative share minus what's already been paid, so rounding lands on the last payout. The payee's own scan never fires one, so nobody can pay themselves. `confirm_delivery` pays the remainder. Disputes and refunds act only on the **unpaid remainder**; paid milestones are final.
3. **Legs reuse the same two contracts.** Shipper ↔ forwarder is one quote and one escrow (payee: the forwarder). Each leg is a quote and an escrow between the forwarder (payer) and that leg's carrier (payee), whose "consignee" is whoever takes over at the leg's end. The forwarder's margin is what they receive minus what they pay.

## Consequences

- **Good:** each contract is small, has one job, and conserves its own funds, with no contract depending on another's payouts. The only coupling is one read-only call at escrow creation. Negotiation can be tested without money, and escrow without negotiation.
- **Cost:** more contracts per shipment (2, plus 2 per leg) means more deployment fees, which makes `Chain.clone` (HLD §7 Q1) more valuable. A handover may need two signatures (the next leg's scan-in, and the incoming leg's delivery) unless GRIDS can batch calls (HLD §7 Q10). Every negotiation round costs a fee (Q11).
- **Trust:** the forwarder must fund leg escrows. If they don't, the carrier doesn't start the leg, and the shipper is still protected by their own escrow's deadline and refund.
- **Not prevented:** creating two escrows from one quote only costs the creator (each must be funded), so the quote isn't written to by the escrow. That keeps the coupling read-only.
