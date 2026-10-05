# Implementation Blueprint: to MVP and full operating capacity

| | |
| :--- | :--- |
| **Status** | Proposed (2026-10-05): awaiting the project owner's approval ([#39](https://github.com/shanepreater/gajufreight/issues/39)) |
| **Last reviewed** | 2026-10-05 |
| **Related** | [Design audit](design-audit.md) · [Dev approach §3](dev-approach.md#3-delivery-phases) · [HLD](hld.md) · [Architecture](architecture-blueprint.md) · [GitHub issues](https://github.com/shanepreater/gajufreight/issues) |

This is the plan from the end of design to a product running on Groot mainnet, and then to full operating capacity. It follows the [design audit](design-audit.md). Every task is a GitHub issue with its goal, acceptance criteria, dependencies and owning skill. The tables below list them by milestone, and the issues are the live record.

## 1. Definitions

| | MVP: mainnet pilot | FOC: full operating capacity |
| :--- | :--- | :--- |
| **Who** | Invited pilot companies: B2B shippers, forwarders, leg carriers, attestors (ports, customs), arbiters, with B2B consignees who have a wallet ([Q16](hld.md#7-open-questions)) | Any verified company, including door-to-door consignees with no wallet |
| **What** | Negotiate (price, schedule and dispute terms), book and fund in one signature, labels and custody scans, milestone payouts, final-mile proof of delivery, disputes with the panel fallback, refunds, payee release, legs with fee bonds, organisations with a manual verification queue, shift sessions, notifications by email and in-app | Plus: org account contract ([Q15](hld.md#7-open-questions)), consolidated shipments ([Q14](hld.md#7-open-questions)), M-of-N delivery attestation, external feeds, KYB, arbiter compensation, delivery-record reputation, the safer GRIDS call request |
| **Where** | Groot mainnet, after an external audit, with a voted `max_price` cap | Groot mainnet with the cap lifted; an Associate Chain stays optional (phase 6) |
| **How well** | SLIs measured, SLO targets agreed, symptom alerts with runbooks, business-hours on-call, backups restore-tested | SLOs enforced with error budgets, 24×7 on-call, DR exercised, highly available nodes |
| **Done when** | Pilot shipments settle on mainnet with only wallet signatures, and the read model rebuilds from chain and evidence store | Self-serve sign-up to settlement at the agreed scale, inside the error budget |

**Not in either:** a dedicated freight AC, multi-currency or stablecoin pricing, staked attestors, and fiat billing ([HLD §2](hld.md#2-scope)).

## 2. Milestones and gates

Each milestone is a GitHub milestone. A gate is passed only when every issue in it is closed, or explicitly moved by the architect.

| Milestone | Dev-approach phases | Gate (exit) |
| :--- | :--- | :--- |
| **M0 Design closed** | 0 | The audit's decisions are made (ADRs 0006 and 0011–0013, Q15, Q16), spikes E9, E9b, E12 and E13 have run, and the threat model and the hosting, observability, UI and contract-toolchain ADRs are accepted. **No implementation starts before this**, except the exemptions noted in M0 |
| **M1 Testnet alpha** | 1, 2, 3 | A scripted shipment books, funds, scans, delivers and pays out on Groot testnet through the API and GRIDS relay using only wallet-style signatures, and the read model rebuilds from the chain and evidence store |
| **M2 MVP mainnet pilot** | 4, 5 (pre-mainnet) | Pilot users complete shipments on testnet, the security review and external audit have no open critical or high findings, legal sign-off is done, SLOs and runbooks are live, then contracts are on mainnet with the pilot cap |
| **M3 FOC** | 5 (rest), optional 6 | The FOC column above |

M0 may run alongside work that a decision can't change: spikes, the contracts workspace (C1, once D12 is accepted) and the local stack (I1).

## 3. Critical path and lanes

```
 M0  D1 D2 ─► C2 interface spec ─► C3 Platform ─► C4 Quote ─► C5–C8 Escrow ─► C9 diff tests ─► H2 audit ─┐
     D12 ──► C1 toolchain ─┘                                     └─► C11 deploy ─► T1 M1 exit ─┐        │
     S1 S2 S4 ─► D3 ─► B1 B2 ─► B3 relay ─► B8 B10 B11 ────────────────────────────┘          │        │
     D4 ─────► B6 evidence ─┘                                                                 ▼        ▼
     D9 ─────► I1 I3 ───────────────────────────────────────────────────────────► F1–F12 ─► H3 pilot ─► H4 mainnet
     D8 threat model ──────────────────────────────────────────────────────────────────► H1 review ─┘
```

The longest chain is decisions → interface spec → contracts → external audit → mainnet. The audit lead time is the single largest schedule risk, so book the auditor as soon as C2 is stable.

**Lanes** fit the limit of 5 open PRs ([AGENTS.md](../AGENTS.md#git-workflow)):

1. **Contracts:** `sophia-contracts` + `sdet`. C-series, one PR per contract, stacked.
2. **Services:** `backend-services`. B-series, in dependency order.
3. **Platform:** `infra` + `sre`. I-, C11, R-series.
4. **Experience:** `ux-designer` then `ui-typescript`. U-series in M0, F-series in M2.
5. Spare for docs and decisions.

## 4. Interfaces first

Before any layer is built, C2 fixes the contract interface: entrypoints, event shapes (HLD §5 as hardened by the audit), and error codes. That spec is the single source for `packages/chain-types` (F2), the indexer's projections (B4), the API's error map (B7), and the demo model (C10). An interface change updates every affected layer in the same PR, or in stacked PRs the architect has approved.

## 5. Work breakdown

The skills named in each issue are the ones to load. The audit IDs (F1…) are the [design audit](design-audit.md#findings) findings.

### M0 Design closed

| ID | Issue | Task | Skills | Depends on |
| :-- | :-- | :--- | :--- | :--- |
| D0 | [#39](https://github.com/shanepreater/gajufreight/issues/39) | Approve the implementation blueprint (MVP and FOC scope) | `solutions-architect` | — |
| D1 | [#40](https://github.com/shanepreater/gajufreight/issues/40) | Decide ADR 0011: agreed booking terms, booking via Platform, payee release | `solutions-architect`, `sophia-contracts` | D0 |
| D2 | [#41](https://github.com/shanepreater/gajufreight/issues/41) | Decide ADR 0006 (final-mile proof of delivery) and attestor revocation | `solutions-architect`, `security-consultant` | D0 |
| D4 | [#42](https://github.com/shanepreater/gajufreight/issues/42) | Decide ADR 0013: read model, operational store, private evidence store | `solutions-architect`, `security-consultant` | D0 |
| D5 | [#43](https://github.com/shanepreater/gajufreight/issues/43) | Decide company on-chain identity for the MVP (HLD Q15) | `solutions-architect`, `ux-designer` | D0 |
| D6 | [#44](https://github.com/shanepreater/gajufreight/issues/44) | Decide whether MVP consignees must have a wallet (HLD Q16) | `solutions-architect`, `ux-designer` | D0 |
| D7 | [#45](https://github.com/shanepreater/gajufreight/issues/45) | Legal and business decisions before build and mainnet | `solutions-architect` | D0 |
| D8 | [#46](https://github.com/shanepreater/gajufreight/issues/46) | Threat model (STRIDE) for contracts, API, relay, stores and keys | `security-consultant`, `solutions-architect` | D1, D4 |
| D9 | [#47](https://github.com/shanepreater/gajufreight/issues/47) | ADR: hosting, environments, secret store and Groot node | `infra`, `solutions-architect` | D0 |
| D10 | [#48](https://github.com/shanepreater/gajufreight/issues/48) | ADR: observability backend | `sre`, `solutions-architect` | D9 |
| D11 | [#49](https://github.com/shanepreater/gajufreight/issues/49) | ADR: dashboard and field app framework | `ui-typescript`, `ux-designer` | D0 |
| D12 | [#50](https://github.com/shanepreater/gajufreight/issues/50) | ADR: contract toolchain and test harness | `sophia-contracts`, `sdet`, `infra` | D0 |
| S1 | [#51](https://github.com/shanepreater/gajufreight/issues/51) | Spike E9: GRIDS dead-drop contract call (and create) end to end | `backend-services`, `infra` | D0 |
| S2 | [#52](https://github.com/shanepreater/gajufreight/issues/52) | Spike E9b: GajuMobile deep links and offline signing | `ui-typescript`, `ux-designer` | S1 |
| S3 | [#53](https://github.com/shanepreater/gajufreight/issues/53) | Probes E12 and E13: zero spends, is_payable, finality depth | `sophia-contracts` | D0 |
| S4 | [#54](https://github.com/shanepreater/gajufreight/issues/54) | Spike: tx-builder prototype (build call, dry run, FATE hash, decode events) | `backend-services` | D0 |
| D3 | [#55](https://github.com/shanepreater/gajufreight/issues/55) | Decide ADR 0012: tx-builder sidecar and GRIDS relay | `solutions-architect`, `backend-services` | S1, S2, S4 |
| Q1 | [#56](https://github.com/shanepreater/gajufreight/issues/56) | Send the consolidated QPQ follow-ups | `solutions-architect` | — |
| U1 | [#57](https://github.com/shanepreater/gajufreight/issues/57) | UX: negotiate dispute and attestor terms with the price | `ux-designer` | D1 |
| U2 | [#58](https://github.com/shanepreater/gajufreight/issues/58) | UX: signing, nonce and offline flows per ADR 0012 | `ux-designer` | S1, S2 |
| U3 | [#59](https://github.com/shanepreater/gajufreight/issues/59) | UX: notifications and deadline reminders | `ux-designer` | D0 |
| U4 | [#60](https://github.com/shanepreater/gajufreight/issues/60) | UX: apply the company-wallet and consignee decisions | `ux-designer` | D5, D6 |

### M1 Testnet alpha

| ID | Issue | Task | Skills | Depends on |
| :-- | :-- | :--- | :--- | :--- |
| C1 | [#61](https://github.com/shanepreater/gajufreight/issues/61) | Contracts workspace: build, PLATFORM_ADDRESS substitution, CI compile | `sophia-contracts`, `infra` | D12 |
| C2 | [#62](https://github.com/shanepreater/gajufreight/issues/62) | Contract interface spec: entrypoints, events, error codes | `solutions-architect`, `sophia-contracts` | D1, D2 |
| C3 | [#63](https://github.com/shanepreater/gajufreight/issues/63) | Platform contract: settings, admin quorum, registry, booking clones | `sophia-contracts`, `sdet` | C1, C2 |
| C4 | [#64](https://github.com/shanepreater/gajufreight/issues/64) | QuoteRequest contract | `sophia-contracts`, `sdet` | C3 |
| C5 | [#65](https://github.com/shanepreater/gajufreight/issues/65) | ShipmentEscrow: booking, milestones, delivery, refund, payee release | `sophia-contracts`, `sdet` | C4 |
| C6 | [#66](https://github.com/shanepreater/gajufreight/issues/66) | ShipmentEscrow: disputes, votes and panel fallback | `sophia-contracts`, `sdet` | C5 |
| C7 | [#67](https://github.com/shanepreater/gajufreight/issues/67) | Platform fee, leg bonds and leg budget | `sophia-contracts`, `sdet` | C6 |
| C8 | [#68](https://github.com/shanepreater/gajufreight/issues/68) | Final-mile proof of delivery contract changes (ADR 0006) | `sophia-contracts`, `sdet` | C7, D2 |
| C9 | [#70](https://github.com/shanepreater/gajufreight/issues/70) | Differential and property tests: contracts vs demo model | `sdet`, `sophia-contracts` | C8, C10 |
| C10 | [#69](https://github.com/shanepreater/gajufreight/issues/69) | Align the demo model with the final contracts | `sophia-contracts` | C2 |
| C11 | [#71](https://github.com/shanepreater/gajufreight/issues/71) | Scripted deploy with manifest; first testnet deployment | `infra`, `sophia-contracts` | C8, D9 |
| I1 | [#72](https://github.com/shanepreater/gajufreight/issues/72) | Local stack with one command | `infra` | D9, D12 |
| I2 | [#73](https://github.com/shanepreater/gajufreight/issues/73) | CI: contract tests and service integration against the local chain | `infra`, `sdet` | I1, C1 |
| I3 | [#74](https://github.com/shanepreater/gajufreight/issues/74) | Testnet environment: hosting, TLS dead-drop host, secrets, node | `infra` | D9 |
| B1 | [#75](https://github.com/shanepreater/gajufreight/issues/75) | Python chain client package: node HTTP, events, finality | `backend-services` | D3 |
| B2 | [#76](https://github.com/shanepreater/gajufreight/issues/76) | Tx-builder service (ADR 0012) | `backend-services` | D3, C2 |
| B3 | [#77](https://github.com/shanepreater/gajufreight/issues/77) | GRIDS relay and nonce manager | `backend-services`, `security-consultant` | B1, B2 |
| B4 | [#78](https://github.com/shanepreater/gajufreight/issues/78) | Indexer: microblock watcher, discovery, projections, reorgs | `backend-services`, `sdet` | B1, C2 |
| B5 | [#79](https://github.com/shanepreater/gajufreight/issues/79) | Read model schema and query API with role filters | `backend-services` | B4 |
| B6 | [#80](https://github.com/shanepreater/gajufreight/issues/80) | Evidence store and ingest (ADR 0013) | `backend-services`, `security-consultant` | D4 |
| B7 | [#81](https://github.com/shanepreater/gajufreight/issues/81) | Authorisation layer: role x status for every endpoint | `backend-services`, `security-consultant`, `sdet` | B5 |
| B8 | [#82](https://github.com/shanepreater/gajufreight/issues/82) | Sessions: wallet sign-in, WebAuthn and PIN (ADR 0008) | `backend-services`, `security-consultant` | B3 |
| B9 | [#83](https://github.com/shanepreater/gajufreight/issues/83) | Organisations, members, directory and verification (ADR 0009) | `backend-services` | B8, D5, D7 |
| B10 | [#84](https://github.com/shanepreater/gajufreight/issues/84) | Negotiation and booking endpoints | `backend-services` | B3, B6, B7, C4 |
| B11 | [#85](https://github.com/shanepreater/gajufreight/issues/85) | Execution endpoints: custody, delivery code, disputes, refunds, bonds | `backend-services` | B10, C8 |
| B12 | [#86](https://github.com/shanepreater/gajufreight/issues/86) | Notifications service | `backend-services` | B5, U3 |
| B13 | [#87](https://github.com/shanepreater/gajufreight/issues/87) | Feedback front door: POST /feedback to GitHub issues | `backend-services` | B7 |
| T1 | [#88](https://github.com/shanepreater/gajufreight/issues/88) | End-to-end harness and the M1 exit run on testnet | `sdet` | B11, C11, I3 |

### M2 MVP mainnet pilot

| ID | Issue | Task | Skills | Depends on |
| :-- | :-- | :--- | :--- | :--- |
| F1 | [#89](https://github.com/shanepreater/gajufreight/issues/89) | Dashboard scaffold: app shell, footer, help, feedback | `ui-typescript` | D11 |
| F2 | [#90](https://github.com/shanepreater/gajufreight/issues/90) | packages/chain-types and validated API client | `ui-typescript` | C2, B5 |
| F3 | [#91](https://github.com/shanepreater/gajufreight/issues/91) | Sign modal: GRIDS QR, deep link, pending to final | `ui-typescript`, `security-consultant` | F1, B3 |
| F4 | [#92](https://github.com/shanepreater/gajufreight/issues/92) | Sign-in and sessions screens | `ui-typescript` | F3, B8 |
| F5 | [#93](https://github.com/shanepreater/gajufreight/issues/93) | Quote request, negotiation and forwarder inbox | `ui-typescript` | F3, B10, U1 |
| F6 | [#94](https://github.com/shanepreater/gajufreight/issues/94) | Book shipment and print labels | `ui-typescript` | F5 |
| F7 | [#95](https://github.com/shanepreater/gajufreight/issues/95) | My shipments, Needs your action, shipment detail | `ui-typescript` | F3, B5, B12 |
| F8 | [#96](https://github.com/shanepreater/gajufreight/issues/96) | Field app: scan session, proof of delivery, offline queue | `ui-typescript` | F4, B11, U2 |
| F9 | [#97](https://github.com/shanepreater/gajufreight/issues/97) | Legs board, leg offer, bonds and cash flow | `ui-typescript` | F5, F7 |
| F10 | [#98](https://github.com/shanepreater/gajufreight/issues/98) | Disputes, refunds and consignee tracking | `ui-typescript` | F7, B11 |
| F11 | [#99](https://github.com/shanepreater/gajufreight/issues/99) | Join, organisation, directory and admin settings | `ui-typescript` | F4, B9, U4 |
| F12 | [#100](https://github.com/shanepreater/gajufreight/issues/100) | Playwright journeys, accessibility and wireframe conformance | `sdet`, `ui-typescript` | F6, F8, F9, F10, F11 |
| R1 | [#101](https://github.com/shanepreater/gajufreight/issues/101) | Telemetry: traces, metrics, structured logs with correlation ids | `sre`, `backend-services` | D10, B3 |
| R2 | [#102](https://github.com/shanepreater/gajufreight/issues/102) | SLIs, SLOs as code and dashboards | `sre` | R1 |
| R3 | [#103](https://github.com/shanepreater/gajufreight/issues/103) | Alerts and runbooks | `sre`, `security-consultant` | R2 |
| R4 | [#104](https://github.com/shanepreater/gajufreight/issues/104) | Key custody, admin recovery and incident process | `sre`, `security-consultant`, `infra` | C11 |
| R5 | [#105](https://github.com/shanepreater/gajufreight/issues/105) | Load, rebuild and restore tests | `sre`, `sdet` | T1, R1 |
| H1 | [#106](https://github.com/shanepreater/gajufreight/issues/106) | Internal security review against the threat model | `security-consultant` | D8, T1 |
| H2 | [#107](https://github.com/shanepreater/gajufreight/issues/107) | External contract audit before mainnet | `security-consultant`, `sophia-contracts` | C9 |
| H3 | [#108](https://github.com/shanepreater/gajufreight/issues/108) | Pilot with real users on testnet (phase 4 exit) | `ux-designer`, `solutions-architect` | F12, R3 |
| H4 | [#109](https://github.com/shanepreater/gajufreight/issues/109) | Mainnet deployment on Groot with the pilot cap | `infra`, `solutions-architect` | H1, H2, H3, R4, D7 |

### M3 Full operating capacity

| ID | Issue | Task | Skills | Depends on |
| :-- | :-- | :--- | :--- | :--- |
| X1 | [#110](https://github.com/shanepreater/gajufreight/issues/110) | Organisation account contract (HLD Q15) | `sophia-contracts`, `solutions-architect` | H4 |
| X2 | [#111](https://github.com/shanepreater/gajufreight/issues/111) | Consolidated shipments (ADR 0007, HLD Q14) | `solutions-architect`, `sophia-contracts`, `ux-designer` | H4 |
| X3 | [#112](https://github.com/shanepreater/gajufreight/issues/112) | Walletless consignees and door-to-door delivery (HLD Q16) | `solutions-architect`, `ux-designer` | H4 |
| X4 | [#113](https://github.com/shanepreater/gajufreight/issues/113) | M-of-N attestation for delivery (HLD §6.3) | `sophia-contracts` | H4 |
| X5 | [#114](https://github.com/shanepreater/gajufreight/issues/114) | First external feed integration via signed webhooks | `backend-services`, `security-consultant` | H4 |
| X6 | [#115](https://github.com/shanepreater/gajufreight/issues/115) | KYB provider integration | `backend-services` | D7, H4 |
| X7 | [#116](https://github.com/shanepreater/gajufreight/issues/116) | Arbiter onboarding and compensation | `solutions-architect`, `ux-designer` | H4 |
| X8 | [#117](https://github.com/shanepreater/gajufreight/issues/117) | Directory delivery record and reputation | `backend-services`, `ui-typescript` | H4 |
| X9 | [#118](https://github.com/shanepreater/gajufreight/issues/118) | Adopt the safer GRIDS call request | `backend-services`, `ui-typescript` | H4 |
| X10 | [#119](https://github.com/shanepreater/gajufreight/issues/119) | Production operations at FOC: on-call, DR, HA nodes, lift pilot cap | `sre`, `infra` | H4, R5 |

## 6. Risks

| Risk | Impact | Mitigation | Watch in |
| :--- | :--- | :--- | :--- |
| The GRIDS dead drop or GajuMobile don't behave as the GajuDesk source suggests | Signing path redesign; field journeys blocked | S1 and S2 first in M0; QPQ follow-ups (Q1) | [#51](https://github.com/shanepreater/gajufreight/issues/51) [#52](https://github.com/shanepreater/gajufreight/issues/52) |
| No SDK: the tx-builder becomes a long-lived Erlang dependency | An extra runtime to operate | Keep its API tiny; replace it when QPQ's utility node plugin ships | [#54](https://github.com/shanepreater/gajufreight/issues/54) [#118](https://github.com/shanepreater/gajufreight/issues/118) |
| External audit lead time | Mainnet slips | Book the auditor when C2 is stable; differential tests (C9) reduce findings | [#107](https://github.com/shanepreater/gajufreight/issues/107) |
| Testnet has one miner and slow inclusion | Slow, flaky integration tests | Local chain for CI; testnet only for the exit runs | [#72](https://github.com/shanepreater/gajufreight/issues/72) [#88](https://github.com/shanepreater/gajufreight/issues/88) |
| Gaju price volatility against fiat freight costs | Forwarders reluctant to quote in Gaju | Pilot with willing partners; stablecoin stays out of scope until FOC is reviewed | [#108](https://github.com/shanepreater/gajufreight/issues/108) |
| The fee on escrowed funds turns out to be regulated | Business model change | Legal advice before mainnet | [#45](https://github.com/shanepreater/gajufreight/issues/45) |
| Admin or deployer key compromise | Settings changed, malicious deploy | Admin quorum, GRIDS-signed deploys, recovery runbook, `bookings_open` switch | [#104](https://github.com/shanepreater/gajufreight/issues/104) [#46](https://github.com/shanepreater/gajufreight/issues/46) |
| Contract bug found after mainnet | Funds at risk in live escrows | Pilot cap, external audit, stop new bookings, no upgrades to live escrows | [#107](https://github.com/shanepreater/gajufreight/issues/107) [#103](https://github.com/shanepreater/gajufreight/issues/103) |

## 7. Keeping this current

The architect updates this blueprint when scope changes. New work is filed as an issue in the right milestone, with a `Blueprint:` ID in its body, and added to the tables above in the same PR as the change that needs it.
