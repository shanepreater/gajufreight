# ADR 0006: Final-mile proof of delivery

| | |
| :--- | :--- |
| **Status** | Accepted (2026-10-06, [decision log](../decision-log.md) #3 and #8): with `remove_attestor` and an optional consignee, below |
| **Last reviewed** | 2026-10-03 |
| **Related** | [HLD §4](../hld.md#4-shipment-lifecycle) · [HLD §5](../hld.md#5-contract-sketch-sophia) · [HLD §6.7](../hld.md#67-staged-contracts-and-milestones) · [ADR 0003](0003-package-labels-and-scanning.md) · [ADR 0004](0004-staged-contracts.md) · [Round 4 review, item 11](../ux/review-round-4-feedback.md#11-final-mile-agent-proves-delivery) |

## Context

In parcel logistics today, the final-mile driver (DPD, DHL and others) proves delivery by scanning each parcel at the door and taking a photo. The consignee rarely signs anything. Our design asked the consignee to confirm delivery, which doesn't match how deliveries happen.

The current contract has three gaps for this:

- **The driver is the payee of their own leg.** `confirm_delivery` accepts the consignee or any registered attestor. If the driver were an attestor on their own leg escrow, they could pay themselves. HLD §6.7 says no payee can do that.
- **Nothing enforces that rule.** `init` doesn't reject `carrier ∈ attestors`, so the rule rests on how the booking is configured.
- **A false "delivered" can't be challenged.** `confirm_delivery` releases the remainder in the same call (HLD §4 rule 4). Once released, the escrow is terminal, so the consignee can't dispute.

## Decision

- **The final-mile agent is the carrier of the last leg** (a forwarder ↔ agent escrow, [ADR 0004](0004-staged-contracts.md)). The booking registers them as an **attestor on the upstream escrow**, the shipper ↔ forwarder one, where they aren't the payee. Their proof of delivery confirms delivery there, which pays the forwarder the remainder.
- **The forwarder confirms the last leg.** The forwarder is the payer of the last leg, so they're registered as its attestor and confirm it once the upstream escrow shows delivery. The consignee can also confirm it. If the forwarder stalls, the agent can raise a dispute, and the panel's fallback means it can't stall for ever (contract invariants).
- **Which escrow each confirmation settles:**

  | Escrow | Payer → payee | Confirms delivery | Effect |
  | :--- | :--- | :--- | :--- |
  | The shipment (shipper ↔ forwarder) | Shipper → forwarder | The final-mile agent's handler as attestor (normal path), the consignee, or another attestor | Pays the forwarder the unpaid remainder, or starts the challenge window (below) |
  | The last leg (forwarder ↔ final-mile agent) | Forwarder → agent | The forwarder as attestor, or the consignee | Pays the agent |

  Earlier legs are unchanged: the next party confirms the handover ([ADR 0004](0004-staged-contracts.md)).
- **How the driver becomes an attestor.** The shipment escrow is created at booking, and its attestor list is fixed then. But the forwarder often picks the final-mile agent later. In order of preference:
  1. **Name the final-mile company in the forwarder's quote.** It's part of the agreed terms, and at booking the attestor list includes that company's handler addresses ([ADR 0009](0009-organisations-and-directory.md)).
  2. **An organisation-level attestor:** the escrow lists one address for the company, which delegates to its current handlers. This also covers drivers who join after booking ([HLD §7 Q15](../hld.md#7-open-questions)).
  3. **For a change after booking, the shipper adds an attestor:** `add_attestor(a)`, which only the shipper (the payer) can call, while the escrow is `Funded` or `InTransit`, and never for the payee (`ONLY_SHIPPER`, `BAD_STATE`, `CONFLICTED_ATTESTOR`). Adding an attestor can only release the payer's own money, so the forwarder (the payee) can't call it. The forwarder requests it in the app, and the shipper signs it.

  If none of these is in place, the consignee or an existing attestor confirms delivery instead, and the driver's evidence goes into the bundle.
- **Proof of delivery is an evidence bundle:**
  - a scan of each package checked against the manifest ([ADR 0003](0003-package-labels-and-scanning.md));
  - at least one photo;
  - the time and place;
  - the outcome of the delivery code (*matched*, *not given* or *left in a safe place*);
  - optionally, the name of the person who received it.

  Only the bundle's hash goes on-chain (hard rule 4).
- **Delivery code:**
  - The app sends the consignee a 6-digit one-time code when the shipment is out for delivery.
  - **The API checks it off-chain.** A short code hashed on-chain could be brute-forced from the public hash. The API's signed check record goes into the evidence bundle.
  - Entry locks after 5 wrong tries.
  - The code is optional, so a delivery can still be left in a safe place.
- **Proposed contract changes** (a separate plan once this ADR is accepted, tests first):
  1. **`init` adds `require(!List.contains(carrier, attestors), "CONFLICTED_ATTESTOR")`,** so a payee can never be an attestor on their own escrow.
  2. **`add_attestor(a)`** for the shipper, as above, if option 1 or 2 isn't enough.
  3. **A challenge window for deliveries without a code:**
     - `confirm_delivery(evidence, code_checked : bool)` releases immediately if the consignee calls it, or if an attestor calls it with `code_checked = true`. The attestor passes `true` only when the consignee's code matched **and** every package in the manifest was delivered. A delivery with a missing or damaged package always goes through the window, so the consignee can dispute it.
     - Otherwise it moves the escrow to **`Delivered`** and holds the remainder for `challenge` blocks, a booking term of about 24 h.
     - While it's `Delivered`, the consignee or shipper can `raise_dispute`. After the window, anyone can call `release_after_window()`.
  4. **`remove_attestor(a)`** (decided 2026-10-06): the payer and the payee each call it once for the same attestor, in either order, while the escrow is `Funded` or `InTransit`; the attestor is removed on the second call (`UNAUTHORIZED`, `BAD_STATE`, `NOT_ATTESTOR`). Neither side can remove one alone: the payer could block milestones, and the payee could remove the attestor who'd report a problem. A stolen attestor key is contained this way, or by a dispute.
  5. **The consignee is optional** (decided 2026-10-06). When the final-mile proof of delivery is the proof, the consignee needs no wallet: the escrow's consignee is `None`, the consignee gets the delivery code and a tracking link by email, and a problem they report in the app is raised on-chain by the shipper during the challenge window. A consignee with a wallet can still confirm and dispute directly.

## Consequences

- **Good:**
  - Delivery matches how final-mile carriers already work, and the consignee doesn't have to do anything.
  - A false delivery can be challenged on-chain.
  - "No payee pays themselves" is enforced by the contract, not by configuration.
- **Cost:**
  - `Delivered` is a new, non-terminal state. This deliberately relaxes HLD §4 rule 4 ("no half-finished delivered but unpaid state"). It's bounded by the window, and anyone can trigger the release, so it can't freeze funds.
  - Deliveries without a code pay the forwarder about a day later.
  - It needs new error codes, new states in the demo model (`scripts/demo/lib/shipment-escrow.js`), fund-conservation tests that cover `Delivered`, and screen states for it.
- **Trust:** `code_checked` is the attestor's claim, like any attestation (HLD §6.3). A false claim is visible in the evidence bundle, because the API's check record is missing or doesn't match, and the panel can rule on it in a dispute.
- **Docs:** once this is accepted, HLD §3–5 and the receive-delivery journey describe the new lifecycle.
