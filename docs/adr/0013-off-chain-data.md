# ADR 0013: Off-chain data: read model, operational store and evidence store

| | |
| :--- | :--- |
| **Status** | Accepted (2026-10-06, [decision log](../decision-log.md) #4), amended: agreed terms are on-chain in full, so the evidence store holds no terms preimages |
| **Last reviewed** | 2026-10-05 |
| **Related** | [Architecture §3–4](../architecture-blueprint.md#3-components) · [HLD §6.4](../hld.md#64-data-on-chain-vs-off-chain) · [HLD §6.8](../hld.md#68-privacy-standard) · [ADR 0003](0003-package-labels-and-scanning.md) · [ADR 0006](0006-final-mile-proof-of-delivery.md) · [ADR 0008](0008-app-sessions.md) · [ADR 0009](0009-organisations-and-directory.md) |

## Context

The architecture has one "app database (read model)", which can be rebuilt from the chain and the evidence store (hard rule 3), and an evidence store that is "S3-compatible or IPFS". The audit found three problems:

- **Not all off-chain data is a projection of the chain.** Organisations, members, sessions, verification decisions, contacts and GRIDS requests exist nowhere else. Losing them can't be fixed by replaying the chain.
- **On-chain hashes need their preimages.** Offers, bookings and manifests are hashes on-chain. Unless the terms, job and manifest behind each hash are stored durably, a rebuilt read model can show that a deal was agreed but not what was agreed.
- **IPFS is public and permanent.** Evidence includes photos, consignee names and addresses, and company documents. Publishing those breaks the privacy standard and makes erasure impossible.

## Decision

1. **Three stores, with different guarantees:**

   | Store | Holds | Rebuildable? | Protection |
   | :--- | :--- | :--- | :--- |
   | **Read model** (PostgreSQL, schema `read`) | Projections of chain events only | Yes, from the chain and the evidence store | None needed beyond the database itself; rebuild time is measured |
   | **Operational store** (PostgreSQL, schema `app`) | Organisations, members, documents' metadata, verification decisions and their audit log, sessions, contacts and notification preferences, GRIDS requests | **No**: it's a system of record | KMS envelope encryption at rest, backups encrypted the same way; a database role per service with only the grants it needs (the indexer writes `read` only, the API can't alter `read`, no shared superuser); point-in-time backups, restore tested; retention policy, with expired GRIDS requests and sessions purged |
   | **Evidence store** (private S3-compatible object storage) | Evidence bundles, photos, documents, and the preimage of every on-chain hash (job, manifest). Agreed terms are on-chain in full, so they need no preimage | It's the source | KMS envelope encryption at rest (a data key per object, the shipment and evidence hash as associated data), versioned with object lock against tampering, backed up, reached only through the API |

2. **Content-addressed, with canonical formats:**
   - **Hashes the contract compares (the job, and the terms hash an accepter names)** are blake2b of the FATE serialisation (spike E8), computed by the tx-builder ([ADR 0012](0012-transaction-building-and-grids-relay.md)). The job's preimage is stored as those exact serialised bytes, with a readable JSON view beside it. The terms themselves are on-chain in full ([decision log](../decision-log.md) #4).
   - **Evidence hashes keep the project's one format:** SHA-256 over canonical JSON (RFC 8785), as `hashEvidence` in the demo and the security guidance already use. The contract treats the hash as opaque 32 bytes, so there's no reason to change it.
   - **A versioned bundle schema authenticates everything it refers to.** Attachments are stored separately by their own digest, and the bundle lists each one, so swapping an object changes nothing on-chain but fails verification:

     ```json
     { "bundle_version": 1, "alg": "sha256-jcs", "nonce": "<32 random bytes, hex>",
       "network_id": "groot.testnet", "escrow": "ct_…", "kind": "ScanIn",
       "location": "NLRTM", "created_at": "<ISO 8601>", "by": "ak_…",
       "items": [{ "package": "GF8-P1", "scanned_at": "…", "typed": false }],
       "exceptions": [{ "package": "GF8-P2", "type": "missing" }],
       "attachments": [{ "digest": "sha256:…", "size": 182734,
                         "media_type": "image/jpeg", "role": "photo" }] }
     ```

     - The `nonce` stops a guessable bundle (a short scan list) from being brute-forced from its public hash.
     - `network_id` and `escrow` bind the bundle to one contract, so it can't be replayed on another.
     - `alg` records the format for later migration.
   - **Attachments are verified on upload and on every read.** On upload, the server computes the digest over the exact stored bytes and sniffs the media type; it never trusts the client's. On read, an object whose digest doesn't match is refused and alerted (`sre`, evidence-verify failures).
   - Anyone given a bundle and its attachments can recompute every hash.
3. **Store first, then sign.** The API won’t build a quote request, a `counter` or `decline` that carries a note, a booking, a checkpoint or a delivery payload until the bundle or preimage is stored and its hash checked.
4. **Access by role** ([privacy standard](../hld.md#68-privacy-standard)):
   - The evidence store is never public. The API serves each object only to roles that may see it (prices only to the parties, company documents only to the owner and admins).
   - Downloads use short-lived signed URLs.
5. **Personal data and erasure:**
   - **Personal data stays off-chain and out of the bundle body.** Names, addresses, "received by" and photos of people are attachments, each with its own random nonce, referenced only by digest. A bundle therefore never needs to change to erase someone.
   - **Erasure is by key destruction (crypto-shredding).** Personal-data attachments are encrypted with a data key per shipment ([security guidance](../../.claude/skills/security-consultant/references/cryptography.md)). Erasing destroys that key in the KMS, which makes every version, replica and backup unreadable at once, whatever object lock still holds them. With our own key service for the pilot ([ADR 0016](0016-hosting-and-environments.md), OpenBao), the key also lingers in its encrypted snapshots until they expire, so erased data becomes unreadable within 30 days rather than at once, until we move to a managed KMS.
   - The locked ciphertext is then deleted when its lock and backup retention lapse.
   - **The privacy notice states that timeline:** unreadable at once with a managed KMS, or within 30 days with our own key service (ADR 0016); ciphertext gone within the longest lock or backup retention period. The on-chain hashes remain, with nothing they can be resolved to.
   - Object lock applies to the evidence (bundles and non-personal attachments), so tampering stays detectable for the retention period.
   - Retention periods are set by the [ADR 0009](0009-organisations-and-directory.md) decision on document retention (D7).
6. **Service signing key.** The API signs delivery-code check records (ADR 0006) with a service key kept in the secret store and rotated. It's never a user key, and it can't move funds.

## Consequences

- **Good:**
  - "Rebuildable" now means something precise: read model ⇐ chain + evidence store.
  - Negotiations and bookings can be reconstructed and shown to an arbiter.
  - Personal data can be erased.
- **Cost:**
  - Two backup regimes to run and test (`sre`), and KMS keys per environment, data class and shipment.
  - Object-lock storage.
  - The API grows a store-then-sign step on every write.
- **Not chosen:** IPFS, or any public pinning service, for anything carrying personal or commercial data.
