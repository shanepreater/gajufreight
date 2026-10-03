# Journey: scan packages in and out (attestor, carrier)

| | |
| :--- | :--- |
| **Status** | Draft (wireframe round 1) |
| **Last reviewed** | 2026-10-03 |
| **Related** | [Wireframes](../wireframes/index.html) · [ADR 0003](../adr/0003-package-labels-and-scanning.md) |

## Jobs

- **Attestor / carrier:** When a truck or container arrives or leaves, I want to record which packages are here in seconds, so custody is proven and I'm not blamed for goods I never had.
- **Carrier (payout):** When delivery is proven, I want to see the money is really mine, so I can close the job and invoice nothing.

## Journey

| Stage | Doing | Thinking | Feeling | Pain point | Opportunity |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Arrive | Opens the app on a phone, gloves on | "Which shipment is this?" | Hurried | Hunting through lists | **Scan any label first**: the app opens the right shipment and session |
| Scan | Scans units one after another | "Did that one register?" | Focused | Silent failures; glare; damaged labels | Beep or vibration per scan; a big running count "2 of 3"; manual ID entry |
| Review | Checks missing items and exceptions | "Pallet 2 isn't here. Is that my fault?" | Defensive | Fear of blame | A missing item is *recorded, not blocking*, and the record protects them |
| **Sign** 📦 | Signs one checkpoint | "No signal on the quay…" | Frustrated | Flaky network | Hand off to GajuMobile by **deep link** (you can't scan your own screen); if offline, show "Signed, will send when online" |
| Confirm | Sees pending → final | "Done, next truck" | Relieved | — | Return straight to *Scan next* |
| **Paid** 💰 | Carrier sees the payout | "Is it mine now?" | Satisfied | "Pending" looks like paid | The amount only goes green at *final* |

📦 = custody changes · 💰 = money moves.

## Flow

**Entry:** scan a package label (camera on launch), or *Needs your action → Scan in at Rotterdam*.

1. **Scan session:** continuous camera. The running list shows ✓ expected, ↺ repeat, ⚠ unknown or foreign or cloned, and missing.
2. **Review:** the "2 of 3 present" summary, with an optional photo and seal number.
3. **Sign checkpoint:** one signature for every package scanned (deep link to GajuMobile on phone, QR on desktop).
4. **Done:** pending → final, then **Scan next**.

**Steps:** 4 screens and 1 signature, however many packages there are.

**Exceptions and recovery:**

| Exception | What the user sees | Recovery |
| :--- | :--- | :--- |
| Foreign label | "This label belongs to GF-2026-0099" | **Open that shipment** or set the item aside |
| Unknown package | "GF8-P9 isn't on this shipment's manifest" | Set aside; tell the shipper |
| Cloned label | "GF8-P1 is already scanned in at Rotterdam" | Kept out of the scan and flagged on the timeline for the shipper and panel |
| Damaged label | — | **Type ID** (validated like a scan; marked *typed*) |
| Not an attestor | Shown **before** scanning: "You can't record custody on GF-2026-0008" | Contact the shipper; the contract would reject it anyway (`UNAUTHORIZED`) |
| Offline | "3 checkpoints waiting for signal" | Sends automatically; the scan times are kept in the evidence |
| Transaction dropped | "Not confirmed. Resubmitting…" | Automatic resubmission; the person signs again only if asked |
