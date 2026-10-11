# ADR 0020: Extra charges, event milestones and Incoterms

| | |
| :--- | :--- |
| **Status** | Accepted (2026-10-11, [decision log](../decision-log.md) #31) |
| **Last reviewed** | 2026-10-11 |
| **Related** | [Forwarder gap analysis](../forwarder-gap-analysis.md) · [HLD §4](../hld.md#4-shipment-lifecycle) · [HLD §6.8](../hld.md#68-privacy-standard) · [ADR 0015](0015-forwarder-led-quoting.md) · [ADR 0018](0018-confirmation-bond.md) |

## Context

Forwarder feedback found three gaps in the contracts. Each is cheap to close before the external audit and expensive once contracts are live on mainnet:
- **Charges after booking.** Demurrage and detention, waiting time, re-delivery and duties paid on the shipper's behalf are billed on most ocean jobs, often after delivery. The escrow holds one fixed price, so these would be settled off the platform.
- **Milestones that aren't places.** "Customs cleared" and "on board the vessel" are events, but a milestone paid only on a scan-in at a place.
- **Incoterms.** The core commercial term for who bears cost and risk where was missing from the consignment.

## Decision

1. **Extra charges.**
   - The payee proposes a charge with `propose_charge(kind, amount, evidence)`. `kind` is one of `Demurrage`, `Detention`, `Waiting`, `Redelivery`, `Duty` or `Other`, and `evidence` is the hash of its evidence bundle (hard rule 4).
   - Charges are allowed once the booking is confirmed, terminal statuses included, because port storage is often billed after delivery.
   - The payer either accepts with `accept_charge(id)`, attaching exactly the amount, or declines with `decline_charge(id)`.
   - An accepted charge passes straight to the payee in the same call, with **no platform fee** (they are mostly pass-through costs).
   - A declined charge stays on record and is settled off-chain. The panel doesn't arbitrate extras.
   - At most 20 charges per escrow, so the record stays bounded.
   - Charges never touch the price, the held bond or the dispute and refund maths.
2. **Event milestones.** A milestone label containing a colon is an attested event, for example `CUSTOMS:NLRTM` or `ONBOARD:CNYTN`. An attestor's `Milestone` checkpoint with that label pays it, in schedule order. Any other label is a place, paid only by an attestor's scan-in, as before. The payee still can't attest its own milestone.
3. **Incoterms.** The consignment carries `incoterm`, one of the 11 Incoterms 2020 rules (`EXW`, `FCA`, `CPT`, `CIP`, `DAP`, `DPU`, `DDP`, `FAS`, `FOB`, `CFR`, `CIF`). Anything else fails with `BAD_CONSIGNMENT`.

## Consequences

- **Good:** routine extras settle on the platform with evidence and a public record. Customs and on-board milestones pay like scans do. Both sides price against a stated Incoterm.
- **Conservation:** an accepted charge leaves in the same call it arrives, so the escrow's own funds are unchanged (AGENTS.md contract invariants).
- **Visible on-chain (HLD §6.8):** each charge's kind, amount, evidence hash and outcome, and each consignment's Incoterm.
- **Costs:** two signatures per accepted or declined charge, about 0.0002 Gaju each.
- **Risks:** a payee could propose unfounded charges, but the payer must accept each one and the cap bounds the spam. Event labels are a convention, not checked on-chain; the attestors are trusted per shipment, which bounds that risk (threat model T31, T32).
- **Not decided here:** panel arbitration of declined charges (it would need the disputed amount deposited), platform fees on extras, and charges proposed by attestors or third parties.
