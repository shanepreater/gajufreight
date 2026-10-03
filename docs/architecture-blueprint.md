# Architecture Blueprint: GajuFreight

| | |
| :--- | :--- |
| **Status** | Draft |
| **Last reviewed** | 2026-09-26 |
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
 │  • shipment booking         │   │  • ShipmentEscrow instances   │
 │  • builds GRIDS payloads    │──►│  • FATE VM                    │
 │  • evidence ingest + hash   │   │                               │
 └──────┬──────────────┬───────┘   └──────────────┬────────────────┘
        │              │                          │ microblocks (~3 s)
        ▼              ▼                          ▼
 ┌────────────┐  ┌──────────────┐        ┌──────────────────┐
 │ Evidence   │  │ App database │ ◄───── │ Chain indexer /  │
 │ store      │  │ (read model) │        │ event watcher    │
 └────────────┘  └──────────────┘        └──────────────────┘
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
| **QuoteRequest contract** | Negotiation stage: invited quotes, counters, acceptance. Never holds money | See [HLD §5](hld.md#5-contract-sketch-sophia) and [ADR 0004](adr/0004-staged-contracts.md). One per request, and one per subcontracted leg. |
| **ShipmentEscrow contract** | Execution stage: escrow, milestones and lifecycle, created only from an agreed quote | See [HLD §5](hld.md#5-contract-sketch-sophia). The source of truth for money and status. One per shipment, and one per leg. |
| **Factory / registry contract** | Creates shipment instances and lists them | Uses `Chain.clone` if Gajumaru supports it (open question). |
| **GajuFreight API** | Booking, building unsigned transactions as GRIDS payloads, evidence ingest | Stateless. Never signs on behalf of users. |
| **Evidence store** | Keeps raw documents, photos and telemetry | Content-addressed. The hash goes on-chain via `add_checkpoint`. |
| **Chain indexer** | Watches microblocks for contract calls and events, and projects them into the read model | Same pattern as GajuPay's microblock watcher. Treat keyblock depth as finality. |
| **App database** | Read model for search, dashboards and notifications | Can always be rebuilt from the chain plus the evidence store. |
| **Web dashboard** | Screens for booking, tracking, dispute and settlement | Shows GRIDS QR codes for any action that needs a signature. |
| **Attestor client** | Lightweight signer for port and customs agents | Can simply be GajuMobile scanning a GRIDS code. |

## 4. Trust boundaries

1. **The chain is authoritative** for funds and shipment status. The app database is a cache.
2. **Wallets are authoritative** for identity. The API has no custodial keys.
3. **Attestors are trusted per shipment.** Their powers are limited to the addresses listed in each contract instance (see [HLD §6.3](hld.md#63-trust-model-for-attestations)).
4. **External feeds are untrusted input.** They can only prompt an attestor to sign. They cannot change on-chain state directly.

## 5. Technology choices (proposed)

| Layer | Choice | Rationale |
| :--- | :--- | :--- |
| Contracts | Sophia (`.aes`) on FATE | The only smart-contract language on Gajumaru |
| Contract tooling | GajuDesk, plus the compiler/CLI used by the Gajumaru toolchain | Write, compile, test and inspect contracts against Groot |
| Local chain | GM Demo Chain tooling | Spins up Groot plus Associate Chains locally (see [YouTube references](youtube-references.md)) |
| API / indexer | Python 3.14 + FastAPI + Pydantic, one uv workspace ([ADR 0001](adr/0001-python-fastapi-uv-workspace.md)) | Typed validation, OpenAPI for the dashboard, a single lockfile across services |
| Dashboard | Web SPA | Only renders GRIDS payloads, so it needs no wallet integration |
| Storage | PostgreSQL (read model), S3-compatible or IPFS (evidence) | Both are replaceable |

## 6. Non-functional requirements

- **Security:** no custodial keys. Contract entrypoints are guarded by the caller's role. Evidence is checked against its hash. All API traffic over TLS.
- **Finality:** the UI shows "pending" at microblock inclusion (≈3 s) and "final" after two keyblocks (≈3–4 min).
- **Cost:** checkpoints are milestones only. Bulk telemetry stays off-chain.
- **Recoverability:** the read model can be rebuilt from the chain and the evidence store.
- **Auditability:** every status change on-chain names who signed it and links to the evidence hash.

## 7. Deployment

1. **Local:** GM Demo Chain (Groot plus one AC) and the API, indexer and dashboard in containers.
2. **Testnet:** deploy contracts with GajuDesk to the Gajumaru testnet, paying gas from the [testnet faucet](https://faucet.testnet.gajumaru.io). See [ecosystem reference §4](ecosystem-reference.md#4-deploying-contracts-to-testnet).
3. **Mainnet:** Groot first. Move to an AC (existing or dedicated) only when fees or compliance require it ([HLD §6.2](hld.md#62-where-the-contract-runs)).

CI runs contract compilation and tests, unit and integration tests for the services, and an end-to-end run against a local demo chain on every pull request.
