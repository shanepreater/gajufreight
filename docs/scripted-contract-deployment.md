# Scripted contract deployment (note for QPQ)

| | |
| :--- | :--- |
| **Status** | Working on Groot testnet (2026-10-05); not yet used for mainnet |
| **Last reviewed** | 2026-10-05 |
| **Related** | [Phase 0 spike](spikes/phase-0-testnet.md) · [QPQ Q&A](qpq-q-and-a.md) · [runner](../contracts/spike/run-probes.escript) |

GajuFreight deploys and calls Sophia contracts on Groot testnet from a script rather than from GajuDesk. We'd value your view on whether this is a sound approach, and on the questions at the end.

## How it works

The script is an Erlang escript, [run-probes.escript](../contracts/spike/run-probes.escript). It uses the libraries GajuDesk installs through zx (`~/.zx/zomp/lib/otpr`), taking the newest version of each package. We use them as dependencies and don't copy them into our repo.

| Step | How |
| :--- | :--- |
| Compile | `so_compiler:file(Path, [{aci, json}])`, Sophia 9.0.0 |
| Build | `hz:contract_create_built/8` (with an amount) and `hz:contract_call/10`, Hakuzaru 0.9.1. Nonce from `GET /accounts/{id}` (`nonce + 1`), gas 5,000,000, gas price 10⁹, TTL = top height + 1,000 |
| Sign | `hz:sign_tx/3` with the network ID, using a throwaway testnet key held only on the developer's machine |
| Submit | `hz:post_tx/1` to `http://groot.testnet.gajumaru.io:3013/v3` |
| Confirm | Poll `GET /transactions/{hash}/info`; decode `return_value` with `gmser_api_encoder:safe_decode(contract_bytearray, …)` and `gmb_fate_encoding:deserialize/1` |
| Estimate | `hz:dry_run/1` for gas before signing |

**Production:** testnet and CI will use the same pattern, with a deployer key from a secret store and a manifest recording each contract's address, compiler version and source hash. For mainnet we plan to have the script build the unsigned transaction and a GajuFreight admin wallet sign it over GRIDS, so no mainnet key sits in automation. End users always sign in their own wallets.

## What we found that may be useful to you

1. **In `init`, `Call.value` is 0 and `Contract.balance` already holds the amount attached to the create.** This is the same for a create transaction, `Chain.create(value = …)` and `Chain.clone(ref = …, value = …)`. We now check funding against the balance. Is this intended? Sophia also rejects `payable` on `init`.
2. **A spend to a non-payable contract returns `error`, not `revert`, and uses all the gas supplied:** 4,817,360 of 5,000,000 in `th_2vvy3D9r32ymqAMvzNVh5oAvgw2ZScMigCXcLeoUd72Q9SCsEa`.
3. **A transaction posted from an account with no balance stays pending on the public nodes but is never mined.** It then blocks every later nonce, because `/accounts/{id}/next-nonce` counts it. A funded transaction at the same nonce cleared it. Taking the nonce from the mined account state avoids the problem.
4. **`POST /dry_run` returned `Internal server error`** on both public testnet nodes while the calling account didn't exist yet. Once the account existed, it gave an exact estimate (3,686 gas for a 3,686-gas call).
5. **`/status` reports `finalized` at height 0** (genesis) on testnet.
6. **`referrer_ids` is empty** for both a created and a cloned contract. `Chain.bytecode_hash` identifies clones of a template reliably, including from a contract whose caller is still in `init`.
7. **GajuDesk 0.9.0:** it crashes on deploying a contract with no explicit `init` (`{badkey,"init"}` in `gd_v_call:init/1`), and a blank argument field gives `{error,[{1,"expected",unexpected_end_of_file}]}`.

Gas figures and transaction hashes for all of these are in the [spike results](spikes/phase-0-testnet.md#results).

## Questions

These are also tracked as follow-ups in the [QPQ Q&A](qpq-q-and-a.md): Node API 6, Sophia 1, Contract creation 3, Node API 4 and Node API 2.

1. Is a scripted deploy built on Hakuzaru the approach you'd recommend, or is there something better (the utility node plugin, or an HTTP compile endpoint)?
2. Is there a stand-alone Sophia 9 compiler package we can pin in CI, without installing GajuDesk?
3. Is finding 1 (`Call.value` in `init`) intended, and will it stay that way?
4. For a production service, should we run our own node rather than use the public endpoints?
5. How should a client decide a transaction is final, given finding 5?
