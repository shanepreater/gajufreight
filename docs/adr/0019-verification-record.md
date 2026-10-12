# ADR 0019: On-chain verification record

| | |
| :--- | :--- |
| **Status** | Accepted (2026-10-11). Amends [ADR 0009](0009-organisations-and-directory.md)'s "no contract change": verification itself stays an app decision, and its result is now also recorded on-chain. **Amended 2026-10-12 by [ADR 0022](0022-arbitration.md):** the record carries the organisation's roles |
| **Last reviewed** | 2026-10-11 |
| **Related** | [HLD §6.8](../hld.md#68-privacy-standard) · [ADR 0009](0009-organisations-and-directory.md) · [ADR 0018](0018-confirmation-bond.md) · [Threat model](../threat-model.md) T30 · [#151](https://github.com/shanepreater/gajufreight/issues/151) (the KYB process) · [Decision log](../decision-log.md) #28 |

## Context

Shippers want to know that the forwarder and carriers they pay are real, verified businesses, and they want to check it themselves rather than trust our app. Theft of goods is deterred by knowing who the counterparty is, not by the 1% bond (ADR 0018).

But on-chain data is public forever. Agreed prices, lanes and cargo sizes are already public (HLD §6.8), so naming the company behind each address would turn that data into every named company's commercial history. A plain hash of the company's details doesn't help either: registration numbers are guessable, so the hash can be brute-forced.

## Decision

1. **A verifier records each verified address on `Platform`.** The verifier is an address the admin quorum sets with `SetVerifier`: an admin's wallet, signing over GRIDS, so no service holds its key. `verify(account, commitment, expires)` stores `{ commitment, expires, revoked }`; when it was recorded is the block of its `Verified` event. Verifying again renews the record and clears a revocation. `revoke(account)` marks it revoked; a suspension under ADR 0009 also revokes on-chain.
2. **No names on-chain, only a salted fingerprint:** `commitment = blake2b((legal name, country, registration number, salt))`, with a 32-byte random salt the app generates at verification. The tx-builder computes it with the same encoding it uses for job hashes ([ADR 0012](0012-transaction-building-and-grids-relay.md)), and its tests include a fixed example checked against the contract's `matches` by dry run (the demo model only stands in for the hash). The inputs are the exact strings the app stored at verification: the salt and those strings are stored in the `app` schema and handed to the organisation's owner together, as one copyable proof, so nobody re-types a name from a register. Every member wallet of the organisation gets the same commitment.
3. **Anyone can check:** `is_verified(account)` is true while the record is current and unrevoked. A company proves who it is by giving a counterparty its details and salt, who checks them with `matches(account, name, country, number, salt)` as a dry run, so the details never go on-chain. `matches` is true only while the verification is current, so one call answers both who and whether.
4. **No enforcement in contracts yet.** Quotes and escrows don't require verification. The app shows the badge, and ADR 0009's rule that an unverified company can still be invited directly, marked *Unverified*, stands.
5. **The checks behind a verification**, how long a verification lasts and what's retained are the KYB approach in [#151](https://github.com/shanepreater/gajufreight/issues/151); this ADR only records the outcome.

## Consequences

- **Good:**
  - Anyone, inside or outside the app, can check an address is a verified business and when that lapses.
  - A company chooses who learns its identity, and a counterparty can check what it's told.
  - Small: one record per address on `Platform`, two entrypoints for the verifier, and four reads (`verifier`, `verification`, `is_verified`, `matches`).
- **Visible on-chain (HLD §6.8):** which addresses we verified, when, until when and whether revoked, but not who they are. Once a company proves its identity to one counterparty, that counterparty can link its addresses to its public prices and lanes; the owner shares the salt knowing that.
- **Costs:** a transaction per member wallet at each verification and renewal, paid by GajuFreight (about 0.0002 Gaju each).
- **Risk:** a stolen verifier key could issue false badges. The admins rotate the verifier with `SetVerifier` and revoke what it issued; the app checks badges against its own verification records (threat model T30).
- **Not decided here:** requiring verification in quotes or escrows, expiry periods (#151), and an organisation-level identity contract (HLD §7 Q15).
