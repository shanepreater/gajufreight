# ADR 0014: Contract toolchain and test harness

| | |
| :--- | :--- |
| **Status** | Accepted (decided 2026-10-09, [decision log](../decision-log.md) #17). The test chain (decision 3) stays provisional: batched testnet runs until QPQ answer whether a local node is available (asked again 2026-10-09) |
| **Last reviewed** | 2026-10-09 |
| **Related** | [Dev approach §2, §4](../dev-approach.md#2-repository-layout) · [Design audit F23, F26](../design-audit.md) · [HLD §5](../hld.md#5-contract-sketch-sophia) · [Implementation blueprint](../implementation-blueprint.md) (D12 #50, C1 #61, C9 #70) · [QPQ Q&A](../qpq-q-and-a.md#local-chain) |

## Context

Phase 1 needs to compile, build and test the contracts, in CI as well as locally. Until now the Sophia compiler has come only from the zx packages that GajuDesk installs. QPQ were asked for a stand-alone compiler for CI (Sophia follow-up 1), with no answer yet. Contract tests also need a chain to run on, but no public Gajumaru node or "GM Demo Chain" package could be found (2026-10-07). QPQ's git host needs a login, and the zx registry timed out.

## Decision

1. **Compiler: Sophia 9.0.0, built from pinned public sources.**
   - [`contracts/tools/build-sophia.sh`](../../contracts/tools/build-sophia.sh) builds the compiler and its whole dependency set from fixed commits (below). Locally, the zx packages can be used instead.
   - CI runs it on OTP 27 (`erlef/setup-beam`, pinned to a commit), caching the build by the script's hash.
   - `getopt` isn't needed: it serves only the command-line tool.

   | Package | zx version | Source | Commit |
   | :--- | :--- | :--- | :--- |
   | sophia | 9.0.0 | gitlab.com/zxq9/sophia | `b551a84cdc4933c6d23dbf0ab9b67891dd6d1143` |
   | gmbytecode | 3.4.1 | gitlab.com/zxq9/gmbytecode | `691b9742bf7e4aa6a4e8e209397916be5abe1763` |
   | gmserialization | 0.1.3 | gitlab.com/zxq9/gmserialization | `ac64e01b0f675c1a34c70a827062f381920742db` |
   | zj | 1.1.0 | gitlab.com/zxq9/zj | `6f83e4e8d0becf0fac39404e20e1285988841f91` |
   | base58 | 0.1.1 | gitlab.com/zxq9/erl-base58 | `e6aa62eeae3d4388311401f06e4b939bf4e94b9c` |
   | eblake2 | 1.0.1 | github.com/aeternity/eblake2 | `60a079f00d72d1bfcc25de8e6996d28f912db3fd` |

   **Evidence (2026-10-07):**
   - Each commit's source matches the zx package, apart from zx's packaging changes: include paths rewritten, `-vsn` lines stamped in, and four `gmbytecode` modules it generates at build time.
   - Compiled with both builds, all twelve contracts we have, the nine spike probes and the three HLD §5 contracts, give **byte-identical bytecode** (SHA-256 compared).
2. **Build:** [`contracts/`](../dev-approach.md#2-repository-layout) holds the sources, tools, per-network settings and the generated interface catalogue (C1 #61, C2 #62).
   - The build substitutes each network's `PLATFORM_ADDRESS`, and writes the bytecode, the ACI, and a manifest recording the compiler commit and the source and bytecode hashes.
   - CI adds one compile step to the existing Quality gate job (no new jobs), and fails if the committed catalogue differs from a fresh build.
3. **Test chain (provisional):**
   - **A, preferred: a local Gajumaru node, or the GM Demo Chain, from QPQ.** It's needed for the contract tests (every entrypoint × role × status) to run in minutes. We've asked QPQ ([Q&A](../qpq-q-and-a.md#local-chain)).
   - **B, until A exists: Groot testnet with throwaway keys, for batched runs only.**
     - These are the M1 exit run, a differential suite on `main` (on a schedule, never on every PR), and deployments.
     - Testnet has one miner, and inclusion can take minutes (spike round 2), so the per-entrypoint suites wait for A or run in large batches.
   - **Fast feedback meanwhile** comes from the demo model (C10), whose tests run in seconds, and from the differential tests below.
4. **Differential tests (design audit F26, C9 #70):** the same seeded random call sequences run against the demo model and the real contracts, and every outcome, balance and error code must agree. The demo model is the oracle, so it must match HLD §5 (C10 #69).

## Consequences

- **Good:**
  - CI compiles contracts with no GajuDesk and no network access beyond the source hosts, reproducibly, from content-pinned commits.
  - The compiler CI uses is shown to be the one developers use.
  - C1 can start now.
- **Cost:**
  - OTP and a short source build are added to CI, cached so they rebuild only when the script changes.
  - We follow QPQ's mirrors: a mirror that moves or disappears needs a new pin. The full commit hashes mean a moved branch can't change what we build.
- **Risk:**
  - Without a local node, contract tests are slow (B), and the C3–C8 suites may wait for QPQ.
  - If QPQ publish a stand-alone compiler package, we can switch to it and keep the byte-identical check as its test.
- **Not decided here:** the Erlang naming convention for services, which comes with the tx-builder service (#54).
