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
| PostgreSQL | Small database, two schemas (ADR 0013) | `read` is rebuildable from the chain (hard rule 3); `app` (organisations, contacts, verification, sessions, GRIDS requests) is a system of record |
| Evidence store | Private object storage with write-once retention (object lock) | Content-addressed, encrypted per object with keys from our key service, crypto-shredded on erasure, verified on every read (ADR 0013) |
| Key service | Keys per environment, data class and shipment; deletion for erasure | ADR 0013's envelope encryption and crypto-shredding |
| Secrets | Service credentials, the testnet deployer key | No mainnet key in automation: admins sign deployments over GRIDS (architecture §7) |
| Groot node | Stateful: chain database on a persistent disk, peer-to-peer port | Our own, at a known version (#47; threat model T5) |
| Dashboard | Static PWA ([#49](https://github.com/shanepreater/gajufreight/issues/49)) | No server code of its own |

## Options

Indicative monthly cost for **one environment at pilot scale** (a few hundred shipments a month):

| Option | Services | Indicative cost | Scaling | Our operations | Cost to reverse |
| :--- | :--- | :-: | :--- | :--- | :--- |
| A. Azure | Container Apps for the API (tx-builder as sidecar) and indexer; PostgreSQL Flexible Server B1ms; Blob Storage with immutability; Key Vault; a B2s VM for the node | £45–70 | Scales out on requests; database and VM resize in place | Low | Low |
| B. Google Cloud | Cloud Run; Cloud SQL (shared-core); Cloud Storage with retention locks; Secret Manager; an e2-small VM for the node | £40–65 | As A | Low | Low |
| **C. Hetzner with Neon** | Hetzner Cloud VMs for the API, tx-builder, indexer and node; **Neon** serverless Postgres; Hetzner Object Storage with object lock | **£25–45** with the testnet node and our own key VM (testnet less, on Neon's free tier) | More VMs behind a Hetzner load balancer; Neon scales compute and storage itself | Medium: patching, TLS, secrets and monitoring are ours; the database is not | Low with the guardrails below |
| D. Hetzner, all self-run | As C with Postgres on our own VM | £15–30 | Manual | High: we'd also run Postgres, its backups, restores and upgrades | Medium |
| E. Vercel | Suits only the dashboard: functions are request-scoped (no always-on indexer), there's no Erlang runtime (tx-builder) and no stateful node; production needs the Pro plan | — | — | — | — |

Self-running Postgres (D) costs roughly three to five days to set up properly and two to four hours a month after, for about £10 a month saved over Neon; C keeps Hetzner's low compute price without that.

## Decision (proposed, the owner's preferred option)

1. **Option C: Hetzner Cloud for compute and the node, Neon for PostgreSQL, Hetzner Object Storage for evidence, all in Germany.** By the region rule:
   - **UK:** Hetzner has no UK site. Neon offers London, but splitting the database from the app across the Channel adds latency for no gain.
   - **Switzerland:** neither Hetzner nor Neon offers it (Neon's AWS regions don't include Zurich). A Swiss-native provider such as Exoscale would cost several times more (its managed Postgres alone is about $98 a month at the smallest useful size), so it's the option to revisit if a customer needs Swiss residency.
   - **Germany:** Hetzner's Nuremberg or Falkenstein sites for compute and storage, and Neon in **Frankfurt** (`aws-eu-central-1`), close to them.
2. **Three VMs per network** on Hetzner Cloud, each with a Hetzner Cloud Firewall, joined by WireGuard: the app VM, the chain VM, and the key VM (item 5).
   - **App VM:** Caddy (automatic TLS for the dead-drop host, and it serves the dashboard's static files), the API, and the tx-builder on localhost only. This is the only tier that scales out.
   - **Chain VM:** our own Groot node, pinned to a known release, on an attached volume, with **the indexer beside it**. The indexer is the network's only writer to the `read` schema, so it runs on exactly one host by design. It also takes a PostgreSQL advisory lock at start-up and exits if another indexer holds it, so a mistaken second copy fails closed.
   - **Testnet runs its own pinned node too,** as #47 requires, so testnet exercises the production setup.
   - **Reaching the node:** the node's HTTP API binds to localhost on the chain VM. The app VM reaches it only through a **WireGuard tunnel**, which is encrypted and mutually authenticated by key. At the tunnel's end, a reverse proxy allows only the endpoints we use: status, accounts, generations, microblock transactions, transaction info, dry run and posting a transaction. The peer-to-peer port is the only other open port.
3. **Database: Neon, plain PostgreSQL, with the two schemas ADR 0013 defines.**
   - **`read`** holds chain projections and can be rebuilt from the chain; the rebuild time is measured.
   - **`app`** is a system of record: organisations, members, verification decisions, contacts, sessions and GRIDS requests. It can't be rebuilt.
   - Each service has its own database role with only the grants it needs: the indexer writes `read` only, and the API can't alter `read`.
   - **Backups on both networks,** because testnet carries the pilot's real users (H3):
     - Neon's point-in-time restore (testnet on the free tier, mainnet on the Launch plan);
     - plus a nightly logical dump of `app`, encrypted to an offline recovery key and written to the locked backup bucket (item 4);
     - a restore test every quarter on each network.
4. **Evidence store,** encrypted and backed up as ADR 0013 requires:
   - **Encryption:** the API encrypts every object before upload with its own data key (item 5). The bucket only ever holds ciphertext.
   - **Primary bucket:** private, with versioning and **object lock** for the retention period (#45).
   - **Backup bucket:** in a separate Hetzner project at Hetzner's other German site, with **its own versioning and object lock**. A nightly copy writes to it with credentials that can add objects but never delete or overwrite them, and those credentials are separate from the primary's. Compromising the primary therefore can't destroy the backup.
   - **Restore check:** monthly, a sample of objects is restored, checked against its hash and decrypted.
5. **Key management: our own OpenBao, for now** (decision log #21). OpenBao is the open-source fork of HashiCorp Vault, under MPL-2.0. Its transit engine gives ADR 0013 its keys per environment, data class and shipment, and **erasure by deleting a shipment's key** ("crypto-shredding").
   - **Where it runs:** a small **key VM** per network, on its own (not on the app or chain VM). OpenBao uses its built-in Raft storage on an attached volume, and is reachable only over the WireGuard tunnel from the app VM.
   - **Envelope encryption:** each evidence object is encrypted with its own data key. That data key is wrapped by the shipment's OpenBao key, and the wrapped copy is stored in the `app` schema, not in the locked object. Deleting the shipment's key makes the wrapped data keys, and so the evidence, unreadable.
   - **Least privilege:** the API's OpenBao policy can create keys, encrypt and decrypt, but **can't delete**. Deletion runs as a separate, audited admin role. OpenBao's audit log records every use.
   - **Backups and the erasure window:** a daily encrypted Raft snapshot goes to the locked backup bucket (item 4), with a restore drill every quarter, because losing OpenBao would make every evidence object permanently unreadable. Those snapshots also hold a deleted key until they expire, so **snapshot retention is 30 days**, and the privacy notice says erased data becomes unreadable within 30 days rather than at once. Legal to confirm (#45).
   - **Unsealing:** after any restart, OpenBao needs two of three Shamir unseal key shares, held by the project owner and trusted people, before it serves. The key VM doesn't reboot automatically; it's patched and restarted in a planned slot. While OpenBao is sealed, adding and viewing evidence pause; nothing on-chain is affected.
   - **Moving to a provider later** (AWS KMS or Google Cloud KMS in Frankfurt), when the erasure window or availability matters commercially or the team grows: unwrap each stored data key with OpenBao and re-wrap it under the provider's keys. **No evidence is re-encrypted,** which matters because object lock forbids rewriting it. The key-management interface (guardrail 7) keeps the code unchanged.
6. **Secrets: SOPS with age.**
   - **Host keys:** each host generates its own age key at provisioning, and it never leaves the host. The repo holds only SOPS-encrypted files, with recipients listed in `.sops.yaml`: the hosts that need each file, plus an **offline recovery key** the project owner holds.
   - **Scope:** credentials are per service and per environment: a Neon role, a bucket key, an OpenBao token for the API's policy. The Hetzner API token used by OpenTofu never sits on a host.
   - **Rotation:** credentials are rotated at their source and files re-encrypted with `sops updatekeys`. Replacing a host means adding its new key and removing the old.
   - **After a host compromise or loss:** remove its age key from the recipients, rotate every credential it held at the source, and rebuild the host from code. The offline recovery key restores access if every host is lost.
   - The testnet deployer key is a SOPS secret on testnet's app VM only. Mainnet deployments are signed by admin wallets over GRIDS.
   - **Accepted limitation:** there's no hardware-backed secret store. Root on a host exposes that host's secrets, so the per-service scope is what limits the damage.
7. **Deployment by pull, pinned by digest:**
   - **CI** builds each image and signs it with **cosign keyless signing (Sigstore)**, bound to this repository's release workflow on `main`. It records each image's **digest** in a release manifest.
   - **Hosts** pull images by digest only, never by tag. Before starting one, they verify its signature and the signing identity (this repository, its release workflow and ref) with cosign, and refuse to run anything that fails.
   - CI never holds a credential for our hosts; Hetzner has no keyless login of the kind GitHub offers to the big clouds.
8. **Hardening:** Debian stable with automatic security updates, SSH by key only from known addresses, everything else closed at the firewall, and containers running as non-root.
9. **Environments:** `local` (Docker Compose, with the chain per ADR 0014), `testnet` and `mainnet`, each in its own Hetzner and Neon projects, with its own OpenBao.
10. **Scaling path,** in order, only when needed:
    - bigger VMs;
    - **more app VMs** behind a Hetzner load balancer (the API is stateless, and the indexer stays on the chain VM);
    - more Neon compute, and read replicas;
    - if operations outgrow the team, a move to a managed container platform, which the guardrails keep cheap.

## Portability guardrails

So that moving provider later is about one to two weeks of work and a short cutover, not a rewrite. The contracts, funds and agreements are on-chain and never move; the database can be copied or rebuilt from the chain.

1. **Modular infrastructure as code in OpenTofu (Terraform-compatible).** It's split into one module per capability: network and firewall, compute host, container runtime and deployment, database, object storage, DNS and TLS, and the Groot node. Each module has a provider-neutral interface (its inputs and outputs), with the provider-specific implementation inside it (for example `object-storage/hetzner`). Environments only compose modules. A provider change means writing new implementations behind the same interfaces, while environments and services stay as they are.
2. **Evidence store behind one storage interface** in our code, speaking the S3 API. Hetzner, Cloudflare R2, Backblaze and AWS all speak it; a move is configuration plus a hash-checked copy.
3. **Config and secrets reach services as environment variables.** Services never call a provider's SDK for secrets or identity.
4. **Plain PostgreSQL:** no provider-specific extensions. Neon's branching may be used for CI test databases, never by the app.
5. **Vendor-neutral observability:** OpenTelemetry for traces, metrics and logs (#48 picks the backend).
6. **No provider-only services:** containers, Postgres, S3-style storage, DNS and TLS only. No proprietary queues, functions or service meshes.
7. **Key management behind one interface** (create, wrap, unwrap, delete), so OpenBao can give way to a cloud KMS by re-wrapping data keys, without touching evidence handling.

A move is then: stand up the new environment from code; restore or rebuild Postgres; copy evidence and check hashes; sync a node; lower DNS TTLs and switch the API host. Signing requests last about an hour, so the old dead-drop host drains on its own.

## Consequences

- **Good:** pilot running costs of tens of pounds a month per environment; no database to run; all data in Germany, within the region rule; cheap to grow by adding VMs and Neon capacity; cheap to leave.
- **Cost:** we own patching, TLS, secrets and monitoring on the VMs; deployment by pull, WireGuard, SOPS and OpenBao take more setup than a managed platform's built-in identity; OpenBao adds about one to two days of setup, then an hour a month (upgrades, snapshots, restore drills, unsealing); two providers to watch (Hetzner and Neon).
- **Risk:**
  - Prices are indicative; confirm them before accepting.
  - A single app VM per environment is a single point of failure until a second sits behind a load balancer; recovery is a redeploy from code, with the database at Neon.
  - OpenBao is a single VM: while it's down or sealed, evidence can't be added or read. Acceptable for the pilot; a cloud KMS removes it.
  - Erasure takes up to 30 days to reach the key snapshots, rather than being immediate; legal to confirm (#45).
  - Losing OpenBao and its snapshots would make all evidence unreadable; the quarterly restore drill guards against it.
  - The chain VM is a single point for reads and indexing; if its node fails, the indexer can read from the public node and alerts (#48).
  - Neon and Hetzner are in different data centres (Frankfurt and Nuremberg or Falkenstein), so each query crosses a few milliseconds of network; fine for this workload.
  - Germany is the third choice in the region rule; a customer needing UK or Swiss residency would need a different provider, which the modular infrastructure code keeps feasible.
- **Not decided here:** the observability backend (#48) and the retention period (#45).
- **On acceptance:** update the infra skill's environments table (#47's acceptance criteria) and architecture §7.

Sources checked 2026-10-09: [Neon regions](https://neon.com/docs/introduction/regions) (London and Frankfurt; no Zurich), [Exoscale pricing comparison](https://getdeploying.com/exoscale-vs-hetzner), [Neon pricing summary](https://www.srvrlss.io/provider/neon/), [S3 providers with object locking](https://sliplane.io/blog/s3-providers-with-object-locking) (Hetzner Object Storage lists object lock).
