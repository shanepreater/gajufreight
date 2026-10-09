# ADR 0016: Hosting, environments, secrets and the Groot node

| | |
| :--- | :--- |
| **Status** | Proposed (2026-10-09), for the project owner's decision (#47). Costs are indicative list prices and must be checked in each provider's calculator before acceptance |
| **Last reviewed** | 2026-10-09 |
| **Related** | [Architecture §3, §7](../architecture-blueprint.md#7-deployment) · [ADR 0012](0012-transaction-building-and-grids-relay.md) · [ADR 0013](0013-off-chain-data.md) · [Threat model](../threat-model.md) · [Decision log](../decision-log.md) #19 · [infra skill](../../.claude/skills/infra/SKILL.md) |

## Context

The project owner wants **the lowest running cost that can scale if usage takes off**, with no fixed provider; Azure Container Apps is a candidate (decision log #19). No region or data-residency rule was given; this ADR assumes **UK or EU hosting**, because the app holds personal data (contacts, addresses, evidence) under UK GDPR.

What has to run, per environment:

| Component | Shape | Notes |
| :--- | :--- | :--- |
| API and GRIDS relay | Stateless HTTP; public HTTPS with a publicly trusted certificate | Phones fetch dead-drop requests from it (ADR 0012, decision log #10) |
| Tx-builder | Erlang sidecar; internal only | Beside the API; no keys (ADR 0012) |
| Indexer | Always-on poller | Polls the node every few seconds; can't scale to zero |
| PostgreSQL | Small managed database | A rebuildable read model (hard rule 3) |
| Evidence store | Private object storage with write-once retention | Content-addressed, verified on every read (ADR 0013) |
| Secret store | Service credentials, the testnet deployer key | No mainnet key in automation: admins sign deployments over GRIDS |
| Groot node | Stateful: chain database on a persistent disk, peer-to-peer port | Our own, at a known version (#47 acceptance criteria; threat model T5) |

The dashboard is a static PWA ([#49](https://github.com/shanepreater/gajufreight/issues/49)) and can be served from object storage or the API.

## Options

Indicative monthly cost for **one environment at pilot scale** (a few hundred shipments a month), in GBP:

| Option | Services | Indicative cost | Scaling | Operations | Cost to reverse |
| :--- | :--- | :-: | :--- | :--- | :--- |
| **A. Azure** | Container Apps (consumption) for API with the tx-builder as a sidecar, and the indexer; PostgreSQL Flexible Server (Burstable B1ms); Blob Storage with immutability policies; Key Vault; a small Linux VM (B2s) for the node | £45–70 | API scales out on requests; database and VM resize in place | Low: managed TLS certificates, GitHub OIDC, managed backups | Low: containers and Postgres move anywhere |
| **B. Google Cloud** | Cloud Run (API with tx-builder; indexer with one minimum instance); Cloud SQL (smallest shared-core); Cloud Storage with retention locks; Secret Manager; an e2-small VM for the node | £40–65 | As A | Low: as A | Low |
| **C. Hetzner (EU VPS)** | Two small VMs with Docker Compose: one for API, tx-builder, indexer and Postgres, one for the node; Hetzner Object Storage; secrets with SOPS and age | £15–30 | Manual: bigger VMs, then a move to managed services or Kubernetes | High: we run Postgres, backups, TLS renewal, patching and monitoring | Medium: the move to managed services is the scaling plan |
| **D. AWS** | ECS Fargate or App Runner; RDS (smallest); S3 with Object Lock; Secrets Manager; an EC2 instance for the node | £70–110 | As A | Low | Low |

Costs that every option shares and that dominate early on: the **node VM and its disk** (roughly a third to half of A, B or D), and the **database**. Container compute for the API stays small thanks to scale-to-zero and free grants; the indexer is the one always-on container.

## Decision (proposed)

1. **Option A, Azure, in UK South** (with UK West for backups). It matches the owner's lean, costs within a few pounds of Google Cloud, and keeps operations low; Hetzner is cheapest but trades about £30 a month for running a database, backups and patching ourselves, which isn't a good trade for a small team before revenue.
2. **Compute:** one Container Apps environment per network.
   - **API app:** the FastAPI container with the **tx-builder as a sidecar** (it listens on localhost only, as ADR 0012 requires), on a custom domain with a managed certificate. Minimum replicas 0 on testnet and 1 on mainnet, so a phone's first fetch isn't a cold start in production.
   - **Indexer app:** minimum and maximum replicas 1 (it must be a single writer per network).
3. **Data:** PostgreSQL Flexible Server, Burstable B1ms, with point-in-time restore; rebuildable from the chain if lost. **Evidence store:** a private Blob container with versioning and a time-based immutability policy matching the retention period (#45), reached only by the API through managed identity.
4. **Secrets and identity:** Key Vault per environment; services read it through managed identities, so no credentials sit in config. GitHub Actions deploys through **OIDC federated credentials** (no stored cloud keys). The testnet deployer key lives in Key Vault; **mainnet deployments are signed by admin wallets over GRIDS**, so no mainnet key is ever in the cloud (architecture §7).
5. **Groot node:** our own node on a small Linux VM per network (B2s, premium SSD), pinned to a known release, its HTTP API reachable only from the Container Apps environment's network, and its peer port open. Testnet's node can be deferred to save about £25 a month by reading from the public testnet node until the indexer needs subscriptions; mainnet's node is required before the pilot.
6. **Environments:** `local` (Docker Compose, the chain per ADR 0014), `testnet` and `mainnet`, each in its own resource group and, for mainnet, its own subscription with stricter access. Infrastructure as code (Bicep or Terraform, decided in I1 #72).
7. **Scaling path,** in order, only when usage needs it: raise the API's replica limits; move PostgreSQL to a General Purpose tier; add read replicas; move Container Apps to a dedicated workload profile; add Front Door in front of the API. None of these changes the code.

## Consequences

- **Good:** pilot running costs in the tens of pounds a month per environment; the cost grows with use rather than in advance; no keys or cloud credentials in the repo or CI; managed TLS for the dead-drop host.
- **Cost:** Azure-specific glue (managed identities, Key Vault references, Bicep) to replace if we ever move; containers, Postgres and the S3-style evidence layout keep the core portable.
- **Risk:**
  - The prices are indicative; confirm them before accepting.
  - Container Apps' consumption plan has cold starts at zero replicas; the mainnet API keeps one warm replica.
  - The node VM is a single point of failure for reads; the indexer falls back to a public node for reads if ours is down, and alerts (#48).
- **Not decided here:** the observability backend (#48, which follows this ADR), infrastructure-as-code tooling (I1 #72), and the retention period (#45).
