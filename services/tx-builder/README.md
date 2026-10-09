# tx-builder

Builds unsigned Gajumaru transactions for wallets to sign over GRIDS, with fee estimates, FATE hashes and event decoding ([ADR 0012](../../docs/adr/0012-transaction-building-and-grids-relay.md)). It's an Erlang OTP application on Hakuzaru and the Sophia compiler, used as libraries from the zx packages GajuDesk installs, not copied (hard rule 6). It **holds no keys** and listens on **127.0.0.1 only**. Python services use it through `gajufreight_chain.tx_builder`.

## Run

```sh
escript contracts/tools/build.escript --network testnet        # once Platform is deployed there
TX_BUILDER_CONTRACTS=contracts/build/testnet services/tx-builder/run.sh
```

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `TX_BUILDER_CONTRACTS` | none | Directory of the network's built `.aes` sources; each is compiled at start-up |
| `TX_BUILDER_NODE` | `groot.testnet.gajumaru.io:3013` | Node `host:port` |
| `TX_BUILDER_PORT` | `8790` | Port on 127.0.0.1 |
| `TX_BUILDER_FIXED_CHARGE_GAS` | `182600` | The fixed charge a contract call carries beyond execution gas (spike E18) |
| `TX_BUILDER_CREATE_BASE_GAS` | `88000` | A create's base charge beyond execution gas (E18) |
| `TX_BUILDER_CREATE_GAS_PER_KB` | `11500` | A create's charge per 1,000 bytes of code and source (E18: about 11.5 per byte) |

## API

| Request | Body | Returns |
| :--- | :--- | :--- |
| `GET /health` | — | `status`, loaded `contracts` |
| `POST /calls` | `contract`, `contract_name`, `function`, `args` (Sophia literals), `caller`; optional `amount`, `nonce`, `ttl`, `gas`, `dry_run` | `tx` (unsigned `tx_…`), `nonce` (from mined state), `ttl`, `dry_run_gas`, `fee_estimate` (puck) |
| `POST /creates` | `contract_name`, `args`, `caller`; optional as above | as above |
| `POST /hash` | `parts`: `[{contract_name, function, argument, value}]` | `hash` (`#…`), the blake2b of the value's FATE serialisation; several parts hash as a tuple |
| `POST /events/decode` | `contract_name`, `log` (as the node returns it) | `[{event, address, fields}]` |

A missing field, a field of the wrong type or an unknown contract is a 400 with the reason.

**Fee estimate:** `(dry-run gas + fixed charge) × gas price`. A dry run reports execution gas only (E18), and the fixed charge grows slightly with transaction size, so the estimate runs about 1% low for larger calls (a booking: 1.989 × 10¹⁴ puck estimated, 2.013 × 10¹⁴ measured). A create's charge is instead the base plus its size in code and source: for the 4.4 KB escrow with 7.4 KB of source that's about 223,700 gas, which matches the 2.23 × 10¹⁴ puck E14 measured.

## Test

```sh
services/tx-builder/test.sh     # no network: builds match Hakuzaru's, hashes match the chain's (E8), events, HTTP
TX_BUILDER_URL=http://127.0.0.1:8790 uv run pytest -m live packages/chain-client   # against a running service
```
