# AGENTS.md

GajuFreight: shipment escrow + tracking on the Gajumaru network. The shipper locks Gaju in a per-shipment Sophia contract. Attestors post milestones. The carrier is paid on proven delivery; otherwise the shipper is refunded or an arbiter decides.

## Plan first, then build

**No feature is implemented without a plan the user has approved.**

1. Write the plan before any code: goal and acceptance criteria, the layers and interfaces touched, the branches/PRs it splits into, tests (including boundary cases), risks and open questions, and what's out of scope. Use the `solutions-architect` skill. In Claude Code, use plan mode.
2. Present it to the user and **wait for explicit approval**. Silence, or approval of an earlier plan, doesn't count.
3. Build only what was approved. If the plan has to change significantly part-way through (scope, interfaces, new dependencies), stop and get the change approved.

Small fixes, typo corrections and changes the user has already spelled out in detail don't need a separate plan.

## Delegate to specialist skills

Load the matching skill (`.claude/skills/<name>/SKILL.md`) **before** working in its area. It has the area's rules, pitfalls, tests and review checklist. If a task spans several areas, load `solutions-architect` first. It plans the work and splits it across the others. Load `sdet` alongside any skill when adding or reviewing tests.

| Skill | Use for | Owns |
| :--- | :--- | :--- |
| `solutions-architect` | New features, cross-layer changes, design decisions/ADRs, open questions, phase gating, architectural review | `docs/`, `docs/adr/` |
| `sophia-contracts` | Sophia/FATE contracts, lifecycle, roles, escrow logic | `contracts/` |
| `backend-services` | API, GRIDS payload building, evidence ingest, indexer/read model | `services/` |
| `ui-typescript` | Dashboard, signing UX, shared TS types | `apps/dashboard`, `packages/` |
| `infra` | Local chain, CI, environments, deployment, secrets | `infra/`, CI config |
| `sdet` | Test strategy, boundary/edge cases, invariant and property tests, test review and tooling | Test suite quality at every layer |

When one area changes an interface another relies on (contract events or errors → `packages/chain-types` → services → UI), update every affected area in the same PR, or in stacked PRs that `solutions-architect` has approved.

## Read first (only what the task needs)

| Task touches | Read |
| :--- | :--- |
| Contracts, lifecycle, roles | [docs/hld.md](docs/hld.md) §4–6 |
| Services, indexer, trust boundaries | [docs/architecture-blueprint.md](docs/architecture-blueprint.md) |
| Repo layout, phases, testing | [docs/dev-approach.md](docs/dev-approach.md) |
| Gajumaru terms (Groot, AC, GRIDS, FATE) | [docs/ecosystem-reference.md](docs/ecosystem-reference.md) |
| Citing a claim | [docs/sources.md](docs/sources.md) |

## Hard rules

1. **Never hold user keys.** Services build unsigned transactions as GRIDS payloads, and wallets (GajuDesk/GajuMobile) sign them. No signing code with private keys in `services/` or `apps/`.
2. **Escrow and lifecycle state live in the same contract on the same chain.** Groot can't read Associate Chain state. Don't design releases that depend on another chain's contract state.
3. **The chain is the source of truth** for funds and status. The app database is a read model that can be rebuilt from the chain.
4. **Only hashes go on-chain.** Raw telemetry, documents and photos go in the evidence store. Checkpoints are milestones, not GPS pings.
5. **External feeds are untrusted.** They can only prompt an attestor to sign. They never change state directly.
6. **Don't vendor or fork QPQ tools** (GPL3). Integrate over GRIDS.
7. **Don't build on unconfirmed features** (`Chain.clone`, Data TTL, protected-account payouts) until [HLD §7](docs/hld.md#7-open-questions) confirms them. If a task needs one, say so and stop.
8. All commits and PRs are solely identified as the user. No agent Co-Author should be attributed.

## Contract invariants (every change must keep these, and tests must cover them)

- Funds are conserved: `paid_to_carrier + refunded_to_shipper == funded` in every terminal state (`Released`, `Refunded`, `Resolved`).
- Every entrypoint that changes state checks the caller's role **and** the current status before doing anything else.
- Terminal states are final: no entrypoint leaves `Released`, `Refunded` or `Resolved`.
- The consignee alone can't block payment: an attestor can confirm delivery, and anyone can use the dispute and deadline paths.
- `Chain.spend` is the last step of an entrypoint, after `put(state{...})`.

