# Forwarder gap analysis

| | |
| :--- | :--- |
| **Status** | Analysis (2026-10-11): forwarder feedback, and what GajuFreight covers, adds or declines. Roadmap changes are in the [implementation blueprint](implementation-blueprint.md) and decision log #29 and #30 |
| **Last reviewed** | 2026-10-11 |
| **Related** | [Implementation blueprint](implementation-blueprint.md) · [HLD §2](hld.md#2-scope) · ADR 0020 and ADR 0021 (planned) · [Decision log](decision-log.md) #29, #30 |

## 1. The feedback: what freight forwarders use today, and what GajuFreight would have to offer to move them

Supplied by the project owner from conversations with freight forwarders (2026-10).

To fully replace traditional logistics systems (Freight Management Systems/TMS, digital booking portals like Freightos, and customs brokerage platforms), GajuFreight must cover four core operational pillars: **Rate & Procurement**, **Execution & Documentation**, **Financial Settlement**, and **Tracking/Visibility**.

---

### Core features required (full replacement)

#### 1. Rate Engine & Quotation (Commercial)

* **Spot & Contract Rate Management:** Database for multi-modal (ocean, air, road) carrier tariffs, bunker adjustment factors (BAF), peak season surcharges (PSS), and local accessorials.
* **Automated Instant Quoting Engine:** Instant margin calculation and customer-facing rate quotes based on volume, weight, and origin/destination (OD) matrix.
* **Carrier Capacity Booking & Allocation:** API or portal integration into ocean lines and airlines to reserve space directly.

#### 2. Freight Execution & Document Management (Operational)

* **Digital Transport Documentation:** Native generation and cryptographic signing of Bills of Lading (Master BL & House BL), Air Waybills (AWB), Commercial Invoices, and Packing Lists.
* **Customs Clearance & Regulatory Data Hub:** Structured data capture for Automated Manifest System (AMS), Importer Security Filing (ISF), and local customs declaration data models.
* **Multi-Leg Logistics Orchestration:** Workflow management for drayage/cartage pickup, port origin handling, main-leg transit, and final-mile delivery.

#### 3. Smart Contract Settlement & Billing (Financial)

* **Gaju Escrow & Automated Disbursement:** Lock booking funds in Gaju token escrow upon booking confirmation; disburse incrementally upon verified milestones (e.g., Gate-In at Origin, Onboard Vessel, Customs Cleared, Proof of Delivery).
* **Demurrage & Detention Auto-Settlement:** Programmatic calculation and payout for port storage and container delay charges based on real-time port telemetry.
* **Multi-Currency Invoicing & Pass-Through:** Invoicing in fiat or Gaju with on-chain conversion and audit trails for pass-through line items (duty, taxes, terminal handling).

#### 4. Real-Time Tracking, Visibility & Proof of Delivery (Post-Booking)

* **Immutable Milestone Telemetry:** On-chain ledger logging for container milestones (GPS/AIS tracking, IoT sensor data for cold chain reefer temperature/humidity).
* **Cryptographic Proof of Delivery (e-PoD):** Mobile app or digital portal allowing consignees to sign for cargo release, triggering smart contract release of funds.
* **Dispute & Exception Handling Workflow:** Protocol for logging cargo damage or shortages on-chain with attached photo evidence to initiate insurance claims or hold escrowed funds.

---

### Suggested roadmap and priority order

The most effective strategy is to start where **Gaju and the Gajumaru network provide an immediate, order-of-magnitude advantage** (on-chain settlement, instant escrow, and tamper-proof milestone verification) before building out complex legacy back-office tools.

#### Phase 1: Core Financial & Booking MVP (High Impact / Immediate ROI)

*Focus: Deliver an immediate cost-saving alternative to traditional booking portals by enabling instant booking and zero-fee settlement.*

1. **Gaju Escrow & Settlement Engine:** Native smart contract flow for locking, holding, and releasing milestone-based payments in Gaju.
2. **Simplified Rate Engine & Quoting:** Basic margin management allowing forwarders to upload matrix rates and output instant quotes.
3. **Digital Bill of Lading (e-BL) Minting:** On-chain, immutable ownership title transfer for cargo to eliminate paper Bill of Lading delays.

#### Phase 2: Visibility & Execution Capabilities (Market Parity)

*Focus: Provide the operational visibility necessary to replace legacy TMS tracking modules.*
4. **Milestone Tracking & Event Ledger:** On-chain logging of key status changes (Gate-In, Departure, Arrival, Gate-Out) with e-PoD capabilities.
5. **Carrier API Integration Framework:** Direct links to ocean/air carrier APIs to pull vessel schedules and push automated bookings.
6. **Automated Invoice & Fee Reconciliation:** Automatic generation of 1% platform fee deductions in Gaju alongside pass-through freight billing.

#### Phase 3: Advanced Operations & Ecosystem Scale (Full System Replacement)

*Focus: Replace specialized enterprise systems (Customs Brokerage software & IoT cold-chain tools).*
7. **Customs & Regulatory Documentation Hub:** Structured filing workflows for global customs entries.
8. **IoT Sensor & Exception Engine:** Direct ingestion of IoT telemetry (e.g., temperature/tamper alerts) to trigger automated insurance claims or penalty clauses in smart contracts.
9. **Multi-Tenant Forwarder Portal & Analytics:** Full enterprise dashboard for forwarders to manage sub-agents, customer credit limits, and yield management.

## 2. Analysis

### What GajuFreight already covers

The feedback's "Phase 1 core" is the MVP: milestone escrow and payouts ([HLD §4](hld.md#4-shipment-lifecycle)), proof of delivery ([ADR 0006](adr/0006-final-mile-proof-of-delivery.md)), disputes with photo evidence and an arbiter panel ([ADR 0002](adr/0002-arbiter-panel.md)), and multi-leg subcontracting with leg escrows ([ADR 0004](adr/0004-staged-contracts.md)). Prices are agreed through forwarder-led quotes ([ADR 0015](adr/0015-forwarder-led-quoting.md)), and the forwarder confirms each booking ([ADR 0018](adr/0018-confirmation-bond.md)).

### Gaps that change the contracts (ADR 0020, before the audit)

| Gap | Why it matters | Planned answer |
| :--- | :--- | :--- |
| **Charges after booking**: demurrage and detention, waiting time, re-delivery, duties paid on the shipper's behalf | The escrow holds one fixed price, so routine extras would be settled off the platform | The forwarder proposes a charge with evidence; the shipper accepts and pays it straight to the forwarder, or declines and it's settled off-chain. No platform fee on extras |
| **Milestones that aren't places**: customs cleared, on board | Milestones pay only on a scan-in at a place | An attestor's milestone checkpoint can pay a milestone labelled for an event, for example `CUSTOMS:NLRTM` |
| **Incoterms** | The core term for who bears cost and risk, missing from the consignment | An Incoterm on the consignment, checked against the 11 Incoterms 2020 codes |

### Commercial points to test in the pilot (decision log #29)

- **Pricing in Gaju.** QPQ intend the Gaju to be a stable currency, at parity with the Swiss franc (about 1 Gaju to £1 or 1 CHF) and then rising slowly to about 10 CHF over the following decade ([QPQ Q&A](qpq-q-and-a.md#gaju-value)). The pilot checks how forwarders want to quote long-running contract rates in Gaju.
- **Credit terms.** Shippers are used to paying 30–60 days after delivery; the escrow is funded at booking. That protects forwarders and costs shippers cash. Financing could follow.
- **"Zero-fee settlement".** The feedback assumes no fee; GajuFreight charges 1%, paid by the forwarder on confirming ([ADR 0018](adr/0018-confirmation-bond.md)).

### Added to the roadmap after the pilot (app features)

Rate cards and automatic quoting; document generation (packing list, commercial invoice, sea waybill) with hashes as evidence; live vessel tracking as a display-only feed; an evidence pack for insurance claims; an outbound API and webhooks for forwarders' own systems; forwarder analytics. VAT invoices and accounting exports come before mainnet, with the legal and business positions ([#45](https://github.com/shanepreater/gajufreight/issues/45)). See the [implementation blueprint](implementation-blueprint.md#m3-full-operating-capacity).

### Integrating with third parties (ADR 0021, planned)

Booking space with carriers, schedules, tracking feeds and customs filing are integrations with partners, not systems we build. ADR 0021 defines the process (one interface per capability, adapters per provider, signed inbound webhooks, outbound events, and the trust rules), and a code skeleton has placeholders for each capability, so a partner slots in without redesign.

### Declined, or reshaped to fit the design (decision log #30)

| Suggestion | Why not as written | What we do instead |
| :--- | :--- | :--- |
| Tracking telemetry (GPS, vessel position, temperature) on-chain | On-chain data is public and permanent, and checkpoints are milestones, not telemetry (hard rule 4) | Telemetry stays off-chain; only evidence hashes go on-chain |
| Penalties or insurance claims triggered by sensor feeds | External feeds are untrusted and only prompt an attestor (hard rule 5) | A feed prompts an attestor or a dispute; a late-delivery penalty can come from a larger confirmation bond |
| Bills of lading as on-chain title | A negotiable title needs legal recognition (for example, the UK's Electronic Trade Documents Act 2023), approval by the shipping insurers, and the industry's e-BL standards | Out of scope; documents are generated off-chain with hashes as evidence |
| Building customs filing (US manifest and importer security filings) and carrier booking systems | Specialist, regulated systems with established providers | Integrate through ADR 0021 |
