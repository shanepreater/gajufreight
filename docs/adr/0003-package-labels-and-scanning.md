# ADR 0003: Package QR labels and scan in/out custody

| | |
| :--- | :--- |
| **Status** | Accepted (decided 2026-10-03) |
| **Last reviewed** | 2026-10-03 |
| **Related** | [HLD §6.6](../hld.md#66-package-labels-and-custody-scanning) · [HLD §5 contract sketch](../hld.md#5-contract-sketch-sophia) · [ADR 0002](0002-arbiter-panel.md) |

## Context

Scanning packages into and out of every location is a main use case. It shows custody at each handover, catches missing items early, and gives the arbiter panel evidence. But a printed label can be copied, scanned anywhere, or attached to the wrong box. And scanning every package as its own transaction would bloat the chain (hard rule 4).

## Decision

- **Every handling unit gets a printed QR label** (package, pallet or container). It encodes only `gajufreight://s/<contract>/p/<package-id>`: no secrets, and safe to print. The label shows the package ID in readable text as well, along with the shipment reference and "n of N".
- **Labels identify; signatures authorise.** Scanning a label changes nothing by itself. The UI never confuses the *label QR* with the *GRIDS signing QR*. Custody is recorded only when an attestor or the carrier signs a checkpoint (hard rules 1 and 5).
- **The manifest anchors labels.** The booking includes `manifest : hash`, the hash of the package list (IDs and descriptions, stored off-chain). Scanners check each package ID against the manifest whose hash matches the on-chain value. Unknown or extra labels are **kept out of the scanned list** and recorded as exceptions in the evidence; the checkpoint itself still goes ahead (see the next point).
- **One checkpoint per location, not per package.** The scanner scans every unit present, then signs one `add_checkpoint(location, kind, evidence)`, where `kind` is `ScanIn`, `ScanOut` or `Milestone`. The evidence is the hash of a bundle listing the scanned package IDs, with the scan times, optional photos and seal numbers. Gas stays flat however many packages there are.
- **Exceptions are recorded, not blocked.** Missing packages ("2 of 3"), unknown or foreign labels, and duplicate sightings (the same package scanned at two places at once, which suggests a cloned label) go into the evidence bundle and show on the timeline. A missing package doesn't stop the checkpoint, so goods keep moving, but the consignee and panel can see it in a dispute.
- **Handover** is a scan-out by one party followed by a scan-in by the next.
- **Offline:** scans queue on the device and are signed once there's signal. The checkpoint timestamp is the signing time; scan times live in the evidence.

## Consequences

- **Good:** a per-package custody trail at the cost of one transaction per location, early detection of missing or extra items, and useful dispute evidence.
- **Cost:** the contract gains `manifest` and a checkpoint `kind`. The indexer has to project per-package custody from evidence bundles. The UI needs label printing and a camera scan flow.
- **Limits:** labels can be physically cloned. The manifest check, duplicate-sighting detection, attestor signatures, tamper-evident labels and seal numbers make cloning visible, not impossible. We don't claim cryptographic proof that a physical package is genuine.
