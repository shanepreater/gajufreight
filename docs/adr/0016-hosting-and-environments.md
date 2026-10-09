# ADR 0016: Hosting, environments, secrets and the Groot node

| | |
| :--- | :--- |
| **Status** | Proposed (2026-10-09) for #47. The project owner prefers option C, Hetzner with Neon (decision log #20); costs are indicative list prices to confirm before acceptance |
| **Last reviewed** | 2026-10-09 |
| **Related** | [Architecture §3, §7](../architecture-blueprint.md#7-deployment) · [ADR 0012](0012-transaction-building-and-grids-relay.md) · [ADR 0013](0013-off-chain-data.md) · [Threat model](../threat-model.md) · [Decision log](../decision-log.md) #19, #20 · [infra skill](../../.claude/skills/infra/SKILL.md) |

## Context

The project owner wants **the lowest running cost that can scale if usage takes off**, with no fixed provider (decision log #19), and the freedom to move later if a better provider appears. The app holds personal data (contacts, addresses, evidence) under UK GDPR. **Region rule (decision log #20): the UK first, then Switzerland, and Germany if neither is available.** The UK treats the EU/EEA and Switzerland as adequate.

What has to run, per environment:

| Component | Shape | Notes |
| :--- | :--- | :--- |
| API and GRIDS relay | Stateless HTTP; public HTTPS with a publicly trusted certificate | Phones fetch dead-drop requests from it (ADR 0012, decision log #10) |
| Tx-builder | Erlang sidecar; internal only | Beside the API; no keys (ADR 0012) |
| Indexer | Always-on poller, a single writer per network | Can't scale to zero |
| PostgreSQL | Small database | A rebuildable read model (hard rule 3) |
| Evidence store | Private object storage with write-once retention (object lock) | Content-addressed, verified on every read (ADR 0013) |
| Secrets | Service credentials, the testnet deployer key | No mainnet key in automation: admins sign deployments over GRIDS (architecture §7) |
| Groot node | Stateful: chain database on a persistent disk, peer-to-peer port | Our own, at a known version (#47; threat model T5) |
| Dashboard | Static PWA ([#49](https://github.com/shanepreater/gajufreight/issues/49)) | No server code of its own |

## Options

Indicative monthly cost for **one environment at pilot scale** (a few hundred shipments a month):

| Option | Services | Indicative cost | Scaling | Our operations | Cost to reverse |
| :--- | :--- | :-: | :--- | :--- | :--- |
| A. Azure | Container Apps for the API (tx-builder as sidecar) and indexer; PostgreSQL Flexible Server B1ms; Blob Storage with immutability; Key Vault; a B2s VM for the node | £45–70 | Scales out on requests; database and VM resize in place | Low | Low |
| B. Google Cloud | Cloud Run; Cloud SQL (shared-core); Cloud Storage with retention locks; Secret Manager; an e2-small VM for the node | £40–65 | As A | Low | Low |
| **C. Hetzner with Neon** | Hetzner Cloud VMs for the API, tx-builder, indexer and node; **Neon** serverless Postgres; Hetzner Object Storage with object lock | **£20–40** (testnet less, on Neon's free tier) | More VMs behind a Hetzner load balancer; Neon scales compute and storage itself | Medium: patching, TLS, secrets and monitoring are ours; the database is not | Low with the guardrails below |
| D. Hetzner, all self-run | As C with Postgres on our own VM | £15–30 | Manual | High: we'd also run Postgres, its backups, restores and upgrades | Medium |
| E. Vercel | Suits only the dashboard: functions are request-scoped (no always-on indexer), there's no Erlang runtime (tx-builder) and no stateful node; production needs the Pro plan | — | — | — | — |

Self-running Postgres (D) costs roughly three to five days to set up properly and two to four hours a month after, for about £10 a month saved over Neon; C keeps Hetzner's low compute price without that.

## Decision (proposed, the owner's preferred option)

1. **Option C: Hetzner Cloud for compute and the node, Neon for PostgreSQL, Hetzner Object Storage for evidence, all in Germany.** By the region rule:
   - **UK:** Hetzner has no UK site. Neon offers London, but splitting the database from the app across the Channel adds latency for no gain.
   - **Switzerland:** neither Hetzner nor Neon offers it (Neon's AWS regions don't include Zurich). A Swiss-native provider such as Exoscale would cost several times more (its managed Postgres alone is about $98 a month at the smallest useful size), so it's the option to revisit if a customer needs Swiss residency.
   - **Germany:** Hetzner's Nuremberg or Falkenstein sites for compute and storage, and Neon in **Frankfurt** (`aws-eu-central-1`), close to them.
2. **Compute,** per environment, on Hetzner Cloud with a private network and Hetzner Cloud Firewalls:
   - **App VM:** Caddy (automatic TLS for the dead-drop host, and it serves the dashboard's static files), the API, the tx-builder on localhost only, and the indexer, as containers under Docker Compose with restart policies.
   - **Node VM:** our own Groot node on a pinned release with an attached volume; its HTTP API reachable only over the private network, its peer port open.
   - Testnet's node can be deferred, reading from the public testnet node until the indexer needs subscriptions; mainnet's node is required before the pilot.
3. **Database: Neon,** plain PostgreSQL. Testnet on the free tier; mainnet on the Launch plan, with its point-in-time restore. Neon scales to zero and back, so testnet costs little; mainnet's indexer keeps it warm.
4. **Evidence store:** a private Hetzner Object Storage bucket with **versioning and object lock** for the retention period (#45), plus a nightly copy to Hetzner's other German site, checked by hash, so all copies stay in Germany.
5. **Secrets:** encrypted with SOPS and age, decrypted only on the host at deploy time, never in the repo in plain text or in CI logs. **Deployment by pull:** each host pulls signed images from GitHub's container registry and verifies their signatures before running them, so CI never holds a credential for our hosts (Hetzner has no OIDC federation to replace one). The testnet deployer key is a SOPS secret on the testnet app VM only; mainnet deployments are signed by admin wallets over GRIDS.
6. **Hardening:** Debian stable with automatic security updates, SSH by key only from known addresses, everything else closed at the firewall, containers as non-root.
7. **Environments:** `local` (Docker Compose, the chain per ADR 0014), `testnet` and `mainnet`, each in its own Hetzner project and Neon project.
8. **Scaling path,** in order, only when needed: bigger VMs; more API VMs behind a Hetzner load balancer (the API is stateless); more Neon compute and read replicas; and if operations outgrow the team, a move to a managed container platform, which the guardrails keep cheap.

## Portability guardrails

So that moving provider later is about one to two weeks of work and a short cutover, not a rewrite. The contracts, funds and agreements are on-chain and never move; the database can be copied or rebuilt from the chain.

1. **Modular infrastructure as code in OpenTofu (Terraform-compatible).** It's split into one module per capability: network and firewall, compute host, container runtime and deployment, database, object storage, DNS and TLS, and the Groot node. Each module has a provider-neutral interface (its inputs and outputs), with the provider-specific implementation inside it (for example `object-storage/hetzner`). Environments only compose modules. A provider change means writing new implementations behind the same interfaces, while environments and services stay as they are.
2. **Evidence store behind one storage interface** in our code, speaking the S3 API. Hetzner, Cloudflare R2, Backblaze and AWS all speak it; a move is configuration plus a hash-checked copy.
3. **Config and secrets reach services as environment variables.** Services never call a provider's SDK for secrets or identity.
4. **Plain PostgreSQL:** no provider-specific extensions. Neon's branching may be used for CI test databases, never by the app.
5. **Vendor-neutral observability:** OpenTelemetry for traces, metrics and logs (#48 picks the backend).
6. **No provider-only services:** containers, Postgres, S3-style storage, DNS and TLS only. No proprietary queues, functions or service meshes.

A move is then: stand up the new environment from code; restore or rebuild Postgres; copy evidence and check hashes; sync a node; lower DNS TTLs and switch the API host. Signing requests last about an hour, so the old dead-drop host drains on its own.

## Consequences

- **Good:** pilot running costs of tens of pounds a month per environment; no database to run; all data in Germany, within the region rule; cheap to grow by adding VMs and Neon capacity; cheap to leave.
- **Cost:** we own patching, TLS, secrets and monitoring on the VMs; deployment by pull and SOPS take more setup than a managed platform's built-in identity; two providers (Hetzner and Neon) to watch.
- **Risk:**
  - Prices are indicative; confirm them before accepting.
  - A single app VM per environment is a single point of failure until a second sits behind a load balancer; recovery is a redeploy from code plus the database, which Neon holds.
  - The node VM is a single point for reads; the indexer falls back to a public node and alerts (#48).
  - Neon and Hetzner are in different data centres (Frankfurt and Nuremberg or Falkenstein), so each query crosses a few milliseconds of network; fine for this workload.
  - Germany is the third choice in the region rule; a customer needing UK or Swiss residency would need a different provider, which the modular infrastructure code keeps feasible.
- **Not decided here:** the observability backend (#48), the retention period (#45), and the image-signing tool (with I1 #72).
- **On acceptance:** update the infra skill's environments table (#47's acceptance criteria) and architecture §7.

Sources checked 2026-10-09: [Neon regions](https://neon.com/docs/introduction/regions) (London and Frankfurt; no Zurich), [Exoscale pricing comparison](https://getdeploying.com/exoscale-vs-hetzner), [Neon pricing summary](https://www.srvrlss.io/provider/neon/), [S3 providers with object locking](https://sliplane.io/blog/s3-providers-with-object-locking) (Hetzner Object Storage lists object lock).
