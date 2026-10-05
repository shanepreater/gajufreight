# Phase 0 spike probes

Throwaway contracts that check QPQ's answers on Groot testnet. They are **not** the Phase 1 contracts: no tests, no invariants, no reuse. The procedure and results are in [docs/spikes/phase-0-testnet.md](../../docs/spikes/phase-0-testnet.md).

| File | Contracts | Experiments |
| :--- | :--- | :--- |
| [probe-escrow.aes](probe-escrow.aes) | `ProbeEscrow` | E2 funded create, E5 gas, E6 `Chain.spend`, E7 events, E8 `Crypto.blake2b` |
| [probe-factory.aes](probe-factory.aes) | `ProbeChild`, `ProbeFactory` (main) | E3 `Chain.create`, E4 funded `Chain.clone`, E5 gas |

`Chain.create` needs the child's code in the same file, so `ProbeChild` is defined inside `probe-factory.aes`.

[run-probes.escript](run-probes.escript) runs E2–E8 and E10 against testnet with a throwaway key kept outside the repo, using the newest Hakuzaru and Sophia that GajuDesk installs:

```sh
escript contracts/spike/run-probes.escript <key-file>
```

Compile locally with the Sophia 9.0.0 that GajuDesk installs (`ZOMP_DIR` is usually `~/.zx/zomp`):

```sh
L=$ZOMP_DIR/lib/otpr
erl -noshell -pa $L/sophia/9.0.0/ebin $L/gmbytecode/*/ebin $L/gmserialization/*/ebin \
  $L/eblake2/*/ebin $L/base58/*/ebin \
  -eval '[io:format("~s: ~p~n", [F, element(1, so_compiler:file(F, []))]) || F <- ["probe-escrow.aes", "probe-factory.aes"]], halt().'
```
