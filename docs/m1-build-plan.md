# M1 build plan: backend services and Sophia contracts

| | |
| :--- | :--- |
| **Status** | Approved 2026-10-21 by the project owner; in progress |
| **Last reviewed** | 2026-10-21 |
| **Related** | [Implementation blueprint](implementation-blueprint.md) · [Decision log](decision-log.md) #35–#40 · [Deployment plan](deployment-plan.md) |

The working plan for milestone M1 (testnet alpha) in the [implementation blueprint](implementation-blueprint.md): the backend services and the Sophia contracts, run first as a Docker Compose stack and later deployed to the cloud services in [ADR 0016](adr/0016-hosting-and-environments.md). It runs over many sessions, so **update the Status column and the progress log in the same PR as the work**, and re-plan with the project owner if scope, interfaces or dependencies change.

**M1 exit:** a scripted shipment books, funds, scans, delivers and pays out on Groot testnet through the API and GRIDS relay using only wallet signatures, and the read model rebuilds from the chain and the evidence store.

**Starting point (main @ 55bf027, 2026-10-21):**

- **Contracts** are written (bonds, charges, arbitration) and the demo traces encode against them in CI, but nothing has run on a chain: C3–C10 stay open until the live replay passes.
- **Services:** `services/api` has only `/health`; `packages/chain-client` covers the node, events, finality and the tx-builder client; `services/tx-builder` runs locally. No indexer, no `infra/`.
- **Design gaps built around** (decision log #37): organisation documents wait for #151, notifications (#86) for #59. #49 and #58–#60 affect only the UI.
- **No local Gajumaru chain** yet ([HLD §7](hld.md#7-open-questions)), so compose points at Groot testnet.

## Approach

### Architecture of the local stack (`infra/local/`)

| Container | Image | Notes |
| :--- | :--- | :--- |
| `postgres` | `postgres:17` (pinned digest) | Schemas `read` and `app`, one database role per service (ADR 0013: the indexer writes `read` only; the API can't alter `read`) |
| `minio` | MinIO (pinned) | An `evidence` bucket with versioning and object lock, created by a one-shot init container. Stands in for Hetzner Object Storage |
| `openbao` | OpenBao dev mode (pinned) | Transit engine for envelope encryption of evidence and personal data (ADR 0016 #21) |
| `tx-builder` | `services/tx-builder/Dockerfile`, built from the pinned toolchain (`contracts/tools/build-toolchain.sh`, #177) | A new `TX_BUILDER_BIND` setting, default `127.0.0.1`. Compose sets `0.0.0.0` on an internal-only network, with no published port |
| `api` | `services/api/Dockerfile` (multi-stage uv, non-root, read-only rootfs) | Published on `localhost:8000` |
| `indexer` | `services/indexer/Dockerfile` | No published port |

- **One command:** `docker compose -f infra/local/compose.yaml up --build`.
- Settings come from `infra/local/.env.example`, and the README documents them.
- Cloud deploy (I3, #74) reuses the same images. ADR 0016 also runs Docker Compose on Hetzner, behind Caddy, so the cloud version is an override file plus OpenTofu modules. That deploy is **out of scope here**; it gets its own plan.

### Interfaces fixed first

- The contract catalogue (`contracts/interface/*.aci.json`, `errors.json`) is the single source. The indexer projections, the API's error map and the relay's call shapes are all generated from it or checked against it. Nothing defines event shapes by hand.
- The API resources follow HLD §8 and the issue bodies:
  - `/quotes`, `/escrows/{id}` (actions)
  - `/grids/requests` (relay)
  - `/evidence`
  - `/sessions`, `/orgs`, `/feedback`
- Each action endpoint returns an **unsigned** GRIDS request (hard rule 1).

### Dependencies (each added with `uv add` and a reason in the commit)

| Dependency | Used for | Why this one |
| :--- | :--- | :--- |
| SQLAlchemy 2 (Core) with Alembic, psycopg 3 | Database access and migrations | Standard choices a mid-level developer will know |
| boto3 | S3 | Portable to Hetzner Object Storage |
| `webauthn` (py_webauthn, BSD) | Session unlock (ADR 0008) | |
| `opentelemetry-sdk`, `-exporter-otlp`, `-exporter-prometheus`, FastAPI, httpx and SQLAlchemy instrumentations | Telemetry (ADR 0017) | |

- OpenBao is reached over plain `httpx`, which is already in the tree, so it needs no extra client library.
- All of these are GPL-3-compatible.

### Every service is discoverable: OpenAPI spec and docs (project owner requirement, decision log #38)

- **What each service serves:**
  - `GET /openapi.json`, its OpenAPI 3.1 spec.
  - `GET /docs`, interactive docs.
  - `GET /health`.
- **API:**
  - FastAPI generates the spec.
  - Every route has a summary, a description, tags, typed request and response models, and its error responses. Errors use one `Problem` model (RFC 9457) whose `code` values come from `errors.json`.
  - The spec carries examples, and says which role may call each endpoint.
- **Indexer:**
  - It gets a small FastAPI ops surface: `/health`, plus `/status` with the cursor and lag in keyblocks.
  - It's internal only, with no published port in production.
- **tx-builder (Erlang):**
  - A hand-written `services/tx-builder/openapi.yaml` is served at `/openapi.json`.
  - Its docs come from the same file through a static Swagger UI page.
  - A test checks that every route in `tx_builder_http.erl` appears in the spec, and the reverse.
- **In the repo:**
  - `docs/api/` holds each service's exported spec plus an index page.
  - A CI check (`--check`, like the contract catalogue) fails if an exported spec drifts from the running code. That way reviewers see API changes in diffs.
- **Tests:** a pytest walks each FastAPI app's routes and fails on any route that has no summary, no response model, or undocumented error responses.
- **Security:**
  - The specs are public. They hold no secrets and describe only the endpoints, and authorisation does the protecting.
  - Internal services (tx-builder, indexer) serve their docs only on the internal network.

### OpenTelemetry and Prometheus as first-class citizens (project owner requirement; amends ADR 0017, decision log #39)

The goal: SRE can monitor every service from the first commit, and the local stack runs the same telemetry pipeline as the cloud.

**Each service emits:**
- **Traces:** OTel traces (OTLP), with W3C `traceparent` propagated API → tx-builder → node calls, and API → relay → indexer through the transaction hash.
- **Metrics:** OTel metrics, also exposed as Prometheus text on `GET /metrics` through the OTel Prometheus exporter.
- **Logs:** structured JSON logs carrying `trace_id`, `span_id` and a correlation id, never secrets or personal data.
- **Probes:** `/health` (liveness) and `/ready` (readiness, which checks dependencies: database, tx-builder, node, OpenBao).

**What each service measures:**
- **API:** RED metrics per route (`http.server.request.duration`). The ADR 0017 SLIs are named exactly as there: `gf.signing.*`, `gf.tx.*`, `gf.evidence.*`, `gf.keys.*`, `gf.webhook.events`.
- **Indexer:** `gf.indexer.lag`, `gf.payout.latency`, `gf.escrow.near_deadline`, `gf.node.*`, and a reorg counter.
- **tx-builder:**
  - A hand-written Prometheus `/metrics`: request count and latency per route, dry-run and node errors.
  - `traceparent` is read and logged.
  - No Erlang OTel SDK, to keep its pinned supply chain small (G1). If SRE needs spans from inside it, that's a later, separate decision.

**Pipeline, the same locally and in the cloud:**
- Grafana Alloy receives OTLP and scrapes every `/metrics`, plus the container, host, Postgres, MinIO and OpenBao metrics.
- **Locally,** Alloy exports to `grafana/otel-lgtm` (Grafana, Prometheus-compatible Mimir, Loki and Tempo in one container) in a compose `observability` profile that's on by default.
- **In the cloud,** only Alloy's endpoint changes, to Grafana Cloud (ADR 0017 decision 2).

**As code, under `infra/observability/`:**
- **Alloy configuration.**
- **Prometheus-format alert rules** for every ADR 0017 alert, loadable into Grafana Cloud's ruler. Thresholds are placeholders until the pilot data sets them.
- **Grafana dashboards,** provisioned locally: the service overview (RED), indexer and finality, signing funnel, and evidence and keys.
- **Tests:** `promtool check rules` and a unit test per rule (`promtool test rules`).

**Docs and ownership:**
- `docs/observability.md` is the metric catalogue (name, type, unit, labels, owner). Labels stay low-cardinality: never shipment or transaction ids.
- Each alert links a runbook stub in `docs/runbooks/`, which R3 (#103) fills in.
- The `sre` skill is loaded for the observability PR and reviews every service PR's telemetry.

### Security from the start

- **Security review:** `security-consultant` reviews the relay, evidence and session PRs against the threat model, including the G2–G4 gaps (rate limits and size caps).

## PR split (no more than 5 open at once; each gets an independent pragmatic-programmer review)

| # | Branch | Issues | Skills | Content | Status |
| :-: | :--- | :--- | :--- | :--- | :--- |
| 0–2 | `chore/m1-plan-decisions` (#180) | I1 #72, C3–C10 #63–#70 | infra, security, sophia-contracts, sdet | **Combined at the project owner's request (2026-10-21), as the work is interleaved.** Contents: the `.gitignore` change and decisions #35–#40; the compose stack, Dockerfiles (api, tx-builder), MinIO and OpenBao init, `.env.example`, README, `TX_BUILDER_BIND`; throwaway keys in `gaju-private/`; the live trace replay on testnet, closing C3–C10 with gas recorded | In progress (draft) |
| 3 | `feat/deploy-contracts` | C11 #71 | infra, sophia-contracts | Scripted deploy in the ADR 0011 order, idempotent; a manifest with addresses, compiler version and source hashes; `docs/runbooks/deploy-contracts.md`; the first testnet deploy | Not started |
| 3a | `feat/openapi-docs` | — | backend, infra | The `Problem` error model, the route-documentation test, the `docs/api/` export and drift check, and the tx-builder `openapi.yaml` and docs route. Lands before PR 4 so every later service PR inherits it | Not started |
| 3b | `feat/observability-baseline` | R1 #101 (most of it), R2 #102 (part) | sre, backend, infra | A shared `gajufreight_telemetry` workspace package (OTel setup, Prometheus exporter, JSON logging, correlation-id middleware, `/health` and `/ready` helpers); tx-builder `/metrics` and `traceparent`; Alloy and `otel-lgtm` in compose; alert rules with promtool tests; dashboards; `docs/observability.md`; runbook stubs; ADR 0017 amended. Lands before PR 4, so every service PR adds its metrics through it | Not started |
| 4 | `feat/chain-client-blocks` | B1 #75 | backend | Walk microblocks, SSE with polling as the fallback, mined-state nonces | Not started |
| 5 | `feat/tx-builder-service` | B2 #76 | backend | Shared test vectors with the C-series, a reproducible pinned image (closes H5 #146 for the container) | Not started |
| 6 | `feat/indexer` | B4 #78 | backend, sdet | `services/indexer`: discovery from `QuoteCreated` and `EscrowBooked`, projections into `read`, a cursor, reorg handling (finality rule per network), replay from genesis, a lag metric | Not started |
| 7 | `feat/read-model-api` | B5 #79, B7 #81 | backend, security | Query API with role filters, and the role × status authorisation layer | Not started |
| 8 | `feat/evidence-store` | B6 #80 | backend, security | Bundle schema v1, canonical JSON (RFC 8785) SHA-256, digest checks on upload and read, envelope encryption through OpenBao, signed URLs | Not started |
| 9 | `feat/grids-relay` | B3 #77 | backend, security | Dead-drop relay, one open request per account, nonce manager, pending → final | Not started |
| 10 | `feat/sessions` | B8 #82 | backend, security | Wallet sign-in challenge, server-side sessions, WebAuthn and PIN unlock, revocation | Not started |
| 11 | `feat/organisations` | B9 #83 (no documents) | backend | Organisations, members, directory, manual verification queue linked to ADR 0019 | Not started |
| 12 | `feat/booking-endpoints` | B10 #84 | backend | Quote request, quote, counter, decline, accept and book, as unsigned GRIDS requests with store-then-sign | Not started |
| 13 | `feat/execution-endpoints` | B11 #85 | backend | Custody scans, delivery code, confirmation and cancel, disputes, refunds, charges | Not started |
| 14 | `feat/feedback` | B13 #87 | backend, security | `POST /feedback` → GitHub issue, rate-limited | Not started |
| 15 | `test/m1-exit` | T1 #88 | sdet | An end-to-end harness through the compose stack against testnet, using the throwaway keys as "wallets" (a test signer outside the services); the M1 exit run | Not started |

- **Parallel lanes:** contracts (PRs 2→3), platform (PR 1), and services (PRs 4→5→6→…, stacked).
- **Deferred:** B12 notifications (#86, waits for #59), organisation documents (waits for #151), I2 CI against a local chain (waits for QPQ), I3 cloud deploy (its own plan next).

## Tests

- **Every PR:** the Python gate (`ruff`, `mypy --strict`, `pytest --cov`) and `npm run check --prefix scripts/ci`.
- **Services:** unit tests against recorded node fixtures. Integration tests run in compose (Postgres, MinIO, OpenBao) with a `-m integration` marker. CI runs them only where Actions minutes allow, otherwise locally.
- **Contracts:** the replay checks outcome, events, errors and balances against the demo model, including conservation in every terminal state.
- **Indexer:** a reorg test (drop a microblock; the model corrects itself), and a replay that produces an identical read model.
- **Authorisation:** an endpoint × role × status test table.

## Risks

- **Testnet:** a single miner and slow inclusion make the replay and the M1 exit slow or flaky. Mitigation: run them nightly or on demand, never per PR.
- **Contract bugs found by the replay:** a fix that changes an interface goes through all layers in the same PR.
- **Erlang tx-builder container:** the Hakuzaru and Sophia build may be fiddly to containerise. The pinned toolchain from #177 is the base.
- **Docker:** compose runs on Colima (decision log #35); CI doesn't run the stack yet (I2 waits for a local chain).

## Verification (M1 exit)

1. `colima start && docker compose -f infra/local/compose.yaml up --build`. All containers are healthy, `curl localhost:8000/health` returns ok, and `localhost:8000/docs` shows the documented API. The internal services' `/openapi.json` respond from inside the network.
2. The spec drift check and the route-documentation test pass.
2a. Grafana on `localhost:3000` shows traces that run from an API request through the tx-builder. Every service's `/metrics` is scraped (Prometheus `up == 1`), and the dashboards and alert rules load. Stopping the indexer makes the lag alert fire. `promtool test rules` passes.
3. `uv run pytest -m integration` passes against the stack.
4. The `test/m1-exit` script books, funds, scans, delivers and pays out one shipment on Groot testnet through the API's GRIDS requests only. Balances match the agreed terms.
5. Drop the `read` schema, restart the indexer, and the read model matches its snapshot from before the drop.
6. The decision log has entries #35–#40 (the three decisions above, OpenAPI for every service, OTel and Prometheus first-class (amending ADR 0017), and the dependencies). The blueprint and the README are updated in the same PRs.

## Progress log

Newest last. One line per session or PR: date, what moved, what's next.

| Date | Progress | Next |
| :--- | :--- | :--- |
| 2026-10-21 | Plan approved; decisions #35–#40 logged; PRs 0–2 combined into #180 | Compose stack, then the live testnet replay |
