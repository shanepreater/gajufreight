# Phase 0 spike probes

Throwaway contracts that check QPQ's answers on Groot testnet. They are **not** the Phase 1 contracts: no tests, no invariants, no reuse. The procedure and results are in [docs/spikes/phase-0-testnet.md](../../docs/spikes/phase-0-testnet.md).

| File | Contracts | Experiments |
| :--- | :--- | :--- |
| [probe-escrow.aes](probe-escrow.aes) | `ProbeEscrow` | E2 funded create, E5 gas, E6 `Chain.spend`, E7 events, E8 `Crypto.blake2b` |
| [probe-factory.aes](probe-factory.aes) | `ProbeChild`, `ProbeFactory` (main) | E3 `Chain.create`, E4 funded `Chain.clone`, E5 gas, E11 `Chain.bytecode_hash` |
| [probe-caller.aes](probe-caller.aes) | `ProbeCaller` | E11b: the factory reads the caller's bytecode hash while the caller is in `init` |
| [probe-init.aes](probe-init.aes) | `ProbeInit` | E2b: what `init` sees of a create's amount (`Call.value` is 0; `Contract.balance` holds it) |
| [probe-payability.aes](probe-payability.aes) | `ProbePayability` | Round 2, E12: `Chain.spend(a, 0)` and `Address.is_payable` |
| [probe-sized-escrow.aes](probe-sized-escrow.aes) | `ProbeSizedEscrow` | Round 2, E14 and E18: the HLD escrow's own logic (4.4 KB) for realistic create and clone costs |
| [probe-booker.aes](probe-booker.aes) | `ProbeBooker` | Round 2, E14 and E15: clones the sized escrow, funded, as `Platform.book` would; E9's signed call |
| [probe-leg.aes](probe-leg.aes), [probe-handover.aes](probe-handover.aes) | `ProbeLeg`, `ProbeHandover` | Round 2, E16: whether one contract call can make a handover's two calls for its signer |
| [grids_dead_drop.py](grids_dead_drop.py) | — | Round 2, E9: a local GRIDS dead drop that GajuDesk fetches requests from and posts responses to |

`Chain.create` needs the child's code in the same file, so `ProbeChild` is defined inside `probe-factory.aes`.

[run-probes.escript](run-probes.escript) runs E2–E8, E10, E11 and E11b against testnet with a throwaway key kept outside the repo, using the newest Hakuzaru and Sophia that GajuDesk installs:

```sh
escript contracts/spike/run-probes.escript <key-file>          # round 1
escript contracts/spike/run-probes.escript <key-file> round2   # E12, E14–E17
escript contracts/spike/run-probes.escript <key-file> fees     # E18
```

E9 signs in a real wallet, with no key in the runner. Build one request at a time for the signer's next nonce, serve it, sign it in GajuDesk with **GRIDS URL** → `grid://localhost:8765/1/d/<name>.json`, then check and submit the response:

```sh
python3 contracts/spike/grids_dead_drop.py <dir> 8765 &
R=book-$(openssl rand -hex 16)   # the dead drop only serves token names
escript contracts/spike/run-probes.escript grids-build book <signer> <dir>/$R.json <booker> <template>
escript contracts/spike/run-probes.escript grids-submit <dir>/$R.json <dir>/$R.signed.json
```

`grids-build` also takes `create` and `message` (a sign-in challenge). For a phone (E9b), the dead drop must be HTTPS, because GajuMobile refuses plain HTTP. Expose it through a temporary tunnel (for example a Cloudflare quick tunnel) and open `grids://<tunnel-host>/1/d/<name>.json`.

**Name every request with a random token**, as `<label>-$(openssl rand -hex 16).json`. The dead drop serves and accepts only such names, so knowing the tunnel host isn't enough to read a request or to answer it before the wallet does. A response must also name the request's signer and type, and the first valid one claims the slot atomically. That makes the drop a capability URL, as ADR 0012 specifies for the real relay; it is still a spike tool. Keep the tunnel up only for the test. `grids-submit` refuses a response whose inner transaction differs from the one built, or whose signature isn't the signer's.

Compile locally with the Sophia 9.0.0 that GajuDesk installs (`ZOMP_DIR` is usually `~/.zx/zomp`):

```sh
L=$ZOMP_DIR/lib/otpr
erl -noshell -pa $L/sophia/9.0.0/ebin $L/gmbytecode/*/ebin $L/gmserialization/*/ebin \
  $L/eblake2/*/ebin $L/base58/*/ebin \
  -eval '[io:format("~s: ~p~n", [F, element(1, so_compiler:file(F, []))]) || F <- ["probe-escrow.aes", "probe-factory.aes", "probe-caller.aes", "probe-init.aes"]], halt().'
```
