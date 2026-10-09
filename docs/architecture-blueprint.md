# Architecture Blueprint: GajuFreight

| | |
| :--- | :--- |
| **Status** | Draft |
| **Last reviewed** | 2026-10-05 ([design audit](design-audit.md)) |
| **Related** | [HLD](hld.md) · [Development approach](dev-approach.md) · [Sources](sources.md) |

## 1. Summary

GajuFreight has two halves:

- **On-chain:** Sophia contracts on the FATE VM hold the escrowed Gaju and enforce the shipment lifecycle.
- **Off-chain:** services that bring freight events in, store evidence, index chain state and serve the dashboard.

The off-chain side never holds user keys. Every value-moving action is signed by the user's own Gajumaru wallet through GRIDS.

## 2. System context

```
   Shipper / Consignee / Carrier / Attestor
        │                        │
        │ browser                │ GajuDesk / GajuMobile (keys stay here)
        ▼                        ▼
 ┌───────────────┐   GRIDS QR   ┌──────────────────┐
 │ Web dashboard │ ───────────► │  User's wallet   │
 └──────┬────────┘              └────────┬─────────┘
        │ HTTPS                          │ signed tx
        ▼                                ▼
 ┌─────────────────────────────┐   ┌───────────────────────────────┐
 │ GajuFreight API             │   │ Gajumaru node (Groot or AC)   │
 │  • booking, orgs, sessions  │   │  • Platform, templates        │
 │  • GRIDS relay (dead drop)  │──►│  • QuoteRequest / escrow      │
 │  • evidence ingest + hash   │   │    clones · FATE VM           │
 │  • notifications            │   │                               │
 └──┬──────┬───────────┬───────┘   └──────────────┬────────────────┘
    │      │ internal  │                          │ microblocks (~3 s)
    │      ▼           ▼                          ▼
    │ ┌──────────┐ ┌────────────────────┐  ┌──────────────────┐
    │ │tx-builder│ │ PostgreSQL         │  │ Chain indexer /  │
    │ │(no keys) │ │ read model ◄───────┼──│ event watcher    │
    │ └──────────┘ │ operational store  │  └──────────────────┘
    ▼              └────────────────────┘
 ┌────────────────┐
 │ Evidence store │  private, content-addressed (ADR 0013)
 └────────────────┘
        ▲
        │ signed webhooks
 ┌──────┴──────────────────────┐
 │ External feeds (carrier TMS,│
 │ port systems, IoT trackers) │
 └─────────────────────────────┘
```

## 3. Components

