# Cryptography and key management

Use what's listed here. A different choice needs a reason in the PR, and an ADR if it's expensive to reverse. Use the platform's vetted libraries (Python `cryptography`, `hashlib`, `hmac`, `secrets`; the browser's Web Crypto API) and never write primitives by hand.

## Choices

| Need | Use | Not |
| :--- | :--- | :--- |
| Hash we compare with the contract | `Crypto.blake2b` over the FATE serialisation, reproduced off-chain exactly ([HLD §5](../../../../docs/hld.md#5-contract-sketch-sophia)) | A different encoding "that looks the same" |
| Evidence file hash | BLAKE2b-256 of the exact stored bytes | Hashing a re-encoded or normalised copy |
| Hiding guessable data behind a hash | Don't. If you must, add a random 32-byte salt kept off-chain, and get it decided ([ADR 0005](../../../../docs/adr/0005-platform-booking-privacy.md)) | An unsalted hash of a name, price or short manifest |
| Wallet signatures | Ed25519 as Gajumaru accounts use it, checked against the `ak_` address. Sign-in challenges carry a domain, network id, nonce and expiry, and are single-use | Accepting a signature without checking the message's domain, network and expiry |
| Webhook authenticity | HMAC-SHA-256 with a per-sender secret, `hmac.compare_digest`, and a ≤ 5-minute timestamp window | `==` on signatures, or a shared secret across senders |
| Session tokens | 256 bits from `secrets.token_urlsafe(32)`, stored server-side as a SHA-256 hash, in an `HttpOnly` cookie | JWTs for sessions (they can't be revoked, ADR 0008) |
| PIN and any password | Argon2id (`argon2-cffi`, OWASP parameters), attempts limited and then locked out | SHA-*, bcrypt with a short PIN and no lockout |
| Random values (nonces, ids, salts) | `secrets` / `crypto.getRandomValues` | `random`, `Math.random`, timestamps |
| Device unlock | WebAuthn platform authenticator, with the RP id pinned to our domain | Custom biometric handling |
| Encryption at rest (DB, evidence store, backups) | Cloud KMS envelope encryption with AES-256-GCM; one key per environment and data class | Keys in config, or one key everywhere |
| App-level field encryption (if ever needed) | AES-256-GCM or XChaCha20-Poly1305 via `cryptography` / libsodium, unique nonces, the record id as associated data | ECB, CBC without a MAC, or reused nonces |
| In transit | TLS 1.3 (1.2 at minimum, AEAD ciphers only), HSTS with preload, certificates managed automatically; mTLS or workload identity between services | Plain HTTP inside the network ("it's internal") |

## Key management

- **Inventory every key:** owner, purpose, where it lives, who can use it, how it rotates, and what to do if it leaks. Keep the inventory in the security runbook, not the repo's secrets.
- **Where keys live:** user keys stay in the user's wallet (hard rule 1). Deployer and platform-admin keys stay in a hardware wallet or a KMS/HSM, never on a laptop or CI disk. Service secrets come from the secret store at runtime (`infra`).
- **Rotation:** service secrets and webhook secrets at least yearly and right away after any suspicion. Support two valid secrets during a change-over so a rotation causes no outage.
- **On-chain keys can't be rotated inside a live escrow.** Attestor and arbiter addresses are fixed per escrow, so a compromise is handled through the dispute path and by not using that key for new quotes. Keep that in mind when choosing who gets to be an attestor.
- **Crypto agility:** store the algorithm with each hash, ciphertext and password hash so a later migration doesn't need a big-bang change.
