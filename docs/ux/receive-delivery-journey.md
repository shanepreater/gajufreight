# Journey: track and receive a delivery (consignee)

| | |
| :--- | :--- |
| **Status** | Draft (wireframe round 5) |
| **Last reviewed** | 2026-10-03 |
| **Related** | [Wireframes](../wireframes/receive-delivery.html) · [Deliver the final mile](deliver-final-mile-journey.md) · [ADR 0006: final-mile proof of delivery](../adr/0006-final-mile-proof-of-delivery.md) (proposed) · [HLD §4](../hld.md#4-shipment-lifecycle) |

## Job

When goods are on their way to me, I want to know when they'll arrive and to be able to report a problem, so I never end up paying for missing or damaged goods.

Since round 5, the consignee no longer confirms delivery. The final-mile driver proves it with scans, photos and the consignee's code, as couriers already do ([round 4 review, items 11–12](review-round-4-feedback.md#11-final-mile-agent-proves-delivery)).

## Journey

| Stage | Doing | Thinking | Feeling | Pain point | Opportunity |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Track | Opens the tracking link | "Where is it, and when will it arrive?" | Curious | Freight tracking is full of jargon | Five plain stages and an estimated date. No prices or legs |
| Expect | Gets "Out for delivery" and a 6-digit code | "What do I need to do?" | Neutral | Surprise arrivals | The code and the delivery window, with a `?` explaining what the code does |
| **Receive** 📦 | Gives the code to the driver | "Am I agreeing to anything?" | Rushed (driver waiting) | Signing for goods unseen | The code only proves the driver met you. If anything is missing, payment is still held for 24 h |
| Check | Sees the proof of delivery: photos and what arrived | "Is everything here?" | Careful | No record of what the driver left | The proof lists each package that arrived and which didn't |
| **Report** 💰 | Reports a problem within the window | "Will anyone act on this?" | Worried | Disputes feel opaque | One screen with a reason and photos. It freezes the final payment until arbiters decide |

## Flow

**Entry:** a tracking link, or *Needs your action → GF-2026-0008 out for delivery*.

1. **Track:** stages with dates, the delivery code, and *Report a problem*.
2. **Delivered:** photos, who received it, what arrived and what didn't, and the deadline for reporting.
3. **Report a problem:** what's wrong, details, photos → sign (the dispute freezes the unpaid amount).

**Steps:** none required. Reporting takes 1 screen and 1 signature.

**Exits and edge cases:**
- **Not home:** the driver leaves the goods in a safe place with a photo. With no code, the final payment is held for 24 h so the consignee can report a problem.
- **Missing package at delivery:** always held for the window, even if the code was given (ADR 0006).
- **Window passed:** the delivery stands. Problems after that are a claim with the forwarder, outside the escrow.
- **Report after settlement:** `BAD_STATE` → "This shipment is already settled," with a link to the receipt.
