# Journey: receive a delivery (consignee)

| | |
| :--- | :--- |
| **Status** | Draft (wireframe round 1) |
| **Last reviewed** | 2026-10-03 |
| **Related** | [Wireframes](../wireframes/index.html) · [HLD §4](../hld.md#4-shipment-lifecycle) |

## Job

When goods arrive at my door, I want to confirm only what actually arrived, so I never pay for missing or damaged goods.

## Journey

| Stage | Doing | Thinking | Feeling | Pain point | Opportunity |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Expect | Gets "GF-2026-0008 out for delivery" | "When is it coming?" | Neutral | Surprise arrivals | The Needs-your-action entry appears when the shipment is out for delivery |
| Check | Scans the labels at the door | "Is everything here?" | Careful | Counting by hand | The same scan session as attestors: "2 of 3 present" |
| **Decide** 💰 | Confirms or disputes | "If I confirm, can I undo it?" | Pressured (driver waiting) | Irreversible either way | Two clear buttons, each saying what it does: *Confirm and release 3,000 木* (can't be undone) or *Dispute and freeze funds* |
| After | Sees the result | "What happens now?" | Relief or worry | Disputes feel opaque | The dispute page shows the panel, its votes and the deadline |

## Flow

**Entry:** *Needs your action → Receive GF-2026-0008*, or scan a label at the door.

1. **Check arrival:** scan the labels; see present and missing.
2. **Decide:** if everything is present, *Confirm delivery*; if anything is missing or damaged, *Raise dispute* with a reason, photos and the scan bundle as evidence.
3. **Sign:** the sign modal states the consequence in full.

**Steps:** 3 screens and 1 signature.

**Exits and edge cases:**
- **The consignee doesn't respond:** the screen says plainly that the port attestor can confirm delivery, so silence doesn't block the carrier's payment (HLD §4 rule 3).
- **Confirm after the shipment is already settled:** `BAD_STATE` → "This shipment is already settled," with a link to the receipt.
- **Partial arrival:** the dispute is pre-filled with the missing package IDs.
