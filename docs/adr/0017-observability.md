# ADR 0017: Observability backend, SLIs and alerting

| | |
| :--- | :--- |
| **Status** | Proposed (2026-10-09) for #48, following [ADR 0016](0016-hosting-and-environments.md) |
| **Last reviewed** | 2026-10-09 |
| **Related** | [ADR 0016](0016-hosting-and-environments.md) (guardrail 5: OpenTelemetry) · [ADR 0012](0012-transaction-building-and-grids-relay.md) · [ADR 0013](0013-off-chain-data.md) · [Threat model](../threat-model.md) · [sre skill](../../.claude/skills/sre/SKILL.md) · [Decision log](../decision-log.md) #19, #20 |

## Context

The services emit OpenTelemetry (ADR 0016, guardrail 5), so the backend can change without touching code. #48 asks where the data goes, what it costs, how long it's kept, and who gets paged. The constraints:

- **Lowest cost that can scale** (decision log #19). There's no ops team: alerts reach the project owner.
- **The sre skill's SLIs** must be measured: indexer lag, signing success, payout latency, dropped transactions, API availability, webhook outcomes, evidence integrity and deadline exposure.
- **No personal data in telemetry.** Logs carry ids and hashes only, never keys, PINs, tokens, raw evidence or personal data (sre and security skills). So telemetry can live outside the region rule's first choices, though we still prefer the UK or EU.
- **Security audit records aren't telemetry.** Sign-ins, authorisation denials, admin votes and verification decisions are kept in the `app` schema's audit log (ADR 0013), with their own retention. Short telemetry retention doesn't lose them.

## Options

| Option | What | Cost at pilot scale | Operations | Cost to reverse |
| :--- | :--- | :-: | :--- | :--- |
| **A. Grafana Cloud, free tier** | Metrics (10k active series), logs and traces (50 GB each), 14-day retention, alerting and incident response for 3 users. Agents on our VMs send OTLP | £0, then usage-based if we outgrow it | Low: one agent per VM | Low: change the agent's export endpoint |
| B. Self-run Grafana stack on Hetzner | Prometheus or Mimir, Loki, Tempo and Grafana on a fourth VM | About £8–15 a month for the VM | High: storage, upgrades and alerting all ours, and monitoring our own monitoring | Low |
| C. Other hosted free tiers (Better Stack, Axiom and similar) | Logs-first, with partial metrics and tracing | £0 at first | Low | Low |

## Decision (proposed)

1. **Option A: Grafana Cloud's free tier**, one stack per network, in the best region the region rule allows when the stack is created (UK, then Switzerland, then Germany or elsewhere in the EU).
2. **Collection:** the Grafana Alloy agent on each VM (app, chain and key) receives OTLP from our services and scrapes host and container metrics, then exports to the stack. Changing backend means changing the agent's endpoint, nothing in the services.
3. **Retention:** 14 days for metrics, logs and traces, the free tier's limit. That's enough to debug an incident and to set SLO targets from real data during the pilot; longer trends come later, if they're worth paying for. Audit records live in the `app` schema, not here.
4. **SLIs mapped to metrics** (#48's acceptance criteria), using OpenTelemetry names:

   | SLI | Metric | Emitted by | Unit |
   | :--- | :--- | :--- | :--- |
   | Indexer lag | `gf.indexer.lag` (node top minus last indexed generation) | Indexer | Key blocks |
   | Signing success | `gf.signing.requests` counter by outcome (`final`, `expired`, `rejected`, `tampered`); `gf.signing.time_to_final` histogram | API (relay) | Count; seconds |
   | Milestone and payout latency | `gf.payout.latency` from an attested scan-in to its payout being final | Indexer | Key blocks |
   | Dropped-transaction recovery | `gf.tx.reposted` counter; `gf.tx.not_final` gauge (transactions past N key blocks without finality) | API (relay) | Count |
   | API availability and latency | `http.server.request.duration` histogram by route and status | API | Seconds |
   | Webhook ingest | `gf.webhook.events` counter by outcome (`accepted`, `rejected`, `duplicate`, `bad_signature`) | API | Count |
   | Evidence store | `gf.evidence.writes` by outcome; `gf.evidence.verify_failures` counter (should stay at 0) | API | Count |
   | Deadline exposure | `gf.escrow.near_deadline` gauge (escrows within N key blocks of a deadline or arbitration window with no action) | Indexer | Count |
   | Node health | `gf.node.height` and `gf.node.peers`; `gf.node.finalized_lag` | Indexer | Key blocks; count |
   | Key service | `gf.keys.sealed` (1 while OpenBao is sealed); `gf.keys.request.duration` | API | State; seconds |

   Labels stay low-cardinality (network, route, outcome), so the series count stays far inside the free tier. Shipment and transaction ids go in traces and logs, never in metric labels.
5. **Alerts page on what users or funds feel** (sre skill), each linking a runbook in `docs/runbooks/` (#103):
   - indexer lag above a set number of key blocks for 10 minutes;
   - any transaction not final after N key blocks;
   - signing success below its target over an hour;
   - any evidence hash-verify failure;
   - the key service sealed;
   - the node's height not advancing;
   - API error rate above its budget;
   - escrows nearing a deadline with no action (a warning, not a page).

   Thresholds start from the pilot's measured data, with the fork watch (E13) setting the first finality values.
6. **Who gets paged:** the project owner, through Grafana's incident response (free for 3 users) to the phone app and email, with a copy to a private Discord channel. A second responder is added when there is one.
7. **Uptime from outside:** a free synthetic check on the dead-drop host's health endpoint, because phones depend on it.

## Consequences

- **Good:** £0 to start, managed storage and alerting, and OpenTelemetry end to end, so the backend can change by configuration.
- **Cost:**
  - 14-day retention; longer history means a paid plan (usage-based) or a self-run store later.
  - One more provider, holding only metadata.
- **Risk:**
  - Free-tier limits change at the provider's discretion; the agent's endpoint is the exit.
  - A single person on call. That's acceptable for a pilot, but it must change before mainnet takes real customers' money (sre skill: on-call rota).
- **On acceptance:** the sre skill's SLI table gains the metric names, and runbooks are written under #103.

Source checked 2026-10-09: [Grafana Cloud free plan](https://costbench.com/software/observability/grafana-cloud/free-plan/) (limits as stated in the options table).
