# Cryptography and key management

Use what's listed here. A different choice needs a reason in the PR, and an ADR if it's expensive to reverse. Note that an existing hash isn't automatically a privacy control: the quote's `blake2b(terms)` can be brute-forced from a guessable price and schedule. Use the platform's vetted libraries (Python `cryptography`, `hashlib`, `hmac`, `secrets`; the browser's Web Crypto API) and never write primitives by hand.

## Choices

| Need | Use | Not |
| :--- | :--- | :--- |
| Hash we compare with the contract | `Crypto.blake2b` over the FATE serialisation, reproduced off-chain exactly ([HLD §5](../../../../docs/hld.md#5-contract-sketch-sophia)) | A different encoding "that looks the same" |
| Evidence hash | The project's one fixed format, today SHA-256 over canonical JSON (`hashEvidence` in [shipping-feed.js](../../../../scripts/demo/lib/shipping-feed.js)), over exactly what's stored (after any metadata stripping). These hashes go on-chain, so changing the algorithm or serialisation needs an ADR and the demo changed with it. Structured, guessable evidence (a scan list, a small JSON milestone) carries a random 32-byte nonce field inside the document before hashing | A second format, hashing a re-encoded copy, or a bare hash of guessable content |
| Hiding guessable data behind a hash | Don't. If you must, add a random 32-byte salt kept off-chain, and get it decided ([ADR 0005](../../../../docs/adr/0005-platform-booking-privacy.md)) | An unsalted hash of a name, price or short manifest |
| Wallet signatures | Ed25519 as Gajumaru accounts use it, checked against the `ak_` address. Sign-in challenges carry a domain, network id, nonce and expiry, and are single-use | Accepting a signature without checking the message's domain, network and expiry |
| Webhook authenticity | Prefer Ed25519 over `timestamp.event_id.raw_body` with the sender's key: we hold only public keys, and the sender can't deny an event. Fall back to HMAC-SHA-256 with a per-sender secret and `hmac.compare_digest`. Either way, a ≤ 5-minute timestamp window and a key id for rotation | `==` on signatures, or a shared secret across senders |
| Session tokens | 256 bits from `secrets.token_urlsafe(32)`, stored server-side as a SHA-256 hash, in an `HttpOnly` cookie | Self-contained JWTs: ADR 0008 needs sessions the server can revoke at once, and a JWT plus a denylist is a server session anyway |
| PIN and any password | Argon2id (`argon2-cffi`, OWASP parameters) over an HMAC of the PIN with a pepper held in the secret store or KMS (a 6-digit PIN falls to offline guessing even under Argon2id once the table leaks). Attempts limited server-side with growing delays and an alert, so a fumbled PIN costs seconds, not the shift's session | SHA-*, a public value such as the wallet as the salt, no lockout |
| Random values (nonces, ids, salts) | `secrets` / `crypto.getRandomValues` | `random`, `Math.random`, timestamps |
| Device unlock | WebAuthn platform authenticator, with the RP id pinned to our domain | Custom biometric handling |
| Encryption at rest (DB, evidence store, backups) | Cloud KMS envelope encryption with AES-256-GCM: a data key per object, the shipment and evidence hash as associated data so a blob can't be moved to another record, and one key per environment and data class. A key per organisation allows erasure by destroying the key (the on-chain hash stays) | Keys in config, one key everywhere, or private evidence on public IPFS |
| App-level field encryption (if ever needed) | AES-256-GCM or XChaCha20-Poly1305 via `cryptography` / libsodium, unique nonces, the record id as associated data | ECB, CBC without a MAC, or reused nonces |
| In transit | TLS 1.3 (1.2 at minimum, AEAD ciphers only), HSTS with preload, certificates managed automatically; mTLS or workload identity between services | Plain HTTP inside the network ("it's internal") |

## Key management

- **Inventory every key:** owner, purpose, where it lives, who can use it, how it rotates, and what to do if it leaks. Keep the inventory in the security runbook, not the repo's secrets.
- **Where keys live:** user keys stay in the user's wallet (hard rule 1). Deployer and platform-admin keys stay in a hardware wallet or a KMS/HSM, never on a laptop or CI disk. Service secrets come from the secret store at runtime (`infra`).
- **Rotation:** service secrets and webhook secrets at least yearly and right away after any suspicion. Support two valid secrets during a change-over so a rotation causes no outage.
- **On-chain keys can't be rotated inside a live escrow.** Attestor and arbiter addresses are fixed per escrow, so a compromise is handled through the dispute path and by not using that key for new quotes. Keep that in mind when choosing who gets to be an attestor.
- **Crypto agility:** store the algorithm with each hash, ciphertext and password hash so a later migration doesn't need a big-bang change.
