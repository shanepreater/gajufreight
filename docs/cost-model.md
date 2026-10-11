# Cost model

| | |
| :--- | :--- |
| **Status** | Rough estimates (2026-10-10), for planning. Check each provider's calculator before committing to spend |
| **Last reviewed** | 2026-10-10 |
| **Related** | [Deployment plan](deployment-plan.md) · [HLD §8](hld.md#8-system-architecture) · [ADR 0016](adr/0016-hosting-and-environments.md) · [ADR 0017](adr/0017-observability.md) · [Spike round 2](spikes/phase-0-testnet.md#round-2-2026-10-06) (measured fees) |

What each piece of the initial system costs, why it's there, and how it grows. Prices are list prices in euros excluding VAT, from the sources at the end; **£ figures use €1 ≈ £0.85** and are rounded. Hetzner raised prices in April 2026 and its cheapest CX servers have had limited availability, so the tables price the dependable CPX line and show CX where it's cheaper.

## 1. Monthly hosting, per piece

### Testnet

| Piece | What it's for | Size and why | €/month |
| :--- | :--- | :--- | --: |
| App VM | Caddy (TLS, dashboard files), API and relay, tx-builder | CPX22: 2 vCPU, 4 GB, plus an IPv4 address; light load (CX23 €4.49 where available) | 6.99 |
| Chain VM | Our Groot node and the indexer | CPX22, plus a 50 GB volume for the chain data (to confirm once our node syncs) | 9.49 |
| Key VM | OpenBao: evidence keys and erasure | CPX22; tiny load, but its own boundary (CX23 €4.49 where available) | 6.99 |
| Database | Neon PostgreSQL, `read` and `app` schemas | Free tier: 0.5 GB and 100 compute-hours, enough for testnet | 0.00 |
| Evidence store | Primary bucket, versioned, object lock | Hetzner Object Storage base price, includes 1 TB stored and 1 TB egress | 6.49 |
| Backup store | Half of one shared backup project (evidence copies, OpenBao snapshots, `app` dumps) | One locked project serves both networks | 3.25 |
| Domain and DNS | Domain shared by both networks; Hetzner DNS free | About €12 a year | 0.50 |
| Observability | Grafana Cloud | Free tier (10k metric series, 50 GB logs and traces, 14 days) | 0.00 |
| Email | Delivery codes and reminders (B12) | A free tier (about 300 emails a day) covers testnet | 0.00 |
| CI and code hosting | GitHub, Actions | Within the free plan's minutes | 0.00 |
| **Total** | | | **€33.71 ≈ £29** (≈ £24 with CX where available) |

### Mainnet

| Piece | What it's for | Size and why | €/month |
| :--- | :--- | :--- | --: |
| App VM | As testnet | CPX22; scales out behind a load balancer when needed (§4) | 6.99 |
| Chain VM | Node and indexer | CPX32: 4 vCPU, 8 GB, plus a 100 GB volume; mainnet's chain is larger and the indexer busier | 16.49 |
| Key VM | OpenBao | CPX22 | 6.99 |
| Database | Neon | Launch plan, usage-based; typical spend about $15 | 14.00 |
| Evidence store | Primary bucket | Base price; a pilot stays well inside 1 TB | 6.49 |
| Backup store | The other half of the shared backup project | | 3.24 |
| Domain and DNS | Other half of the domain | | 0.50 |
| Observability | Grafana Cloud free tier | | 0.00 |
| Email | Free tier at pilot volumes | Paid plans from about €15 a month at 10k emails | 0.00 |
| CI and code hosting | GitHub | | 0.00 |
| **Total** | | | **€54.70 ≈ £46** |

**Both networks: about €88 a month (≈ £75), or about £900 a year.** Hetzner VMs aren't backed up by Hetzner; they're rebuilt from code instead, so there's no backup surcharge.

## 2. Chain costs

Measured on testnet ([spike round 2](spikes/phase-0-testnet.md#round-2-2026-10-06), E14 and E18), at the 10⁹ puck per gas floor: a contract call costs about **0.00019 Gaju** (a fixed charge of about 182,600 gas plus execution), a booking about **0.0002 Gaju**, and a contract create about **0.0002–0.0003 Gaju** depending on size. Testnet gas is free from the faucet.

| Who pays | What | Calls | Gaju |
| :--- | :--- | :-: | --: |
| **GajuFreight (admins)** | One mainnet deployment: `Platform` and two templates (creates), then votes on the templates, pilot cap and fees (propose and approve) | 3 creates + about 8 calls | about 0.0024, once |
| **Users, per shipment** (main shipment with two legs) | Main: request, 3 quotes, 1 counter, accept, book, 3 checkpoints, delivery. Each leg: request, quote, accept, book, checkpoint, delivery | about 23 calls | about 0.0044, shared between the parties |
| Users, per dispute | Raise, votes, resolution | about 5 calls | about 0.001 |

There's no reliable public Gaju price, so here's what one shipment's chain fees come to at a range of prices:

| Gaju price | £0.01 | £1 | £10 | £100 | £1,000 |
| :--- | --: | --: | --: | --: | --: |
| Chain fees per shipment (0.0044 Gaju) | £0.00004 | £0.004 | £0.04 | £0.44 | £4.40 |

Below about £100 a Gaju, chain fees are negligible next to the freight itself. GajuFreight's own recurring chain cost is admin votes only.

## 3. One-off costs

| Item | Why | Rough cost | When |
| :--- | :--- | --: | :--- |
| **External contract audit** (H2 [#107](https://github.com/shanepreater/gajufreight/issues/107)) | The contracts hold users' money and can't be patched in place | **£15,000–£40,000**, the largest item; Sophia auditors are few, so ask QPQ for recommendations | Before mainnet |
| Penetration test of the API, relay and dashboard (optional) | An outside check of the public surface beyond our own review (H1) | £5,000–£12,000 | Before mainnet, or with the first larger customer |
| Domain registration | The dead-drop host needs a public HTTPS name | About £10–15 a year | Before testnet |
| Setup effort, first environment | OpenTofu modules and provisioning (5–8 days), OpenBao (1–2), observability (1–2), signed releases and pull deploys (1–2), restore drills and runbooks (2) | **10–16 days** of engineering | M1 |
| Setup effort, mainnet | Repeating the modules, plus mainnet's gates | 2–3 days | M2 |
| Contract deployment gas | §2 | About 0.0024 Gaju | Each deployment |

**Ongoing people time,** which isn't hosting but matters more: about 2–4 hours a month for patching, upgrades, OpenBao unsealing and restore drills, plus being on call.

## 4. Growth scenarios (mainnet, per month)

| Piece | Pilot (up to ~500 shipments) | 10× (~5,000 shipments) | 100× (~50,000 shipments) | What triggers the step |
| :--- | --: | --: | --: | :--- |
| App VMs | 1× CPX22: 6.99 | 2× CPX32 behind a load balancer: about 29 | 4× larger servers behind a load balancer: about 86 | Sustained CPU above 60% or p95 latency over target |
| Chain VM | CPX32 + 100 GB: 16.49 | Same: 16.49 | Larger server and 200 GB: about 30 | Indexer lag (key blocks behind) |
| Key service | CPX22: 6.99 | Same: 6.99 | Three-node OpenBao cluster: about 21 | When an outage of evidence access matters commercially |
| Database (Neon) | Launch: about 14 | Launch, more compute: about 35 | Scale plan: about 150 | Compute hours, connections, restore window |
| Evidence and backups | 9.73 | Same: 9.73 | About 3 TB each side: about 48 | More than 1 TB stored |
| Observability | 0 | 0–20 | About 50–150 | Free-tier series or log limits |
| Email | 0 | About 15 | About 50–80 | Daily sending limits |
| Domain | 0.50 | 0.50 | 0.50 | |
| **Total** | **€54.70 ≈ £46** | **≈ €123 ≈ £104** | **≈ €500 ≈ £425** | |

Notes on scaling:
- **Keys at scale:** a cloud KMS charges per key per month, so one key per shipment gets expensive at 100× (for example, $0.06 a key-month would pass $3,000 a month within a month). At that size, keep OpenBao as a cluster, or revisit key granularity in [ADR 0013](adr/0013-off-chain-data.md), rather than moving per-shipment keys to a provider.
- **People before servers:** at 10× a second responder is needed (the mainnet gate requires one anyway); at 100× an on-call rota and part-time operations cost far more than the hosting.
- **Migration stays cheap:** the portability guardrails ([ADR 0016](adr/0016-hosting-and-environments.md)) keep a move to a managed container platform at about one to two weeks of work if operations, not cost, become the constraint.

## Sources (checked 2026-10-09 and 2026-10-10)

- Hetzner Cloud 2026 prices and availability: [Hetzner price increase 2026](https://findstack.com/resources/hetzner-price-increase-2026), [Hetzner cost-optimised plans](https://www.bitdoze.com/md/hetzner-cloud-cost-optimized-plans.md)
- Hetzner Object Storage: [cheap object storage in Europe](https://sliplane.io/blog/cheap-object-storage-providers-europe)
- Neon: [regions](https://neon.com/docs/introduction/regions), [pricing summary](https://www.srvrlss.io/provider/neon/)
- Grafana Cloud: [free plan](https://costbench.com/software/observability/grafana-cloud/free-plan/)
- Chain fees: our own measurements, [spike round 2](spikes/phase-0-testnet.md#round-2-2026-10-06) E14 and E18
- Volume pricing (about €0.05 per GB a month), email, audit and penetration-test figures are estimates, to confirm with quotes
