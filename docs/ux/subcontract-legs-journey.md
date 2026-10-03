# Journey: subcontract legs and get paid (forwarder and leg carriers)

| | |
| :--- | :--- |
| **Status** | Draft (wireframe round 2) |
| **Last reviewed** | 2026-10-03 |
| **Related** | [Wireframes](../wireframes/index.html) · [Agree the price](negotiate-price-journey.md) · [Scan custody](scan-custody-journey.md) · [ADR 0004: staged contracts](../adr/0004-staged-contracts.md) |

## Jobs

- **Forwarder:** When I've won a shipment, I want each leg covered by a reliable carrier at a known cost, so my margin is safe and the goods keep moving.
- **Leg carrier:** When a forwarder offers me a leg, I want the money locked before I start, so I'm paid when I hand over the goods.

## Journey

| Stage | Doing | Thinking | Feeling | Pain point | Opportunity |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Plan | Forwarder splits the route into legs (Yantian → Rotterdam ocean, Rotterdam → Tilburg road) | "Who covers each leg?" | Busy | Juggling several shipments at once | A legs board per shipment: leg, carrier, price, status |
| Quote | Requests a quote per leg from invited carriers; counters | "Will my margin hold?" | Watchful | Margin only visible on a spreadsheet | Live margin: agreed with the shipper, minus legs agreed or quoted |
| Offer (carrier) | Carrier sees the leg, the price and the handover point | "Is the money really there?" | Sceptical | Being paid late by forwarders | Shown: "Funds locked in escrow ✓", how much, and who confirms the handover |
| **Fund** 💰 | Forwarder funds each leg escrow just before that leg starts | "Cash out before cash in" | Exposed | Funding legs before shipper milestones arrive | The board shows incoming milestones against outgoing legs, by date |
| Move 📦 | Carriers scan out and in; handovers confirm the incoming leg | "Did the handover register?" | Rushed | Two signatures at a handover (until batching) | One *Confirm handover* action that walks through both |
| **Paid** 💰 | Milestones reach the forwarder; leg carriers are paid at handover | "Am I square?" | Satisfied | Reconciling by hand | Per-shipment statement: in, out, margin |

## Flow (forwarder)

**Entry:** after a quote is agreed: *Needs your action → Subcontract legs for GF-2026-0010*.

1. **Legs board:** add legs (from, to, handover party) → per leg, **Request carrier quotes**.
2. **Per leg:** the negotiation thread (the same screen as with shippers) → accept.
3. **Fund leg:** sign (fee and amount shown). The carrier sees "Funded".
4. **Track:** milestones in and leg payouts out, with the margin to date.

**Steps:** 1 board, plus 2 screens per leg. Signatures per leg: request, offers, accept, fund.

## Flow (leg carrier)

**Entry:** *Needs your action → Leg offer: Rotterdam → Tilburg*.

1. **Leg offer:** route, pickup and handover, the price, who confirms the handover, and whether it's funded → *Quote*, *Counter* or *Accept*.
2. On the day: the **scan session**, as in round 1.
3. **Paid:** shown when the next party confirms the handover, and *final* after 2 keyblocks.

**Cash flow** (round 4 review, [item 5](review-round-4-feedback.md#5-leg-payments-when-the-forwarder-defines-the-legs)): the shipper never sees the legs. The forwarder funds each leg escrow from their own money and is paid by the shipper's milestones. To keep the exposure small:
- **Fund each leg just in time,** before it starts, not all at booking.
- **When quoting, line the shipper's milestones up with the handovers.** For example, a 60% milestone at the Rotterdam scan-in lands when the ocean carrier is paid.
- **The legs board shows a cash-flow line:** incoming milestones against outgoing legs, by date.

A shipper escrow paying the leg escrows directly would remove the exposure, but it couples the contracts and leaks leg prices to the shipper. It's a later option, not planned.

**Exceptions:** a leg not funded (don't start, and show that clearly); the handover party is missing (an attestor can confirm instead); a leg quote expired (re-quote).
