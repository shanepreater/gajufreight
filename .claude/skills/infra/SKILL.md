---
name: infra
description: Infrastructure and DevOps specialist for GajuFreight. Use for infra/ (local demo chain, Associate Chain config), containers, CI pipelines, environments (local/testnet/mainnet), secrets handling, and deployment of contracts or services. Monitoring, SLOs and alerting belong to the sre skill.
---

# Infrastructure specialist

You own `infra/`, CI config and deployment. Read [docs/hld.md](../../../docs/hld.md) §8.3 (trust boundaries) and §13 (deployment), and [ADR 0016](../../../docs/adr/0016-hosting-and-environments.md), first.

## Environments

| Env | Chain | Funding | Notes |
| :--- | :--- | :--- | :--- |
| local | Groot testnet, or a local chain once QPQ offer one (ADR 0014) | Testnet faucet | Docker Compose; must start with one command. CI uses the same config. |
| testnet | Groot testnet, our own pinned node | Testnet faucet (GRIDS-signed request) | Hetzner app, chain and key VMs; Neon free tier. No real value; still no keys committed. |
| mainnet | Groot, our own pinned node | Real Gaju | Same shape, separate projects; Neon Launch. Deployment needs manual approval; admins sign contract deployments over GRIDS. |

Hosting, secrets and the node: [ADR 0016](../../../docs/adr/0016-hosting-and-environments.md); build order and go-live gates: [deployment plan](../../../docs/deployment-plan.md); costs: [cost model](../../../docs/cost-model.md).

`infra/freight-ac/` (a dedicated Associate Chain) is **deferred**. Don't build it unless a task explicitly says to.

## Rules

- **Keys:** GajuFreight services never hold user keys. The only keys in infra are deployer and test keys. Test keys can be generated per run. Deployer keys come from a secret store and are never in the repo, CI logs or images.
- **Reproducible:** pin image digests, toolchain versions and the Sophia compiler version. The same inputs must give the same build.
- **Rebuildable read model:** the app database and indexer must be restorable from the chain and the evidence store. Back up the evidence store. The database is a cache.
- Filenames are kebab-case (`compose-local.yml`, `deploy-contracts.sh`), except names tools require (`Dockerfile`).

## CI pipeline

[`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml) is **one job** (the Quality gate) on every non-draft PR and push to `main`: conventions → actionlint → demo tests and coverage → demo run → `uv sync --locked` → ruff → mypy → pytest. [`codeql.yml`](../../../.github/workflows/codeql.yml) runs on `main` (code paths only) and weekly. Dependabot runs monthly, grouped.

**Minimise Actions minutes. This is a hard requirement:**

- Add steps to the existing job; don't add jobs. Each job pays for runner start-up and rounds up to a whole minute.
- No matrices unless a supported-version promise requires one.
- Keep `concurrency` with `cancel-in-progress`, skip drafts, and use caches (`setup-uv` cache).
- Put expensive or slow analysis on `main` or a schedule, not on every PR.
- Use `if: ${{ !cancelled() }}` so a single run reports every failure.

Still to add as the toolchains land: contract compile and tests (pinned compiler, local demo chain), and the end-to-end run against the real stack. Deployment workflows come in phase 1 with the deployment manifest.

**Hygiene:** pin third-party actions to a full commit SHA with a `# vX.Y.Z` comment, `permissions: contents: read` by default, `persist-credentials: false`, checksum-verify any downloaded binary, and pass untrusted event text (PR titles and bodies) through `env:`, never inline `${{ }}` in `run:`.

## Deployment

- Contracts: a scripted deploy that records the contract address, compiler version and source hash in a deployment manifest committed to the repo.
- Services: stateless containers with config from the environment, following 12-factor practice.
- Mainnet: tagged release, manual approval, and a reviewed deployment manifest.

## Checklist

- [ ] No secrets in the diff, logs or image layers.
- [ ] Versions pinned.
- [ ] Local environment starts with one command, and CI uses the same definition.
- [ ] Runbook or README updated for any new service or environment variable.
