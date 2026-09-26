# ADR 0001: Python and FastAPI for backend services, managed as a uv workspace

| | |
| :--- | :--- |
| **Status** | Accepted |
| **Date** | 2026-09-26 |
| **Related** | [Architecture §5](../architecture-blueprint.md#5-technology-choices-proposed) · [Dev approach §2](../dev-approach.md#2-repository-layout) · [backend-services skill](../../.claude/skills/backend-services/SKILL.md) |

## Context

The service language was left open until we knew which Gajumaru client libraries exist ([HLD §7](../hld.md#7-open-questions)). We need to choose now so that the API and indexer can start, and so that tooling, CI and the specialist guidance all agree.

## Decision

- **All backend services are written in Python** (3.14). REST services use **FastAPI**, and request and response models use **Pydantic**.
- **Dependencies are managed with a single uv workspace.** The root [`pyproject.toml`](../../pyproject.toml) lists each service in `services/*` as a member, and one `uv.lock` pins every dependency for the whole workspace. That means two services can never resolve to different versions of the same library.
- **Shared quality config lives in the root `pyproject.toml`:** ruff for PEP 8 linting and formatting (pycodestyle, pep8-naming, pydocstyle, bandit and others), mypy `--strict`, and pytest with a 90% branch-coverage gate.
- **Python module and package names use PEP 8 snake_case**, the one exception to the repo's kebab-case naming rule (hyphenated modules can't be imported). Service directories themselves stay kebab-case (`services/api`).
- **Tooling scripts outside the services are unchanged.** The demo and the CI check scripts stay in dependency-free Node, and the dashboard stays TypeScript.

## Consequences

- **Good:** one language for all backend code, and FastAPI gives typed request validation and an OpenAPI spec for the dashboard. Installs are reproducible (`uv sync --locked`), and dependency conflicts show up at lock time instead of in production.
- **Cost:** services have to agree on shared dependency versions. Upgrading a library means upgrading it for every service together, which is intentional.
- **Risk:** a maintained Python client for the Gajumaru node API isn't confirmed. If none exists, we'll write a thin, typed HTTP client in a shared workspace package (`packages/` or `services/common`), with tests against the local demo chain. Phase 0 must check this.
- **Follow-up:** Dependabot keeps `uv.lock` current. CI runs `uv lock --check` to reject an out-of-date lockfile.
