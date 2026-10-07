# GajuFreight Documentation

[← Back to project README](../README.md)

## Reading order

New to the project? Read these in order:

1. **[High-level design](hld.md):** what GajuFreight does, the shipment lifecycle, roles, the contract sketch, and why the design is shaped this way.
2. **[Architecture blueprint](architecture-blueprint.md):** components, trust boundaries and deployment.
3. **[Development approach](dev-approach.md):** repo layout, delivery phases and testing.
4. **[Ecosystem reference](ecosystem-reference.md):** Gajumaru terms (Groot, Associate Chains, GRIDS, FATE) and developer setup.

## All documents

| Document | Purpose | Main audience |
| :--- | :--- | :--- |
| [hld.md](hld.md) | Functional design, lifecycle, contract, design decisions, open questions | Everyone |
| [architecture-blueprint.md](architecture-blueprint.md) | System components, trust boundaries, technology choices, NFRs, deployment | Engineers, architects |
| [dev-approach.md](dev-approach.md) | Repo layout, delivery phases, testing strategy, licensing | Engineers |
| [implementation-blueprint.md](implementation-blueprint.md) | MVP and full operating capacity: milestones, work breakdown and the GitHub issues for each | Everyone planning or picking up work |
| [threat-model.md](threat-model.md) | Threats per trust boundary with their controls, tests and owning issues; residual risks | Architects, security reviewers |
| [decision-log.md](decision-log.md) | Every decision with its date, who made it and where it's applied | Everyone |
| [design-audit.md](design-audit.md) | The pre-implementation audit of the whole design: findings, fixes and decisions needed | Architects, reviewers |
| [ecosystem-reference.md](ecosystem-reference.md) | Map of Gajumaru components and tools, setup checklist | Engineers new to Gajumaru |
| [youtube-references.md](youtube-references.md) | Notes from Gajumaru demos and talks, with what each means for GajuFreight | Background reading |
| [sources.md](sources.md) | Citations for the claims in these docs | Anyone checking a claim |
| [spikes/](spikes/phase-0-testnet.md) | Experiments that settle open questions with evidence. [Phase 0: QPQ's answers on testnet](spikes/phase-0-testnet.md) | Engineers, architects |
| [scripted-contract-deployment.md](scripted-contract-deployment.md) | How we deploy and call contracts from a script instead of GajuDesk, what we found, and questions for QPQ | QPQ, engineers |
| [qpq-q-and-a.md](qpq-q-and-a.md) | Questions we asked the QPQ team and their answers, the source of truth for Gajumaru platform behaviour | Engineers, architects |
| [brand/](brand/brand-guide.md) | Brand guide: logo, colour tokens, typography, components and voice, with a [colour chart](brand/colour-chart.html). One source for the wireframes and the dashboard | Designers, UI engineers |
| [ux/](ux/) | User journeys per persona (jobs, journey maps, flows), owned by the ux-designer skill | Designers, engineers |
| [wireframes/](wireframes/index.html) | Clickable screens for every party: a low-fi layout in the brand. Open locally with `npm run open --prefix scripts/wireframes`, or on the private [claude.ai review page](https://claude.ai/artifact/AbnUNEw1cpCSgb4nFxo1gX). Check with `npm run check --prefix scripts/wireframes` | Everyone reviewing the UI |
| [adr/](adr/) | Architecture Decision Records (`NNNN-kebab-title.md`). [0001: Python + FastAPI, uv workspace](adr/0001-python-fastapi-uv-workspace.md) · [0002: M-of-N arbiter panel](adr/0002-arbiter-panel.md) · [0003: package labels and scanning](adr/0003-package-labels-and-scanning.md) · [0004: staged contracts](adr/0004-staged-contracts.md) · [0005: platform, atomic booking, privacy](adr/0005-platform-booking-privacy.md) · [0006: final-mile proof of delivery](adr/0006-final-mile-proof-of-delivery.md) · [0007: consolidated shipments](adr/0007-consolidated-shipments.md) (spike) · [0008: app sessions](adr/0008-app-sessions.md) · [0009: organisations and directory](adr/0009-organisations-and-directory.md) · [0010: platform fee](adr/0010-platform-fee.md) · [0011: agreed booking terms](adr/0011-agreed-booking-terms.md) · [0012: transaction building and GRIDS relay](adr/0012-transaction-building-and-grids-relay.md) (proposed) · [0013: off-chain data](adr/0013-off-chain-data.md) | Architects, reviewers |

## Where to find answers

| Question | Go to |
| :--- | :--- |
| Who can do what to a shipment? | [HLD §3 Actors](hld.md#3-actors), [§4 Lifecycle](hld.md#4-shipment-lifecycle) |
| Why is escrow not on Groot with tracking on an AC? | [HLD §6.1](hld.md#61-escrow-and-waybill-live-in-the-same-contract) |
| Which chain do we deploy to? | [HLD §6.2](hld.md#62-where-the-contract-runs) |
| How are real-world events trusted? | [HLD §6.3](hld.md#63-trust-model-for-attestations) |
| What has been decided, and when? | [Decision log](decision-log.md) |
| What's still undecided? | [HLD §7 Open questions](hld.md#7-open-questions) |
| What has QPQ confirmed about Gajumaru? | [QPQ Q&A](qpq-q-and-a.md) |
| What's safe to put on-chain? | [HLD §6.4](hld.md#64-data-on-chain-vs-off-chain) |
| What are we building next? | [Implementation blueprint](implementation-blueprint.md), [dev approach §3](dev-approach.md#3-delivery-phases) |

## Contributing to the docs

- File names are **kebab-case**. Every doc starts with the `Status / Last reviewed / Related` header table.
- Update the relevant doc in the same PR as any change to design or behaviour. When you add a new doc, list it here.
- Record decisions that are expensive to reverse as an ADR in `adr/`. Cite evidence in [sources.md](sources.md).
- The [solutions-architect](../.claude/skills/solutions-architect/SKILL.md) skill owns this folder. See [AGENTS.md](../AGENTS.md) for the full contribution rules.
