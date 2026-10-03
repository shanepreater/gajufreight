# Wireframe review: round 4 feedback

| | |
| :--- | :--- |
| **Status** | Responses planned and approved (2026-10-03). Design is in this PR; screens follow in wireframe round 5 |
| **Last reviewed** | 2026-10-03 |
| **Related** | [Wireframes](../wireframes/index.html) · [HLD §3–4](../hld.md#3-actors) · [ADR 0003: labels](../adr/0003-package-labels-and-scanning.md) · [ADR 0004: staged contracts](../adr/0004-staged-contracts.md) · [Privacy standard](../hld.md#68-privacy-standard) |

This is the product owner's first review of the clickable wireframes (round 4), plus item 14, raised while reviewing the plan. Each item records the feedback, what the design does today, and its type:

- **UI:** a wireframe or brand change only.
- **Design:** it changes the HLD, an ADR or the API rules, but not who may do what.
- **Contract:** it changes *who may do what* on-chain. The solutions architect decides it, and it needs an ADR and an approved plan before any build.

Answers to the questions are proposals until the plan for this round is approved.

## Summary

| # | Feedback | Type | Screens and docs affected | Response lands in |
| :-: | :--- | :--- | :--- | :--- |
| 1 | Missing item: last seen, who signed, who should have it now | UI | shipment-detail, scan-session, edge-states | Round 5 |
| 2 | The "missing" pill in All shipments jumps to that breakdown | UI | my-shipments | Round 5 |
| 3 | Self-describing parts, with `?` pop-ups for the nuances | UI (brand component) | All screens, brand guide | Round 5 (brand `.help`) |
| 4 | Package labels need human-checkable details | UI, Design | print-labels, ADR 0003 | [ADR 0003](../adr/0003-package-labels-and-scanning.md), round 5 |
| 5 | Leg payments when the forwarder, not the shipper, defines the legs | Question (design answers it) | legs-board, subcontract-legs journey | [Subcontract legs](subcontract-legs-journey.md), round 5 |
| 6 | A common footer with the app version and support details | UI (brand component) | All screens, brand guide | Round 5 (brand `.app-foot`) |
| 7 | A feedback button on every flow, routed to the dev team's front door | UI, Design | All screens, architecture blueprint | [Blueprint §3](../architecture-blueprint.md#3-components), round 5 |
| 8 | Faster, simpler sign-in and sign-out for busy port handlers | UI, Design | connect-wallet, scan-session | [ADR 0008](../adr/0008-app-sessions.md), round 5 |
| 9 | The backend enforces whatever the UI hides | Design | architecture blueprint, backend-services skill | [Blueprint §4](../architecture-blueprint.md#4-trust-boundaries), skills |
| 10 | A smarter forwarder picker that scales to hundreds | UI, Design | request-quotes | [ADR 0009](../adr/0009-organisations-and-directory.md), round 5 |
| 11 | The final-mile delivery agent proves delivery, not the consignee | Contract | receive-delivery, HLD §3–4 | [ADR 0006](../adr/0006-final-mile-proof-of-delivery.md) (Proposed), round 5 |
| 12 | A simplified timeline for the consignee | UI | New consignee tracking screen | Round 5 |
| 13 | Bulk ship to the destination country, then final-mile the individual orders | Contract | HLD §4, new ADR, new journey | [ADR 0007](../adr/0007-consolidated-shipments.md) (spike) |
| 14 | How forwarders and carriers sign up to be listed | Design | New sign-up and organisation screens, admin verification, request-quotes | [ADR 0009](../adr/0009-organisations-and-directory.md), round 5 |

## Items

### 1. Chase a missing item

> When I have a missing item, I want to know where it was last and who signed for it. Then I want to know who should have been in possession of it from there, so I can start to chase it down.

**Today:** shipment-detail shows "GF8-P2: out Yantian → not seen" in the custody table, and an exception on the timeline. It doesn't name who signed the last scan, or who should have had the item next.

**Response:** add a **missing-item breakdown** per package:
- the last confirmed scan (place, time, kind, and the signing attestor or carrier);
- the expected custody chain from that point, taken from the legs (who should have received it next, and by when);
- where it was expected but not seen;
- contact actions for each party in that chain (in-app, with no addresses exposed beyond the viewer's role);
- *Raise a dispute* and *Mark found* as next steps.

The data already exists: scan evidence bundles (ADR 0003) and the legs board.

### 2. Clickable "missing" pill

> All Shipments: the pill which shows something is missing should be clickable and jump to the above breakdown.

**Response:** the badge becomes a link (with a 44 px target and an accessible name such as "1 missing: view GF8-P2") to the breakdown anchor from item 1. The same applies wherever an exception badge appears.

### 3. Self-describing parts with `?` help

> Each part should self-describe and be as simple as possible. If there are nuances or further instructions needed, then there should be a pop-up available from a ? icon, so the user can discover this as they progress.

**Today:** the explanations are inline paragraphs and `.note` blocks, which add length to every screen.

**Response:**
- Add a brand **help component**: a `?` button (44 px, labelled "Help: <topic>") that opens a short pop-up, built on the native `popover` or `<details>` so it works without script and from the keyboard.
- Cut inline text on each screen to one plain line, and move the nuances (fees, finality, privacy, error codes) into help.
- Reviewer notes (`.note`) stay as they are, because they're for reviewers, not users.

### 4. Human-checkable package labels

> Package labels lack details. This should be easy for a human handler to verify along with the QR code.

**Today:** ADR 0003 requires the package ID, the shipment reference and "n of N" in readable text.

**Response:** extend the label so a handler can check it without scanning:
- consignee name and the delivery address;
- origin → destination, and the next handover point;
- weight and dimensions, plus handling marks (fragile, this way up, stackable);
- a short **check code** printed beside the QR, so a manual entry can be checked against the scan.

The QR still only identifies the package. [ADR 0003](../adr/0003-package-labels-and-scanning.md) now lists this content, with a privacy note: the label is physical, so it carries only what a handler needs, and no prices.

### 5. Leg payments when the forwarder defines the legs

> How do partial payments work when the shipper doesn't define the legs? This is done by the forwarder. Does this mean the forwarder essentially has to add the leg costs in escrow to cover their contract to those parties, and then receive the staged payments from the shipper?

**Today (ADR 0004, HLD §6.7):** yes. There are two levels of escrow:
- The **shipper ↔ forwarder** escrow holds the full agreed price. It pays the forwarder at the milestones agreed at booking (`(location, pct)`), and the remainder on delivery.
- Each **forwarder ↔ leg carrier** escrow is funded by the forwarder, from their own funds, and pays that carrier at the handover.

The forwarder's margin is the difference. The shipper never sees the legs or their prices (privacy standard). The known pain is **cash out before cash in** (subcontract-legs journey).

**Proposed response (no contract change):**
- **Fund each leg just in time,** before that leg starts, not all at booking.
- **Line shipper milestones up with the forwarder's handovers** when quoting. For example, if the Rotterdam scan-in pays the forwarder 60%, that lands when the ocean leg's carrier is paid.
- Show it on the **legs board as a cash-flow line**: outgoing legs against incoming milestones, by date.

A shipper escrow that pays leg escrows directly would remove the exposure, but it couples the contracts and leaks leg prices. Recommendation: not now. Record it as a later option.

### 6. Common footer

> Each page, be it desktop or mobile, should have a common footer which displays the app's version and other pertinent information for if something goes wrong.

**Response:** add a brand **app footer** on every screen showing:
- the app version and build;
- the network (testnet or mainnet) and chain sync state (block height, and whether it's behind);
- a support reference to quote (a session or request ID);
- links to help and to the feedback item (item 7).

Field screens keep it compact, with one line plus a "details" disclosure.

### 7. Feedback button on every flow

> Every user flow should have an easy feedback button to report errors or improvements. These should end up going to a front door for the development team to triage.

**Response:**
- A **Feedback** button sits in the app header or footer on every screen. It opens a short form (kind: error, idea or other; a message; an optional screenshot) and automatically attaches the screen, app version, network and support reference.
- The API forwards it to the team's **front door** for triage. No tokens sit in the browser.
- **Privacy:** no keys, addresses or shipment contents are attached unless the user ticks to include them.

**Decision needed:** which front door. The recommendation is GitHub Issues on this repo, with a `triage` label.

### 8. Quick sign-in and sign-out

> The sign in and out process should be as quick and simple as possible. Can we simplify this? The port handlers are really busy.

**Today:** connect-wallet signs a one-time message with GajuDesk or GajuMobile on every sign-in.

**Response (to plan):**
- A **remembered device:** one wallet signature starts a long-lived session for a shift. After that, the handler unlocks with the phone's own screen lock or a PIN.
- A **one-tap sign-out** and a **"switch handler"** option for shared devices.
- The session expires automatically at the end of the shift.

Custody and value actions still need a wallet signature each time (hard rule 1). Batching them is HLD Q10.

### 9. The backend enforces what the UI hides

> We need to ensure that if an action is unavailable in the UI, then the backend also enforces this, so people can't just manually override a URI to circumvent the system.

**Today:**
- **On-chain,** the contract checks role, then status, then arguments on every entrypoint (AGENTS.md invariants), so a hand-built call fails there.
- **In the app,** nothing yet says the API must enforce the same rules. The API's own rules also cover reads, which the privacy standard filters by role.

**Response:** record it as a design rule in the architecture blueprint and the backend-services skill:
- Every API endpoint authorises the caller by role and shipment status, for reads as well as writes.
- The API refuses to build a GRIDS payload for an action the caller can't take.
- The UI only reflects what the API allows, and is never the control.
- Tests cover direct calls to each endpoint by every other role.

### 10. Smarter forwarder picker

> Invite forwarders should be a smarter list. There could potentially be hundreds of forwarders or logistics companies.

**Today:** request-quotes shows three checkboxes.

**Response:**
- A **search-and-filter picker:**
  - search by name;
  - filter by lane (origin and destination), mode, certifications and capacity;
  - sort by your history and delivery record.
- Favourites and recent forwarders sit on top, and a **shortlist** shows the chosen forwarders with a cap.
- It needs a **forwarder directory** in the read model, built from platform registrations and delivery history. The directory's data source is a design item for the plan.

### 11. Final-mile agent proves delivery

> The consignee portion is probably better done by the final delivery agent. This is how it's done with the current logistics companies. Final-mile delivery by DPD or DHL etc. uses the delivery driver to scan and provide delivery photos of the shipment, to prove it's been delivered.

**Today:**
- `confirm_delivery` can be called by the consignee or a registered attestor (HLD §4, rule 3).
- The final-mile driver is the carrier on the last leg. HLD §6.7 says no payee can release money to themselves, so the driver can't confirm delivery on their own leg's escrow.

**Response (contract decision, ADR needed):**
- Make **driver proof of delivery** the normal path:
  - the driver scans each package at the door and takes photos;
  - optionally, a **consignee delivery code or signature** is captured;
  - that evidence hash confirms delivery on the shipper ↔ forwarder escrow, where the driver isn't the payee.
- The consignee keeps the right to dispute within a window.

**Decision:** driver proof of delivery with photos, plus an optional one-time delivery code. [ADR 0006](../adr/0006-final-mile-proof-of-delivery.md) (Proposed) covers:
- **which escrow each confirmation settles;**
- **how the driver's wallet becomes an attestor,** because the agent is often chosen after booking, when the attestor list is already fixed.

### 12. Simplified consignee timeline

> The consignee should be provided with a simplified timeline of where their goods are.

**Response:** a phone-first **consignee tracking screen** (also reachable from a link, as parcel tracking is today):
- stage-level status only (booked, departed, arrived in country, out for delivery, delivered), with an estimated date;
- the delivery proof once delivered;
- a "Report a problem" path.

No prices, legs or parties beyond what the consignee needs (privacy standard).

### 13. Bulk shipping, then final-mile per order

> The shipper could possibly bulk ship a load of orders to the destination country, and then have the individual orders passed on to a final-mile delivery agent to actually deliver the individual orders. How would this be managed?

**Today:** not covered. One escrow covers one shipment to one consignee.

**Proposed direction (contract decision, ADR needed):** consolidation and deconsolidation:
- **Master shipment:** the bulk move to a destination hub. It's one escrow, and its manifest lists the orders and their packages.
- **Deconsolidation** at the hub is a scan-in: custody evidence only, as in any scan, with no payout. What confirms the master's delivery, and who confirms it, is a separate decision for [ADR 0007](../adr/0007-consolidated-shipments.md).
- Each order then becomes a **child shipment** with its own consignee, escrow (or a leg), labels and final-mile proof (item 11).
- **Per-order labels** are printed at origin, so the hub scan maps packages to orders without relabelling.

**Questions for the plan:**
- Does the shipper fund each child at booking (simple, but locks more funds) or at the hub?
- Is the final-mile agent contracted by the shipper or by the forwarder?
- How does a missing order in the master affect the master's payout?

### 14. How forwarders and carriers sign up

> How do forwarders and carriers sign up to be listed on GajuFreight? (Raised while reviewing the plan.)

**Today:** not covered. The `Platform` registers quotes, not companies, and a quote invites bare addresses. The forwarder picker (item 10) needs a directory to search, and an escrow names individual attestor addresses although a company has many staff.

**Response ([ADR 0009](../adr/0009-organisations-and-directory.md)):**
- **Organisations live off-chain, in the app.** A company signs up with a wallet signature and fills in its profile and documents.
- **The admin team verifies each company.** Only verified companies appear in directory search; an unverified one can still be invited directly, and is marked as unverified.
- **Members join with their own wallets** as owner, staff or handler.
- **At booking,** the escrow's attestor list is filled from the attesting company's handlers. An organisation-level attestor contract is [HLD §7 Q15](../hld.md#7-open-questions).

## Decisions and next step

**Decisions (2026-10-03):**
- **Item 7:** feedback goes to GitHub Issues.
- **Item 8:** sign-in lasts a shift, and the device unlock reopens it.
- **Item 11:** the driver proves delivery with photos, plus an optional consignee code.
- **Item 13:** decided by a spike.

Wireframe round 5 builds the screens. The contract changes in ADR 0006 need that ADR accepted and their own plan ([AGENTS.md](../../AGENTS.md#plan-first-then-build)).
