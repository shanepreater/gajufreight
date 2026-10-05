# Development Approach

| | |
| :--- | :--- |
| **Status** | Draft |
| **Last reviewed** | 2026-10-05 ([design audit](design-audit.md)) |
| **Related** | [HLD](hld.md) · [Architecture](architecture-blueprint.md) · [Sources](sources.md) |

This document sets out how the repository is organised, where module boundaries fall, and the order in which we build.

## 1. Principles

1. **Integrate with the Gajumaru tools that already exist rather than rebuilding them.** GajuDesk and GajuMobile are maintained by QPQ (GPL3). GajuFreight talks to them through GRIDS and doesn't fork them.
2. **Contracts first.** The Sophia contract defines the product. Services and UI are views over it.
3. **Keep the dependency surface small.** Supply-chain risk matters for anything that builds transactions. Pin versions and don't add dependencies casually.
4. **Keep the deployment target open.** The same contracts should deploy to Groot, a public AC or a dedicated AC without code changes.
5. **Keep it simple** Code needs to be maintainable and understandable. Ensure implementations and approaches are applicable to a mid level developer.
6. **Use design patterns** Use industry standard patterns to improve the maintainability
7. **Security and observability are key** Treat security and observabiltiy as first class citizens.

## 2. Repository layout

```
gajufreight/
├── contracts/
│   ├── src/                 # platform.aes, quote-request.aes, shipment-escrow.aes (Platform clones the templates)
│   └── test/                # contract tests against a local demo chain
├── pyproject.toml           # uv workspace root: shared ruff/mypy/pytest config
├── uv.lock                  # one lockfile for every Python service
├── services/                # Python 3.14 + FastAPI (ADR 0001)
│   ├── api/                 # booking, GRIDS payload builder, evidence ingest
│   │   ├── pyproject.toml
│   │   ├── src/gajufreight_api/
│   │   └── tests/
│   ├── indexer/             # microblock watcher → read model
│   └── tx-builder/          # internal Erlang sidecar: builds unsigned calls (ADR 0012, proposed)
├── packages/
│   ├── grids/               # GRIDS payload encode/decode
│   └── chain-types/         # shared models for FATE/contract types
├── apps/
│   └── dashboard/           # web UI for booking, tracking, disputes
├── infra/
│   ├── local-chain/         # GM Demo Chain config (Groot + AC)
│   └── freight-ac/          # (later) dedicated Associate Chain config
├── scripts/
│   └── demo/                # customer end-to-end demo (simulated chain for now)
├── e2e/                     # full-stack journeys against a local chain
└── docs/
```

Changes from the earlier draft:

| Earlier | Now | Why |
| :--- | :--- | :--- |
| `apps/gaju-desk`, `apps/gaju-mobile` | Removed | These are existing QPQ products. We integrate with them rather than host copies. |
| `packages/gaju-pay-client` | Folded into `services/indexer` | We only need the "watch microblocks for a matching transaction" pattern, not a merchant SDK. |
| `packages/sophia-contracts` | Top-level `contracts/` | Contracts are the core of the product and have their own toolchain. |
| `associate-chains/freight-ac` | `infra/freight-ac` (deferred) | A dedicated AC is a deployment choice, not an MVP requirement. |
| pnpm/TypeScript assumed everywhere | Python + FastAPI for services in a uv workspace, TypeScript for the dashboard | See [ADR 0001](adr/0001-python-fastapi-uv-workspace.md). |

## 3. Delivery phases

| Phase | Goal | Exit criteria |
| :--- | :--- | :--- |
| **0. Spike** | Answer the open questions in [HLD §7](hld.md#7-open-questions) | Every [HLD §7](hld.md#7-open-questions) question answered, decided or explicitly deferred, and every answer the design relies on verified on testnet. Spike E1–E11 done; E9 (GRIDS) and E12 (zero spends, `is_payable`) remain, plus the decisions from the [design audit](design-audit.md). Tracked as milestone M0 in the [implementation blueprint](implementation-blueprint.md) |
| **1. Contracts** | `Platform` (ADR 0005), `QuoteRequest` and `ShipmentEscrow` (ADR 0004) plus factory, with tests on a local demo chain | Every stage and lifecycle path tested: negotiation, escrow from an agreed quote, milestones, legs, dispute, refund, unauthorised callers |
| **2. Signing** | Build GRIDS payloads, sign with GajuDesk/GajuMobile | A shipment can be funded and delivered end to end using only wallet signatures |
| **3. Indexer + API** | Read model, evidence ingest, hash anchoring | The dashboard can be rebuilt from the chain alone |
| **4. Dashboard** | Screens for booking, tracking, disputes | Tested with pilot users on testnet |
| **5. Hardening** | Contract review, M-of-N attestations, monitoring | External review done; mainnet deployment on Groot |
| **6. Scale (optional)** | Move to an existing AC or a dedicated freight AC | Justified by fees or compliance requirements |

The [implementation blueprint](implementation-blueprint.md) maps these phases to milestones (M0 design closed, M1 testnet alpha = phases 1–3, M2 MVP mainnet pilot = phase 4 and the pre-mainnet part of 5, M3 full operating capacity) and breaks each into issues.

## 4. Testing

- **Contracts:** unit tests for each entrypoint and role, plus property tests for the conservation invariant in [AGENTS.md](../AGENTS.md#contract-invariants): in every terminal state, with any leg bond settled, payee, treasury, shipper and bond-refund payouts equal the funded amount. The same seeded random call sequences run against the demo model and the real contract, and their outcomes must match (differential testing).
- **Integration:** run against GM Demo Chain (Groot plus AC) in CI.
- **End to end:** script a full shipment (book → fund → checkpoints → deliver → payout) using test wallets from the faucet.

## 5. Licensing

GajuFreight is licensed under GPL-3.0 (see [LICENSE](../LICENSE)), the same licence as the QPQ tools we integrate with (GajuDesk, GajuMobile). Every new dependency must be GPL-3.0-compatible.
