# Journey: book, fund and label a shipment (shipper)

| | |
| :--- | :--- |
| **Status** | Draft (round 2: price agreed first; booking and funding in one signature, ADR 0005) |
| **Last reviewed** | 2026-10-03 |
| **Related** | [Wireframes](../wireframes/index.html) · [HLD §4](../hld.md#4-shipment-lifecycle) · [ADR 0002](../adr/0002-arbiter-panel.md) · [ADR 0003](../adr/0003-package-labels-and-scanning.md) |

## Job

When I hand goods to a carrier I can't fully vouch for, I want my payment locked until delivery is proven, so I can pay only for what arrives without chasing anyone.

## Journey

| Stage | Doing | Thinking | Feeling | Pain point | Opportunity |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Prepare | Gathers carrier, consignee, attestor and arbiter accounts | "Which address is the port agent's?" | Wary | Long account addresses; easy to paste the wrong one | Saved contacts with names; paste or scan an account QR; show the name back |
| Book | Enters goods, packages, amount, deadline, panel | "What happens if something goes wrong?" | Cautious | Panel and fallback terms are abstract | A plain-language summary: "If 2 of 3 arbiters can't agree in 3 days, 50% goes to the carrier" |
| **Fund** 💰 | Signs to lock 3,000 木 (GF-2026-0008) | "Can I get this back?" | Exposed | Fear of losing funds | State exactly when and how a refund is possible before signing |
| Label | Prints and sticks one label per pallet | "Did I put P2's label on P2?" | Busy | Mixed-up labels | Each label shows "2 of 3" and the package description, not just a QR |
| Track | Glances at the timeline | "Is it moving?" | Reassured or anxious | No news feels like bad news | Exceptions (a missing pallet) appear at the top of *Needs your action* |
| Outcome 💰 | Paid out, or claims a refund after the deadline | "Is it really over?" | Relieved | "Pending" vs "final" confusion | Show final only once the network's finality rule is met (witness finality on mainnet, a set depth on testnet; HLD §7 Q17), with a receipt |

💰 = money moves.

## Flow

**Entry:** an agreed quote → **Create shipment from these terms** (see [Agree the price](negotiate-price-journey.md)). Forwarders are found by searching the verified directory, filtered by the job's lane, before quotes are requested ([ADR 0009](../adr/0009-organisations-and-directory.md)). The parties, goods and packages carry over from the request.

1. **Parties:** carrier, consignee, attestors, chosen from saved contacts or by pasting an address.
2. **Goods and packages:** the description and one row per handling unit (ID, description). The manifest hash is computed here.
3. **Terms:** the **agreed price and milestone schedule, locked** (an escrow on other terms is rejected, `NOT_AGREED`), plus the delivery deadline (date *and* block height), arbiter panel (pick N, set M), arbitration window and fallback split.
4. **Review and create:** everything in plain language → **Create and fund 3,000 木**: one signature creates the shipment and locks the agreed price ([ADR 0005](../adr/0005-platform-booking-privacy.md)). Pending → final.
5. **Print labels:** a sheet or per-unit labels.

**Steps:** 5 screens and **1 signature**. There is no separate funding step and no "booked but not funded" state (HLD §7 Q12). QPQ confirm a create transaction carries an amount; the Phase 0 spike checks that the escrow's `init` sees it, and whether a wallet can sign a create over GRIDS. If it can't, the platform clones and funds the escrow in one call, so booking is still one signature. The shipper pays only the agreed price: GajuFreight's fee comes out of the payee's payouts, and refunds carry none ([ADR 0010](../adr/0010-platform-fee.md)).

**Exits:**
- **Success:** funded and labels printed.
- **Partial:** none on-chain: until *Create and fund* is signed, nothing exists; the draft stays in the app.
- **Blocked:** insufficient balance → show the balance and the testnet faucet; wallet unreachable → copyable payload; booking rejected → the mapped error (e.g. `CONFLICTED_ARBITER`: "an arbiter can't also be the shipper, carrier or consignee") with the field highlighted.
