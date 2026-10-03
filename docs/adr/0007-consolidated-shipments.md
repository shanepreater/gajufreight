# ADR 0007: Consolidated shipments (bulk, then final mile per order)

| | |
| :--- | :--- |
| **Status** | Proposed (2026-10-03): options only, to be decided by a spike ([HLD §7 Q14](../hld.md#7-open-questions)) |
| **Last reviewed** | 2026-10-03 |
| **Related** | [ADR 0003](0003-package-labels-and-scanning.md) · [ADR 0004](0004-staged-contracts.md) · [ADR 0006](0006-final-mile-proof-of-delivery.md) · [Round 4 review, item 13](../ux/review-round-4-feedback.md#13-bulk-shipping-then-final-mile-per-order) |

## Context

A shipper often sends many customer orders in one bulk move to the destination country. A final-mile agent then delivers each order to its own consignee. Today, one escrow covers one shipment to one consignee, so this can't be modelled without one booking per order, which wastes the shared line haul.

Some things hold whichever option we choose:

- **Each order has its own consignee, manifest entry and labels.** Labels are printed per order at origin, so the hub can map packages to orders without relabelling.
- **Deconsolidation is a scan at the hub.** The hub's evidence bundle lists each order and its packages ([ADR 0003](0003-package-labels-and-scanning.md)). A scan is custody evidence only: it records a checkpoint and pays any milestone, but never settles the escrow.
- **Each order's delivery uses final-mile proof of delivery** ([ADR 0006](0006-final-mile-proof-of-delivery.md)).

## Options

| Option | Pros | Cons | Cost to reverse |
| :--- | :--- | :--- | :--- |
| **A. One master shipment, door to door.** The shipper books one escrow for all orders. The forwarder subcontracts the line haul and a final-mile leg per order ([ADR 0004](0004-staged-contracts.md)). | No new contract concepts. One booking and one signature for the shipper. | One consignee field can't represent many consignees. Delivery is all-or-nothing, so one failed order holds the whole remainder, and disputes are per master, not per order. | Medium: per-order delivery would need contract changes later |
| **B. The master shipment ends at a destination hub, then one child shipment per order.** The shipper (or their agent) books and funds a child escrow per order from the hub. | Each order settles and disputes on its own. Consignees see only their order. | More bookings and signatures. Funds lock in stages. Needs a link between master and children (an order ID in each child's job hash). | Low: the existing contracts are reused |

## Questions for the spike

1. Does the shipper fund each child at booking, which is simple but locks more funds, or when the goods reach the hub?
2. Who contracts the final mile: the shipper (option B) or the forwarder (option A)?
3. What confirms the master's delivery? Under option B, a hub attestor calls `confirm_delivery` on the master. Under option A, there's no single door, so it might be the last order's proof of delivery, or a milestone schedule with one milestone per order.
4. How does a missing or damaged order in the master affect the master's payout? Is it a dispute on the master, or a deduction carried into that order's child?
5. Can one GRIDS request create many child escrows in one signature ([HLD §7 Q10](../hld.md#7-open-questions))? What would 100 children cost ([Q11](../hld.md#7-open-questions))?
6. What do consignees see? An order-level timeline only, with nothing about the other orders (privacy standard).

## Decision

None yet. The spike builds both options against the demo model, with the fictional route from the demo, and recommends one with its costs. Until then, no wireframes or code depend on consolidation (hard rule 7).
