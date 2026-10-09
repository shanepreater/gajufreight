# Journey: book, fund and label a shipment (shipper)

| | |
| :--- | :--- |
| **Status** | Draft (round 2: price agreed first; booking and funding in one signature, ADR 0005; every term fixed before booking, ADR 0011 and ADR 0015) |
| **Last reviewed** | 2026-10-09 |
| **Related** | [Wireframes](../wireframes/index.html) · [HLD §4](../hld.md#4-shipment-lifecycle) · [ADR 0002](../adr/0002-arbiter-panel.md) · [ADR 0003](../adr/0003-package-labels-and-scanning.md) |

## Job

When I hand goods to a carrier I can't fully vouch for, I want my payment locked until delivery is proven, so I can pay only for what arrives without chasing anyone.

## Journey

| Stage | Doing | Thinking | Feeling | Pain point | Opportunity |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Check | Reads the shipment: payee, consignee, packages and every agreed term, all locked | "Is this what we agreed?" | Cautious | Fear that something changed since the deal | Everything comes from the request and the accepted quote, labelled with who set it; nothing to retype, so nothing to get wrong |
| **Fund** 💰 | Signs to lock 3,020 木 (GF-2026-0008) | "Can I get this back?" | Exposed | Fear of losing funds | State exactly when and how a refund is possible before signing |
| Label | Prints and sticks one label per pallet | "Did I put P2's label on P2?" | Busy | Mixed-up labels | Each label shows "2 of 3" and the package description, not just a QR |
| Track | Glances at the timeline | "Is it moving?" | Reassured or anxious | No news feels like bad news | Exceptions (a missing pallet) appear at the top of *Needs your action* |
| Outcome 💰 | Paid out, or claims a refund after the deadline | "Is it really over?" | Relieved | "Pending" vs "final" confusion | Show final only once the network's finality rule is met (witness finality on mainnet, a set depth on testnet; HLD §7 Q17), with a receipt |

💰 = money moves.

## Flow

**Entry:** an agreed quote → **Create shipment from these terms** (see [Agree the price](negotiate-price-journey.md)). Forwarders are found by searching the verified directory, filtered by the job's lane, before quotes are requested ([ADR 0009](../adr/0009-organisations-and-directory.md)).

Every choice was made earlier: the consignee, packages, arbiter panel and dispute terms in the request, and the price, schedule, deadline and attestors in the forwarder's quote ([ADR 0015](../adr/0015-forwarder-led-quoting.md) point 8). Booking passes only the manifest and consignee, which must match the request, and the escrow reads the terms from the quote ([ADR 0011](../adr/0011-agreed-booking-terms.md)).

1. **Check the shipment:** payee and consignee, goods and packages (with the manifest fingerprint), and every agreed term, all read-only and each labelled with who set it: price, milestones, deadline (date *and* block height), attestors, arbiter panel with quorum, window and fallback, and the challenge window. To change the packages or consignee, the shipper withdraws and requests again.
2. **Sign:** everything in plain language → **Create and fund 3,020 木**: one signature creates the shipment and locks the agreed price ([ADR 0005](../adr/0005-platform-booking-privacy.md)). Pending → final.
3. **Print labels:** a sheet or per-unit labels.

**Steps:** 3 screens and **1 signature**. There is no separate funding step and no "booked but not funded" state (HLD §7 Q12). QPQ confirm a create transaction carries an amount; the Phase 0 spike checks that the escrow's `init` sees it, and whether a wallet can sign a create over GRIDS. If it can't, the platform clones and funds the escrow in one call, so booking is still one signature. The shipper pays only the agreed price: GajuFreight's fee comes out of the payee's payouts, and refunds carry none ([ADR 0010](../adr/0010-platform-fee.md)).

**Exits:**
- **Success:** funded and labels printed.
- **Partial:** none on-chain: until *Create and fund* is signed, nothing exists; the draft stays in the app.
- **Blocked:** insufficient balance → show the balance and the testnet faucet; wallet unreachable → copyable payload; booking rejected → the mapped error. For example, `CONFLICTED_ARBITER` means the winning forwarder or the consignee is on the shipper's panel; the forwarder saw the panel before quoting, so the fix is to request again with another arbiter.
