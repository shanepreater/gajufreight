# GajuFreight

A Gajumaru oracle for real-world shipping and freight: shipment tracking with escrow settlement on the Gajumaru network.

A shipper locks payment in Gaju (木) in a contract for each shipment. Authorised attestors (carrier, port agent, customs broker) post signed milestones as the goods move. The carrier is paid automatically once delivery is proven. Otherwise the shipper is refunded after the deadline, or an arbiter settles the dispute. Users sign with their own Gajumaru wallets through GRIDS, so GajuFreight never holds keys.

> **Status:** design phase. There is no runnable code yet. See [delivery phases](docs/dev-approach.md#3-delivery-phases).

## How it works

```
 Shipper ──fund──► ShipmentEscrow (Sophia on FATE) ──payout──► Carrier
                        ▲          ▲
        checkpoints ────┘          └──── confirm delivery
   (carrier / attestors)            (consignee / attestor)
```

- **On-chain:** Sophia contracts hold the escrowed funds and enforce the shipment lifecycle.
- **Off-chain:** an API that builds unsigned transactions, an evidence store (only hashes go on-chain), an indexer that watches microblocks, and a web dashboard.

## Documentation

| Doc | What's in it |
| :--- | :--- |
| [docs/](docs/README.md) | Documentation index and reading order |
| [High-level design](docs/hld.md) | Lifecycle, roles, contract sketch, design decisions, open questions |
| [Architecture blueprint](docs/architecture-blueprint.md) | Components, trust boundaries, technology choices, deployment |
| [Development approach](docs/dev-approach.md) | Repo layout, delivery phases, testing, licensing |
| [Sources](docs/sources.md) | References behind the design |

## Repository layout (planned)

| Path | Contents |
| :--- | :--- |
| `contracts/` | Sophia contracts (`.aes`) and tests |
| `services/` | `api` (booking, GRIDS payloads, evidence) and `indexer` (read model) |
| `packages/` | Shared `grids` and `chain-types` libraries |
| `apps/dashboard/` | Web UI |
| `infra/` | Local demo chain, CI and deployment config |
| `docs/` | Design docs, ADRs, references |

## Contributing

Read [AGENTS.md](AGENTS.md) first. It applies to human and AI contributors alike and covers the hard rules, contract invariants, naming (kebab-case files), and the git workflow: feature branches, small Conventional Commits, and PRs to `main`.

Specialist guidance for each area is in [.claude/skills/](.claude/skills/):

| Area | Guide |
| :--- | :--- |
| Architecture and planning | [solutions-architect](.claude/skills/solutions-architect/SKILL.md) |
| Sophia contracts | [sophia-contracts](.claude/skills/sophia-contracts/SKILL.md) |
| Backend services | [backend-services](.claude/skills/backend-services/SKILL.md) |
| UI / TypeScript | [ui-typescript](.claude/skills/ui-typescript/SKILL.md) |
| Infrastructure | [infra](.claude/skills/infra/SKILL.md) |

## License

[GPL-3.0](LICENSE)
