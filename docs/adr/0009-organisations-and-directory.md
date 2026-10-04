# ADR 0009: Organisations, sign-up and the directory

| | |
| :--- | :--- |
| **Status** | Accepted (decided 2026-10-03). Fees, the KYB provider and document retention are still open |
| **Last reviewed** | 2026-10-03 |
| **Related** | [HLD §3](../hld.md#3-actors) · [HLD §6.8](../hld.md#68-privacy-standard) · [ADR 0005](0005-platform-booking-privacy.md) · [ADR 0008](0008-app-sessions.md) · [Round 4 review, items 10 and 14](../ux/review-round-4-feedback.md#14-how-forwarders-and-carriers-sign-up) |

## Context

The design doesn't say how forwarders, carriers, final-mile agents, attestors (ports, customs) and arbiters join GajuFreight:

- The `Platform` registers quotes, not companies, and a quote invites bare addresses.
- A shipper choosing among hundreds of forwarders needs a directory to search.
- A company has many staff, each with their own wallet, but an escrow names individual attestor addresses.

## Decision

- **Organisations live off-chain, in the app** (privacy standard). There's no contract change: the chain stays the source of truth for shipments (hard rule 3), and company records stay private.
- **Self-serve sign-up:**
  - One wallet signature creates the organisation, and that wallet becomes its owner.
  - The profile holds the legal name and company registration, its kinds (forwarder, carrier, final-mile agent, attestor or arbiter), lanes, modes, certifications (for example AEO or a forwarder licence), capacity and support contacts.
  - The company uploads its registration, insurance and licence documents.
- **Verification by the admin team:**
  - The admins review each company against a short checklist. Its status is *Unverified*, *Verified* or *Suspended*, and a rejection always gives a reason.
  - It's an app decision, not an on-chain one: one admin decides, every decision is logged with who made it, and a suspension hides the company from search and new invitations without stopping its current shipments.
  - The queue shows how long each request has waited.
  - Documents are personal data. They're stored off-chain, visible only to the company's owner and the admins, and never hashed on-chain.
- **The directory:**
  - **Only verified companies appear in search.** An unverified company can still be invited directly by link or address, and is marked *Unverified* wherever it appears.
  - Search covers name, lane, mode, certification and capacity. The results show the delivery record: on time, disputes, and how they were resolved, all derived from the read model.
- **Members and roles:**
  - Each member links their own wallet. The roles are **owner** (manages the profile and members), **staff** (quotes, books and funds) and **handler** (scans and attests in the field, and signs in for a shift, [ADR 0008](0008-app-sessions.md)).
  - The owner invites members by link and removes them. Removing a member revokes their sessions at once.
- **On-chain mapping:**
  - At booking, the app fills the escrow's attestor list from the attesting organisation's handler addresses, up to a platform limit.
  - A handler added later can't attest on shipments that are already booked. Their colleagues can, and the app explains why.
  - An **organisation-level attestor contract**, one address that delegates to its current members, would remove that limit. It's recorded as [HLD §7 Q15](../hld.md#7-open-questions).

## Consequences

- **Good:** the forwarder picker has real data, invitations go to verified companies, and teams can use their own wallets without a shared key.
- **Cost:**
  - The API gains organisations, members, documents and a verification queue, and the admin team gains a manual workload.
  - Limiting the attestor list needs a new `Platform` setting (a small contract change, planned separately).
- **Open:**
  - listing fees or subscriptions (a business decision);
  - which KYB provider, if any;
  - how long documents are kept.

  These are decided before the build.
