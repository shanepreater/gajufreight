# Contracts

GajuFreight's Sophia contracts and their toolchain ([ADR 0014](../docs/adr/0014-contract-toolchain.md)). The design they implement is [HLD §5](../docs/hld.md#5-contract-sketch-sophia).

| Path | What it is |
| :--- | :--- |
| `src/` | `platform.aes`, `quote-request.aes`, `shipment-escrow.aes`: the source of truth |
| `networks/` | Per-network settings: network id, node, and the platform address the build substitutes for `PLATFORM_ADDRESS` (`build.json` is a placeholder for compile checks) |
| `interface/` | The generated catalogue: each contract's ACI and `errors.json`. Read by the demo now, and by `chain-types`, the API and the indexer later. The human-readable version is [docs/contract-interface.md](../docs/contract-interface.md) |
| `tools/build-sophia.sh` | Builds Sophia 9.0.0 from pinned public sources (what CI uses) |
| `tools/build.escript` | Compiles the contracts for a network into `build/<network>/` (bytecode, ACI, manifest), and writes the catalogue |
| `spike/` | The Phase 0 probe contracts and runner ([spike results](../docs/spikes/phase-0-testnet.md)) |

```sh
escript contracts/tools/build.escript                    # compile for "build", write the catalogue
escript contracts/tools/build.escript --check            # what CI runs: fail if the catalogue drifts
escript contracts/tools/build.escript --network testnet  # once Platform is deployed there
```

The compiler comes from your zx packages (GajuDesk), or from a pinned build: `contracts/tools/build-sophia.sh ~/sophia`, then `SOPHIA_LIBS=~/sophia`. Both give byte-identical bytecode. Change a contract, rebuild, and commit the updated catalogue with it.
