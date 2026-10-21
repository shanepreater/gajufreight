# Local stack

The whole GajuFreight backend on one laptop with one command: the `local` environment in the [deployment plan](../../docs/deployment-plan.md) (I1 [#72](https://github.com/shanepreater/gajufreight/issues/72)). The chain is Groot testnet until QPQ offer a local chain ([ADR 0014](../../docs/adr/0014-contract-toolchain.md)).

## Start

Needs a Docker engine and Compose. On macOS we use Colima ([decision log](../../docs/decision-log.md) #35):

```sh
brew install colima docker docker-compose
colima start --cpu 4 --memory 8
```

Then, from the repo root:

```sh
infra/local/init-env.sh                                    # once: random credentials into infra/local/.env
docker compose -f infra/local/compose.yaml up --build -d   # first build of the tx-builder takes a few minutes
curl localhost:8000/health                                 # {"status":"ok",...}
open http://localhost:8000/docs                            # the API's docs
docker compose -f infra/local/compose.yaml down            # stop; add -v to delete the data too
```

## What runs

| Service | What it is | From the host |
| :--- | :--- | :--- |
| `api` | [services/api](../../services/api) | `127.0.0.1:8000` |
| `tx-builder` | [services/tx-builder](../../services/tx-builder/README.md), built for `CONTRACTS_NETWORK` | Not published: only the stack's services reach it |
| `postgres` | PostgreSQL 17: schema `read` owned by `gf_indexer`, schema `app` owned by `gf_api`, which can only read `read` ([ADR 0013](../../docs/adr/0013-off-chain-data.md), [init-roles.sh](postgres/init-roles.sh)) | `127.0.0.1:5432` |
| `s3` | Versity Gateway: the evidence store's stand-in, with versioning and object lock ([decision log](../../docs/decision-log.md) #41) | `127.0.0.1:7070` |
| `openbao` | OpenBao in dev mode: the transit engine and the `evidence` key ([ADR 0016](../../docs/adr/0016-hosting-and-environments.md)). In memory, so keys reset on restart | `127.0.0.1:8200` |
| `s3-init`, `openbao-init` | One-shot jobs: the evidence bucket with object lock, and the transit key. Safe to re-run | — |

The indexer joins the stack when it's built ([M1 build plan](../../docs/m1-build-plan.md), PR 6).

## Settings

**No credential is committed.** [`init-env.sh`](init-env.sh) writes `infra/local/.env` (gitignored, owner-only) with random passwords, S3 keys and an OpenBao token for this machine, and Compose refuses to start without them. The stack holds no real keys and no user keys (hard rule 1). Every other setting has a working default; to change one, add it to that `.env` ([`.env.example`](.env.example) lists them).

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `NODE_URL`, `NODE_HOST_PORT` | Groot testnet | The node the API and the tx-builder use |
| `CONTRACTS_NETWORK` | `build` | Which `contracts/networks/<name>.json` the tx-builder image is built for. `build` has a placeholder platform address; switch to `testnet` once Platform is deployed there ([#71](https://github.com/shanepreater/gajufreight/issues/71)) and rebuild |
| `POSTGRES_PASSWORD`, `API_DB_PASSWORD`, `INDEXER_DB_PASSWORD` | Generated | Database passwords. The roles are created only when the volume is new, so after regenerating them run `down -v` |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY` | Generated | Evidence store credentials |
| `BAO_TOKEN` | Generated | OpenBao's dev root token |
| `S3_BUCKET` | `evidence` | Evidence bucket |
| `API_PORT`, `POSTGRES_PORT`, `S3_PORT`, `BAO_PORT` | `8000`, `5432`, `7070`, `8200` | Host ports, bound to 127.0.0.1 |

## In the cloud

The same images run on Hetzner with Docker Compose behind Caddy ([ADR 0016](../../docs/adr/0016-hosting-and-environments.md)), with Neon, Hetzner Object Storage and a production OpenBao in place of the local stand-ins. That deployment is I3 ([#74](https://github.com/shanepreater/gajufreight/issues/74)).
