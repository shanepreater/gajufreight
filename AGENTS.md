# AGENTS.md

GajuFreight: Sophia contracts on Gajumaru, one per stage ([ADR 0004](docs/adr/0004-staged-contracts.md)). The shipper agrees a price with a forwarder in a `QuoteRequest`, then funds a `ShipmentEscrow`; the forwarder is paid per attested milestone and on proven delivery; otherwise the shipper is refunded or an M-of-N arbiter panel splits what's unpaid. Design: [docs/](docs/README.md).

## Plan first, then build

**No feature is built without a plan the user has explicitly approved.** Record every decision in the [decision log](docs/decision-log.md). The plan covers goal and acceptance criteria, the layers and interfaces touched, the PR split, tests, risks and what's out of scope (use `solutions-architect`; in Claude Code, use plan mode). Stop and re-approve if scope, interfaces or dependencies change. Small fixes and fully specified changes are exempt.

## Skills: load before working in an area

| Skill | Area |
| :--- | :--- |
| `solutions-architect` | Planning, cross-layer changes, ADRs, `docs/`. Load it first for multi-area work. |
| `sophia-contracts` | `contracts/`, and the escrow model in `scripts/demo` |
| `backend-services` | `services/`: Python/FastAPI, uv workspace, PEP 8 |
| `ux-designer` | Personas, journeys, wireframes (`docs/ux/`, `docs/wireframes/`), fit-for-purpose review |
| `ui-typescript` | `apps/dashboard`, `packages/`, built from the approved wireframes |
| `infra` | `infra/`, CI (keep Actions minutes minimal), deployment, secrets |
| `sre` | SLOs, observability, alerts, runbooks (`docs/runbooks/`), incidents, capacity |
| `security-consultant` | Threat models, security review, defence in depth, zero trust, cryptography and keys. Load it alongside the area's skill. |
| `sdet` | Any test work, alongside the area's skill |

An interface change (contract events or errors → `chain-types` → services → UI) updates every affected layer in the same PR, or in stacked PRs whose split `solutions-architect` has approved.

## Hard rules

1. **Never hold user keys.** Services build unsigned GRIDS payloads, and wallets sign them.
2. **Escrow and lifecycle state share one contract on one chain.** Groot can't read Associate Chain state.
3. **The chain is the source of truth.** The app database is a rebuildable read model.
4. **Agreed terms go on-chain in full; evidence and personal data only as hashes.** Evidence lives off-chain. Checkpoints are milestones, not telemetry.
5. **External feeds are untrusted.** They only prompt an attestor to sign.
6. **Don't vendor or fork QPQ tools** (GPL3). Integrate over GRIDS.
7. **Don't build on unconfirmed features** ([HLD §7](docs/hld.md#7-open-questions)). Say so and stop.
8. **Commits and PRs are attributed to the user only.** No agent co-author trailers or "generated with" footers.
9. **Keep agent context lean** for speed and cost. AGENTS.md, CLAUDE.md and skills hold rules, not explanations: link to docs instead of copying them, never duplicate between files, and load only the skill and docs the task needs. Every added line must earn its place.

## Contract invariants

Every change keeps these, and tests cover them:

- Escrows are created and funded in one call, only from a quote the `Platform` registered. Platform settings change only by admin quorum.
- Every escrow conserves its own funds: in terminal states (`Released`, `Refunded`, `Resolved`), once any leg bond is settled, payee, treasury, shipper and bond-refund payouts equal the funded amount, nothing else leaves, and paid milestones never reverse. Quotes never hold funds. Fees come only from main payee payouts and leg bonds, at the rate fixed when the quote was requested ([ADR 0010](docs/adr/0010-platform-fee.md)).
- Every state-changing entrypoint checks caller role, then status, then arguments. `Chain.spend` comes last, after `put`.
- The consignee alone can't block payment: attestors can confirm delivery, the dispute and deadline paths are always open, and a deadlocked panel falls back after the arbitration window.

## Conventions

- **Names are kebab-case**, except names fixed by tools (`README.md`, `SKILL.md`, `LICENSE`, …) and Python modules and packages (PEP 8 snake_case). CI enforces this.
- Services: Python 3.14 + FastAPI in one uv workspace ([ADR 0001](docs/adr/0001-python-fastapi-uv-workspace.md)). Use `uv add` only.
- **Privacy:** on-chain data is public. Keep contracts simple; enforce confidentiality in the app (UI, API, exports, logs) by role, and document what stays visible on-chain ([HLD §6.8](docs/hld.md#68-privacy-standard)).
- Update docs, ADRs and skills in the same PR as the behaviour they describe.

## Git workflow

- Branch per change (`<type>/<kebab-desc>`); never commit to `main`. **Commit small and often, and push after every commit or two** so a lost laptop costs minutes. Open PRs as drafts early (CI skips drafts), and mark each ready for review as soon as its work is complete.
- Conventional Commits (`feat(contracts): …`), imperative mood, subject ≤ 72 chars, and the *why* in the body. Renames get their own commit. Each commit passes tests. Tests land with or before the code.
- **At most 5 PRs open at once.** Stacking on another PR's branch is fine within that; open nothing new while 5 are open.
- Small PRs to `main`; rebase on `main` before merging, and squash only noisy history. No force-pushing shared branches, rewriting `main`, `--no-verify`, secrets or new dependencies without a reason.

## Commands

| What | Command |
| :--- | :--- |
| All repo checks | `npm run check --prefix scripts/ci` |
| Python setup / gate | `uv sync` · `uv run ruff format --check . && uv run ruff check . && uv run mypy && uv run pytest --cov` |
| Python auto-fix | `uv run ruff format . && uv run ruff check --fix .` |
| Run API | `uv run uvicorn gajufreight_api.main:app --reload` |
| Wireframe checks (local) | `npm run check --prefix scripts/wireframes` |
| Brand CSS / checks | `npm run build:css --prefix scripts/wireframes` · `npm run check --prefix scripts/wireframes` |
| Demo / tests | `node scripts/demo/run-demo.js` (`--list`, `-s <id>`, `-i`) · `npm run test:coverage --prefix scripts/demo` |
| Contracts build / check | `escript contracts/tools/build.escript` · `--check` (catalogue current) |