## Conventions

- **File and directory names: kebab-case, always.** Docs, source, config, contracts (`shipment-escrow.aes`) and scripts. Exceptions: files whose names are fixed by convention (`README.md`, `AGENTS.md`, `CLAUDE.md`, `LICENSE`, `Dockerfile`, …), and **Python modules and packages, which use PEP 8 snake_case** (`gajufreight_api/`, `test_health.py`) because hyphens can't be imported. `scripts/ci/check-file-names.js` enforces this.
- Identifiers follow the language's own style: Sophia contracts `PascalCase`, entrypoints and fields `snake_case`, error strings `UPPER_SNAKE` (`"ONLY_SHIPPER"`).
- **Backend services are Python 3.14 + FastAPI** in one uv workspace ([ADR 0001](docs/adr/0001-python-fastapi-uv-workspace.md)). Code follows PEP 8 and PEP 257, which ruff enforces, and passes `mypy --strict`. Add dependencies only with `uv add --package <service> …`. Never use pip, and never hand-edit `uv.lock`.
- Sophia: begin every file with `@compiler >= <pinned>`, use `.aes` files, amounts in the smallest Gaju denomination, deadlines as block heights (not timestamps).
- Finality in UI and indexer: microblock inclusion (~3 s) counts as *pending*. Two keyblocks (~3–4 min) count as *final*.
- Docs: kebab-case filenames, the `Status / Last reviewed / Related` header table, and relative links. Update the relevant doc in the same change when behaviour or design changes. When a design question is settled, move it out of the open questions.

## Layout

```
contracts/src, contracts/test   Sophia contracts + tests (local demo chain)
pyproject.toml, uv.lock          Python workspace root (shared lint/type/test config, one lockfile)
services/api, services/indexer  Python/FastAPI: booking/GRIDS/evidence, microblock watcher
packages/grids, packages/chain-types
apps/dashboard
infra/local-chain, infra/freight-ac (deferred)
scripts/demo                    customer demo (simulated chain placeholder)
docs/
```

## Commands

| What | Command |
| :--- | :--- |
| Customer demo | `node scripts/demo/run-demo.js` (`--list`, `-s <id>`, `-i`, `--fast`) |
| Demo tests | `npm test --prefix scripts/demo` |
| Python setup | `uv sync` (installs every service plus dev tools from `uv.lock`) |
| Python quality gate | `uv run ruff format --check . && uv run ruff check . && uv run mypy && uv run pytest --cov` |
| Fix formatting and lint | `uv run ruff format . && uv run ruff check --fix .` |
| Run the API locally | `uv run uvicorn gajufreight_api.main:app --reload` |
| Repo convention checks | `npm run check --prefix scripts/ci` |

_Contract and UI commands will be added when those toolchains land._

## Definition of done

- Contract changes: tests for the happy path and for each rejected role or status. The conservation property still holds.
- No new dependency without a stated reason in the PR (transaction-building code is supply-chain sensitive). Pin versions.
- Docs updated if design or behaviour changed. New files are kebab-case.

## Git workflow

- **Never commit to `main`.** Create a branch for each change: `<type>/<short-kebab-desc>` (for example `feat/shipment-escrow-dispute`, `docs/hld-trust-model`).
- **Small, incremental commits.** One logical change per commit, and each one should build and pass tests on its own. Keep renames and moves separate from content edits.
- **Commit and push often.** Commit as soon as a small step works, and push the branch after every commit or two (`git push -u origin <branch>` the first time), so that a lost or broken laptop costs minutes of work, not hours. Pushing a feature branch is always safe. Open the PR as a **draft** early; CI skips drafts, so this costs no Actions minutes.
- **Conventional Commits:** `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `ci:`, with an optional scope (`feat(contracts): add refund_after_deadline`). Imperative mood, subject ≤ 72 chars. Say *why* in the body when it isn't obvious.
- **Tests go with the code:** a test either lands in the same commit as the behaviour it covers or directly before it (red → green).
- **Open a PR to `main`** for review and keep PRs small and focused. Rebase on `main` before merging. Squash only if the history is noisy.
- Don't force-push shared branches, rewrite `main`, skip hooks (`--no-verify`) or commit secrets or keys.
