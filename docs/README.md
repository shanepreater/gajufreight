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
| [ecosystem-reference.md](ecosystem-reference.md) | Map of Gajumaru components and tools, setup checklist | Engineers new to Gajumaru |
| [youtube-references.md](youtube-references.md) | Notes from Gajumaru demos and talks, with what each means for GajuFreight | Background reading |
| [sources.md](sources.md) | Citations for the claims in these docs | Anyone checking a claim |
| [ux/](ux/) | User journeys per persona (jobs, journey maps, flows), owned by the ux-designer skill | Designers, engineers |
| [wireframes/](wireframes/index.html) | Clickable low-fidelity screens for every party. Check with `npm run check --prefix scripts/wireframes` | Everyone reviewing the UI |
| [adr/](adr/) | Architecture Decision Records (`NNNN-kebab-title.md`). [0001: Python + FastAPI, uv workspace](adr/0001-python-fastapi-uv-workspace.md) | Architects, reviewers |

## Where to find answers

| Question | Go to |
| :--- | :--- |
| Who can do what to a shipment? | [HLD §3 Actors](hld.md#3-actors), [§4 Lifecycle](hld.md#4-shipment-lifecycle) |
| Why is escrow not on Groot with tracking on an AC? | [HLD §6.1](hld.md#61-escrow-and-waybill-live-in-the-same-contract) |
| Which chain do we deploy to? | [HLD §6.2](hld.md#62-where-the-contract-runs) |
| How are real-world events trusted? | [HLD §6.3](hld.md#63-trust-model-for-attestations) |
| What's still undecided? | [HLD §7 Open questions](hld.md#7-open-questions) |
| What's safe to put on-chain? | [HLD §6.4](hld.md#64-data-on-chain-vs-off-chain) |
| What are we building next? | [Dev approach §3](dev-approach.md#3-delivery-phases) |

## Contributing to the docs

- File names are **kebab-case**. Every doc starts with the `Status / Last reviewed / Related` header table.
- Update the relevant doc in the same PR as any change to design or behaviour. When you add a new doc, list it here.
- Record decisions that are expensive to reverse as an ADR in `adr/`. Cite evidence in [sources.md](sources.md).
- The [solutions-architect](../.claude/skills/solutions-architect/SKILL.md) skill owns this folder. See [AGENTS.md](../AGENTS.md) for the full contribution rules.
