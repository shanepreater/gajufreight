# Ecosystem Reference Guide

A quick map of the Gajumaru components GajuFreight depends on or interacts with. Full citations are in [sources.md](sources.md).

## 1. Gajumaru building blocks

| Component | What it is | How GajuFreight uses it |
| :--- | :--- | :--- |
| **Groot** | Proof-of-work root chain (Bitcoin-NG style: ~2-min keyblocks, ~3-s microblocks). The resource layer for Gaju. | MVP deployment target. Final settlement. |
| **Associate Chains (ACs)** | Chains with their own consensus, linked to Groot by a deposit/withdrawal protocol. Groot doesn't see what happens inside an AC. | Possible later target for cheaper, faster milestones. |
| **Sophia** | Strongly typed functional contract language (`.aes`). | `ShipmentEscrow` and factory contracts. |
| **FATE VM** | Fast Arboreal Transaction Engine, which runs compiled Sophia. | Runtime for our contracts. |
| **GRIDS** | Air-gapped signing: instructions are passed to a wallet as QR/URL payloads, so keys never touch the app. One instruction per message; a contract call's payload is its unsigned call data ([QPQ Q&A](qpq-q-and-a.md#grids)). | Every user action that needs a signature. |
| **GajuPay** | QR payment flow. The merchant watches microblocks for a matching (recipient, amount, reference) transaction. | Pattern for our settlement watcher. |
| **GajuMarket** | Escrow-based marketplace built on contract clones. | Reference design for escrow and fees. |
| **Data TTL** | How long a chain object stays on-chain after inclusion, in block heights. Not yet enforced on Groot ([QPQ Q&A](qpq-q-and-a.md#data-ttl)). | Not relied on. Possibly for pruning settled shipment state later. |
| **State channels** | Off-chain channels for high-frequency payments. | Not in the MVP. Could suit per-leg micro-payments. |

## 2. Tools

| Tool | Purpose |
| :--- | :--- |
| **GajuDesk** | Desktop wallet and contract workbench: write, compile, test and inspect Sophia contracts. GPL3. |
| **GajuMobile** | Mobile wallet. Scans GRIDS codes. |
| **Hakuzaru (`hz`)** ([GitLab mirror](https://gitlab.com/zxq9/hakuzaru)) | Erlang library behind GajuDesk. The best reference for the node HTTP API, which is the integration point for every language (there's no SDK). Public endpoints are in the [QPQ Q&A](qpq-q-and-a.md#node-api). |
| **Sophia compiler** ([GitLab mirror](https://gitlab.com/zxq9/sophia), [docs](https://gajumaru.io/docs/sophia/)) | Version 9.0.0, as packaged with GajuDesk, is the current standard. |
| **GM Demo Chain** | Local Groot plus AC setup for development and testing. |
| **Testnet faucet** ([faucet.testnet.gajumaru.io](https://faucet.testnet.gajumaru.io)) | Issues test Gaju in response to a GRIDS-signed request. Used to pay gas for testnet deployments. |
| **Onboarding repo** ([shanepreater/gajumaru](https://github.com/shanepreater/gajumaru)) | Install scripts (`quick-start.sh`) and environment setup. |

## 3. Developer setup checklist

1. Run the onboarding scripts from `shanepreater/gajumaru`.
2. Install GajuDesk and create a testnet account.
3. Request test Gaju from the [testnet faucet](https://faucet.testnet.gajumaru.io) (you sign the request with GRIDS).
4. Start a local demo chain (Groot plus one AC) for contract tests.

## 4. Deploying contracts to testnet

Confirmed by the QPQ dev team ([sources](sources.md) #9). We also deploy from a script with the same libraries; see [scripted contract deployment](scripted-contract-deployment.md):

1. Create or select a testnet account in **GajuDesk**.
2. Fund it from the [testnet faucet](https://faucet.testnet.gajumaru.io). The test Gaju pay for deployment and call gas.
3. Open the compiled Sophia contract (`.aes`) in GajuDesk, deploy it to testnet, and record the contract address, compiler version and source hash in the deployment manifest ([infra skill](../.claude/skills/infra/SKILL.md)).

## Appendix: running a mining node (optional)

You don't need to mine to develop GajuFreight. It's only relevant if you run your own Groot node.

- Site: [gajumining.com](https://gajumining.com)
- Worker binaries: `mean29-*` (≈3 GB RAM, faster), `lean29-*` (≈1 GB RAM), `cuda29` (GPU). `-avx2` builds need AVX2 CPU support; `-generic` builds run on any CPU.
- Client config: `/usr/local/gajuminer/gmhive_client_config.json`
