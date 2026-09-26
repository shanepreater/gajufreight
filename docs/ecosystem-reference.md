# Ecosystem Reference Guide

A quick map of the Gajumaru components GajuFreight depends on or interacts with. Full citations are in [sources.md](sources.md).

## 1. Gajumaru building blocks

| Component | What it is | How GajuFreight uses it |
| :--- | :--- | :--- |
| **Groot** | Proof-of-work root chain (Bitcoin-NG style: ~2-min keyblocks, ~3-s microblocks). The resource layer for Gaju. | MVP deployment target. Final settlement. |
| **Associate Chains (ACs)** | Chains with their own consensus, linked to Groot by a deposit/withdrawal protocol. Groot doesn't see what happens inside an AC. | Possible later target for cheaper, faster milestones. |
| **Sophia** | Strongly typed functional contract language (`.aes`). | `ShipmentEscrow` and factory contracts. |
| **FATE VM** | Fast Arboreal Transaction Engine, which runs compiled Sophia. | Runtime for our contracts. |
| **GRIDS** | Air-gapped signing: instructions are passed to a wallet as QR/URL payloads, so keys never touch the app. | Every user action that needs a signature. |
| **GajuPay** | QR payment flow. The merchant watches microblocks for a matching (recipient, amount, reference) transaction. | Pattern for our settlement watcher. |
| **GajuMarket** | Escrow-based marketplace built on contract clones. | Reference design for escrow and fees. |
| **Data TTL** | Protocol mechanism for limiting how much data the chain keeps. | Possibly for pruning shipment state. Semantics still to be confirmed. |
| **State channels** | Off-chain channels for high-frequency payments. | Not in the MVP. Could suit per-leg micro-payments. |

## 2. Tools

| Tool | Purpose |
| :--- | :--- |
| **GajuDesk** | Desktop wallet and contract workbench: write, compile, test and inspect Sophia contracts. GPL3. |
| **GajuMobile** | Mobile wallet. Scans GRIDS codes. |
| **GM Demo Chain** | Local Groot plus AC setup for development and testing. |
| **Testnet faucet** | Issues test Gaju in response to a GRIDS-signed request. |
| **Onboarding repo** ([shanepreater/gajumaru](https://github.com/shanepreater/gajumaru)) | Install scripts (`quick-start.sh`) and environment setup. |

## 3. Developer setup checklist

1. Run the onboarding scripts from `shanepreater/gajumaru`.
2. Install GajuDesk and create a testnet account.
3. Request test Gaju from the testnet faucet (you sign the request with GRIDS).
4. Start a local demo chain (Groot plus one AC) for contract tests.

## Appendix: running a mining node (optional)

You don't need to mine to develop GajuFreight. It's only relevant if you run your own Groot node.

- Site: [gajumining.com](https://gajumining.com)
- Worker binaries: `mean29-*` (≈3 GB RAM, faster), `lean29-*` (≈1 GB RAM), `cuda29` (GPU). `-avx2` builds need AVX2 CPU support; `-generic` builds run on any CPU.
- Client config: `/usr/local/gajuminer/gmhive_client_config.json`
