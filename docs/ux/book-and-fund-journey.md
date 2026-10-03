# Journey: book, fund and label a shipment (shipper)

| | |
| :--- | :--- |
| **Status** | Draft (wireframe round 2: price now agreed first) |
| **Last reviewed** | 2026-10-03 |
| **Related** | [Wireframes](../wireframes/index.html) · [HLD §4](../hld.md#4-shipment-lifecycle) · [ADR 0002](../adr/0002-arbiter-panel.md) · [ADR 0003](../adr/0003-package-labels-and-scanning.md) |

## Job

When I hand goods to a carrier I can't fully vouch for, I want my payment locked until delivery is proven, so I can pay only for what arrives without chasing anyone.

## Journey

| Stage | Doing | Thinking | Feeling | Pain point | Opportunity |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Prepare | Gathers carrier, consignee, attestor and arbiter accounts | "Which address is the port agent's?" | Wary | Long account addresses; easy to paste the wrong one | Saved contacts with names; paste or scan an account QR; show the name back |
| Book | Enters goods, packages, amount, deadline, panel | "What happens if something goes wrong?" | Cautious | Panel and fallback terms are abstract | A plain-language summary: "If 2 of 3 arbiters can't agree in 3 days, 50% goes to the carrier" |
| **Fund** 💰 | Signs to lock 1,200 木 | "Can I get this back?" | Exposed | Fear of losing funds | State exactly when and how a refund is possible before signing |
| Label | Prints and sticks one label per pallet | "Did I put P2's label on P2?" | Busy | Mixed-up labels | Each label shows "2 of 3" and the package description, not just a QR |
| Track | Glances at the timeline | "Is it moving?" | Reassured or anxious | No news feels like bad news | Exceptions (a missing pallet) appear at the top of *Needs your action* |
| Outcome 💰 | Paid out, or claims a refund after the deadline | "Is it really over?" | Relieved | "Pending" vs "final" confusion | Show final only after 2 keyblocks, with a receipt |

💰 = money moves.

## Flow

**Entry:** an agreed quote → **Create shipment from these terms** (see [Agree the price](negotiate-price-journey.md)). The parties, goods and packages carry over from the request.

1. **Parties:** carrier, consignee, attestors, chosen from saved contacts or by pasting an address.
2. **Goods and packages:** the description and one row per handling unit (ID, description). The manifest hash is computed here.
3. **Terms:** the **agreed price and milestone schedule, locked** (an escrow on other terms is rejected, `NOT_AGREED`), plus the delivery deadline (date *and* block height), arbiter panel (pick N, set M), arbitration window and fallback split.
4. **Review:** everything in plain language → **Sign booking** (sign modal).
5. **Fund:** "Lock 1,200 木 in escrow" → **Sign** (sign modal). Pending → final.
6. **Print labels:** a sheet or per-unit labels.

**Steps:** 6 screens and 2 signatures. Booking and funding are separate signatures because the contract is created first, then funded (`fund()` must match the booked amount exactly). Merging them depends on whether `init` can be payable on Gajumaru, which would be a new HLD open question if we pursue it.

**Exits:**
- **Success:** funded and labels printed.
- **Partial:** booked but not funded → *Needs your action: Fund GF-2026-0008*.
- **Blocked:** insufficient balance → show the balance and the testnet faucet; wallet unreachable → copyable payload; booking rejected → the mapped error (e.g. `CONFLICTED_ARBITER`: "an arbiter can't also be the shipper, carrier or consignee") with the field highlighted.
