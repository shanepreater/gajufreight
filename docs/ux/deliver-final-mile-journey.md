# Journey: deliver the final mile (driver)

| | |
| :--- | :--- |
| **Status** | Draft (wireframe round 5) |
| **Last reviewed** | 2026-10-03 |
| **Related** | [Wireframes](../wireframes/proof-of-delivery.html) · [Track and receive](receive-delivery-journey.md) · [ADR 0006](../adr/0006-final-mile-proof-of-delivery.md) · [ADR 0008: sessions](../adr/0008-app-sessions.md) |

The consignee may have no wallet ([decision log](../decision-log.md) #8). The driver's proof of delivery and the code check never need one.

## Job

When I reach a delivery address, I want to prove I delivered quickly, so I'm paid and can get to the next stop.

## Journey

| Stage | Doing | Thinking | Feeling | Pain point | Opportunity |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Start shift | Unlocks the app | "Let me just get going" | Busy | Logging in on every stop | One wallet signature per shift, then the screen lock ([ADR 0008](../adr/0008-app-sessions.md)) |
| Arrive | Opens the stop | "Which door, and what's for here?" | Rushed | Hunting for the right parcels | Stop address, door, and the packages expected here |
| **Hand over** 📦 | Scans each package off the van | "Did I get them all?" | Rushed | Missing items found later | A running "2 of 3", with known-missing items already marked |
| Prove | Takes photos, asks for the code | "Is that enough proof?" | Hurried | Arguments about deliveries later | At least 1 photo, then the code (or why there's none) |
| **Sign** 💰 | Signs proof of delivery | "Am I done?" | Relieved | No signal | It queues offline. Pending, then final |

## Flow

**Entry:** the day's route → *Stop 3 of 9*.

1. **Scan at the door:** each package against the manifest.
2. **Photos:** at least 1. *Received by* is optional.
3. **Delivery code:** enter it, or choose *Left in a safe place* or *Receiver didn't have the code*.
4. **Review and sign** in GajuMobile.

**Steps:** 4 screens and 1 signature per stop.

**Exits and edge cases:**
- **Wrong code:** "2 tries left". After 5 tries, entry locks, and the driver delivers without a code.
- **Not an attestor on this shipment** (joined after booking): blocked before scanning, with who can sign instead.
- **Package not on board:** recorded as missing, and the delivery still goes ahead. The final payment is held for 24 h.
- **No signal:** the signature queues and sends later. The scan times are in the evidence.