| Component | Responsibility | Notes |
| :--- | :--- | :--- |
| **QuoteRequest contract** | Negotiation stage: the consignment, invited forwarders' quotes, the requester's counters and acceptance. Never holds money | See [HLD §5](hld.md#5-contract-sketch-sophia), [ADR 0004](adr/0004-staged-contracts.md) and [ADR 0015](adr/0015-forwarder-led-quoting.md). One per request, and one per subcontracted leg. |
| **ShipmentEscrow contract** | Execution stage: escrow, milestones and lifecycle, created only from an agreed quote | See [HLD §5](hld.md#5-contract-sketch-sophia). The source of truth for money and status. One per shipment, and one per leg. |
| **Platform contract** | Admin-multisig settings (round limit, panel cap, fee, pilot cap, booking switch), the quote registry, and booking: it clones the quote and escrow templates | One per network; its address is compiled into the templates ([ADR 0005](adr/0005-platform-booking-privacy.md), [ADR 0011](adr/0011-agreed-booking-terms.md)). `Chain.clone` with value is verified on testnet (spike E4) |
| **GajuFreight API** | Booking, building unsigned transactions as GRIDS payloads, evidence ingest | Stateless processes; its state is in the stores. Never signs on behalf of users. |
| **GRIDS relay** | Serves each signing request at a single-use dead-drop URL, receives the signed transaction, checks it against what was built, submits it and tracks it to final | Part of the API; one open request per account; short TTLs ([ADR 0012](adr/0012-transaction-building-and-grids-relay.md), proposed) |
| **Tx-builder** | Builds unsigned calls, dry-runs them for the fee, FATE-encodes and hashes values, decodes events | Internal sidecar on Hakuzaru and the Sophia compiler; no keys, no public port (ADR 0012) |
| **Notifications** | The "Needs your action" queue, email (later SMS) for delivery codes, and reminders before refund deadlines, arbitration and challenge windows | Driven by read-model projections; contact details stay in the operational store |
| **Evidence store** | Evidence bundles, photos, documents, and the preimage of every on-chain hash (job, manifest; agreed terms are on-chain in full) | Private, content-addressed, write-once and backed up; reached only through the API ([ADR 0013](adr/0013-off-chain-data.md)). The hash goes on-chain. |
| **Chain indexer** | Watches microblocks for contract calls and events, and projects them into the read model | Same pattern as GajuPay's microblock watcher. Treat the network's finality rule as final: witness finality where the node offers it (mainnet), otherwise a set depth (HLD §7 Q17). |
| **Read model** | Projections of chain events for search, dashboards and notifications | Can always be rebuilt from the chain plus the evidence store (ADR 0013). |
| **Operational store** | Organisations, members, sessions, verification decisions and audit log, contacts, GRIDS requests | A system of record, not a projection: backed up and restore-tested (ADR 0013). |
| **Web dashboard** | Screens for booking, tracking, dispute and settlement | Shows GRIDS QR codes for any action that needs a signature. |
| **Attestor client** | Lightweight signer for port and customs agents | Can simply be GajuMobile scanning a GRIDS code. |
| **Organisations and directory** | Company sign-up, members and roles, admin verification, directory search | Off-chain, in the API and app database ([ADR 0009](adr/0009-organisations-and-directory.md)). |
| **Sessions** | Wallet-signed sign-in for a shift, reopened by the device unlock | Identify only; actions are still signed in the wallet ([ADR 0008](adr/0008-app-sessions.md)). |
| **Feedback front door** | `POST /feedback` files a GitHub issue on this repo, labelled `triage`, with the screen, app version, network and support reference | The token stays server-side in infra secrets. Addresses and shipment details are attached only if the user opts in. |

## 4. Trust boundaries

1. **The chain is authoritative** for funds and shipment status. The read model is a cache; the operational store holds only what the chain doesn't (ADR 0013).
2. **Wallets are authoritative** for identity. The API has no custodial keys.
3. **Attestors are trusted per shipment.** Their powers are limited to the addresses listed in each contract instance (see [HLD §6.3](hld.md#63-trust-model-for-attestations)).
4. **External feeds are untrusted input.** They can only prompt an attestor to sign. They cannot change on-chain state directly.
5. **The API enforces every rule the UI shows.** Every endpoint authorises the caller by role and shipment status, for reads as well as writes, and the API refuses to build a GRIDS payload for an action the caller can't take. Hiding a control in the UI is never the control; the contract checks again on-chain.

## 5. Technology choices (proposed)

| Layer | Choice | Rationale |
| :--- | :--- | :--- |
| Contracts | Sophia (`.aes`) on FATE | The only smart-contract language on Gajumaru |
| Contract tooling | GajuDesk, plus the compiler/CLI used by the Gajumaru toolchain | Write, compile, test and inspect contracts against Groot |
| Local chain | GM Demo Chain tooling | Spins up Groot plus Associate Chains locally (see [YouTube references](youtube-references.md)) |
| API / indexer | Python 3.14 + FastAPI + Pydantic, one uv workspace ([ADR 0001](adr/0001-python-fastapi-uv-workspace.md)) | Typed validation, OpenAPI for the dashboard, a single lockfile across services |
| Tx-builder | Erlang sidecar on Hakuzaru and the Sophia compiler, used as dependencies ([ADR 0012](adr/0012-transaction-building-and-grids-relay.md), proposed) | No SDK exists; reuses QPQ's maintained encoders |
| Dashboard | Web app, installable as a PWA for field use (camera, offline queue, WebAuthn); framework by ADR (blueprint D11) | Only renders GRIDS payloads, so it needs no wallet integration |
| Storage | PostgreSQL (read model and operational store), private S3-compatible object storage with object lock (evidence) | Replaceable. Not IPFS: evidence holds personal data ([ADR 0013](adr/0013-off-chain-data.md)) |

## 6. Non-functional requirements

- **Security:** no custodial keys. Contract entrypoints are guarded by the caller's role. Evidence is checked against its hash. All API traffic over TLS.
- **Finality:** the UI shows "pending" at microblock inclusion (≈3 s) and "final" once the network's finality rule is met: witness finality on mainnet (about one keyblock behind the top), a configured depth where there are no witnesses ([HLD §7 Q17](hld.md#7-open-questions)).
- **Cost:** checkpoints are milestones only. Bulk telemetry stays off-chain.
- **Recoverability:** the read model can be rebuilt from the chain and the evidence store.
- **Auditability:** every status change on-chain names who signed it and links to the evidence hash.

## 7. Deployment

1. **Local:** GM Demo Chain (Groot plus one AC) and the API, indexer and dashboard in containers.
2. **Testnet:** deploy contracts with the deployment script ([scripted contract deployment](scripted-contract-deployment.md)), in the order in [ADR 0011](adr/0011-agreed-booking-terms.md), paying gas from the [testnet faucet](https://faucet.testnet.gajumaru.io), and record each in the deployment manifest. GajuDesk remains the manual route ([ecosystem reference §4](ecosystem-reference.md#4-deploying-contracts-to-testnet)).
3. **Mainnet:** Groot first, after an external contract audit, with the pilot cap set. The script builds each deployment transaction unsigned and the admin wallets sign it over GRIDS, so no mainnet key sits in automation. Production reads from our own node unless QPQ advise otherwise (Node API 4). Move to an AC (existing or dedicated) only when fees or compliance require it ([HLD §6.2](hld.md#62-where-the-contract-runs)).

CI runs contract compilation and tests, unit and integration tests for the services, and an end-to-end run against a local demo chain on every pull request.
