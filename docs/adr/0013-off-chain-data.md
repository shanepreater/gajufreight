# ADR 0013: Off-chain data: read model, operational store and evidence store

| | |
| :--- | :--- |
| **Status** | Proposed (2026-10-05): from the [design audit](../design-audit.md) |
| **Last reviewed** | 2026-10-05 |
| **Related** | [Architecture §3–4](../architecture-blueprint.md#3-components) · [HLD §6.4](../hld.md#64-data-on-chain-vs-off-chain) · [HLD §6.8](../hld.md#68-privacy-standard) · [ADR 0003](0003-package-labels-and-scanning.md) · [ADR 0006](0006-final-mile-proof-of-delivery.md) · [ADR 0008](0008-app-sessions.md) · [ADR 0009](0009-organisations-and-directory.md) |

## Context

The architecture has one "app database (read model)", which can be rebuilt from the chain and the evidence store (hard rule 3), and an evidence store that is "S3-compatible or IPFS". The audit found three problems:

- **Not all off-chain data is a projection of the chain.** Organisations, members, sessions, verification decisions, contacts and GRIDS requests exist nowhere else. Losing them can't be fixed by replaying the chain.
- **On-chain hashes need their preimages.** Offers, bookings and manifests are hashes on-chain. Unless the terms, job and manifest behind each hash are stored durably, a rebuilt read model can show that a deal was agreed but not what was agreed.
- **IPFS is public and permanent.** Evidence includes photos, consignee names and addresses, and company documents. Publishing those breaks the privacy standard and makes erasure impossible.

## Decision (proposed)

1. **Three stores, with different guarantees:**

   | Store | Holds | Rebuildable? | Protection |
   | :--- | :--- | :--- | :--- |
   | **Read model** (PostgreSQL, schema `read`) | Projections of chain events only | Yes, from the chain and the evidence store | None needed beyond the database itself; rebuild time is measured |
   | **Operational store** (PostgreSQL, schema `app`) | Organisations, members, documents' metadata, verification decisions and their audit log, sessions, contacts and notification preferences, GRIDS requests | **No**: it's a system of record | Point-in-time backups, restore tested, retention policy |
   | **Evidence store** (private S3-compatible object storage) | Evidence bundles, photos, documents, and the preimage of every on-chain hash (terms, job, manifest) | It's the source | Encrypted at rest, versioned with object lock against tampering, backed up, reached only through the API |

2. **Content-addressed, with canonical formats:**
   - Hashes the contract compares (terms, job) are blake2b of the FATE serialisation (spike E8), computed by the tx-builder ([ADR 0012](0012-transaction-building-and-grids-relay.md)).
   - Evidence bundles are canonical JSON (RFC 8785), hashed with blake2b-256, and carry a `bundle_version`.
   - Anyone given a bundle can recompute its hash.
3. **Store first, then sign.** The API won't build a `propose`, booking, checkpoint or delivery payload until the bundle or preimage is stored and its hash checked.
4. **Access by role** ([privacy standard](../hld.md#68-privacy-standard)):
   - The evidence store is never public. The API serves each object only to roles that may see it (prices only to the parties, company documents only to the owner and admins).
   - Downloads use short-lived signed URLs.
5. **Personal data and erasure:**
   - Personal data stays off-chain.
   - Erasing it deletes the off-chain object. The on-chain hash remains but no longer resolves to anything, which the privacy notice says.
   - Retention periods are set by the [ADR 0009](0009-organisations-and-directory.md) decision on document retention.
6. **Service signing key.** The API signs delivery-code check records (ADR 0006) with a service key kept in the secret store and rotated. It's never a user key, and it can't move funds.

## Consequences

- **Good:**
  - "Rebuildable" now means something precise: read model ⇐ chain + evidence store.
  - Negotiations and bookings can be reconstructed and shown to an arbiter.
  - Personal data can be erased.
- **Cost:**
  - Two backup regimes to run and test (`sre`).
  - Object-lock storage.
  - The API grows a store-then-sign step on every write.
- **Not chosen:** IPFS, or any public pinning service, for anything carrying personal or commercial data.
