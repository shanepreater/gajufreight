# GajuFreight

[![CI](https://github.com/shanepreater/gajufreight/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/shanepreater/gajufreight/actions/workflows/ci.yml?query=branch%3Amain)
[![CodeQL](https://github.com/shanepreater/gajufreight/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/shanepreater/gajufreight/actions/workflows/codeql.yml?query=branch%3Amain)
[![Python 3.14](https://img.shields.io/badge/python-3.14-3776AB?logo=python&logoColor=white)](pyproject.toml)
[![Node 24](https://img.shields.io/badge/node-24_LTS-5FA04E?logo=nodedotjs&logoColor=white)](scripts/demo/package.json)
[![Ruff](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/astral-sh/ruff/main/assets/badge/v2.json)](https://github.com/astral-sh/ruff)
[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)

A Gajumaru oracle for real-world shipping and freight: shipment tracking with escrow settlement on the Gajumaru network.

A shipper locks payment in Gaju (木) in a contract for each shipment. Authorised attestors (carrier, port agent, customs broker) post signed milestones as the goods move. The carrier is paid automatically once delivery is proven. Otherwise the shipper is refunded after the deadline, or an arbiter panel settles the dispute (with a fallback split if it deadlocks). Users sign with their own Gajumaru wallets through GRIDS, so GajuFreight never holds keys.

> **Status:** design phase. Runnable so far: the [end-to-end customer demo](scripts/demo/README.md) (simulated chain) and the API service skeleton. See [delivery phases](docs/dev-approach.md#3-delivery-phases).

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
| [QPQ Q&A](docs/qpq-q-and-a.md) | QPQ team answers on Gajumaru, GRIDS and Sophia |

## Quality gates

Every non-draft PR and every push to `main` runs one [CI job](.github/workflows/ci.yml). A red badge above means one of these is failing on `main`:

| Gate | Checks |
| :--- | :--- |
| Conventions | kebab-case file names (PEP 8 for Python), doc links and anchors, Conventional Commits, no agent attribution, actionlint |
| Demo | All tests, coverage ≥ 95% lines and ≥ 85% branches, and every customer scenario runs clean |
| Python | `uv.lock` up to date, ruff format and PEP 8 lint, `mypy --strict`, pytest with ≥ 90% branch coverage |
| Security | CodeQL (Python, JS, workflows) on `main` and weekly. Dependabot monthly. Actions pinned to commit SHAs |

Run the same checks locally with the commands in [AGENTS.md](AGENTS.md#commands).

## Repository layout (planned)

| Path | Contents |
| :--- | :--- |
| `contracts/` | Sophia contracts (`.aes`) and tests |
| `services/` | Python/FastAPI in a uv workspace: `api` (booking, GRIDS payloads, evidence) and `indexer` (read model) |
| `packages/` | Shared `grids` and `chain-types` libraries |
| `apps/dashboard/` | Web UI |
| `infra/` | Local demo chain and deployment config |
| `scripts/` | `demo` (customer demo) and `ci` (repo convention checks) |
| `.github/` | CI and CodeQL workflows, Dependabot, PR template |
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
| Testing | [sdet](.claude/skills/sdet/SKILL.md) |

## License

[GPL-3.0](LICENSE)
