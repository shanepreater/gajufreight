# ADR 0005: Platform registry and settings, atomic booking, round limit and privacy standard

| | |
| :--- | :--- |
| **Status** | Accepted (decided 2026-10-03; amends ADR 0002 and ADR 0004) |
| **Last reviewed** | 2026-10-03 |
| **Related** | [HLD §5](../hld.md#5-contract-sketch-sophia) · [HLD §6.8](../hld.md#68-privacy-standard) · [ADR 0004](0004-staged-contracts.md) · [ADR 0002](0002-arbiter-panel.md) |

## Context

The round-2 review and design questions settled five things:

1. Booking and funding should be **one atomic action**.
2. A negotiation that can't agree within **N rounds** isn't worth continuing. N is set by an **Admin team**, initially 5.
3. Arbiter votes must not sway one another, and leg costs and margins are private between the forwarder and that carrier.
4. A review found that the escrow trusted *any* contract exposing `agreement()`, so a look-alike could impersonate a `QuoteRequest`.
5. A review found that an unbounded arbiter panel could exceed gas limits; it's now capped at 7.

## Decision

- **`Platform`: a new, separate entity** with three jobs:
  - **Settings:** `max_rounds` (5) and `max_panel` (7). They change only by **M-of-N admin approval**: an admin proposes a change (`SetSetting`, `AddAdmin` or `RemoveAdmin`), other admins `approve` it, and it applies on the M-th approval, after being re-checked. Admins must be distinct, and the admin set can never drop below M.
  - **Quote registry:** `new_quote(invited, job)` creates a `QuoteRequest` (with the caller as requester and the current `max_rounds`) and records it. `is_quote(address)` answers whether a contract is one of ours. The escrow requires `platform().is_quote(quote)` (`UNKNOWN_QUOTE`), where `platform()` is the **canonical Platform address compiled into the escrow template for each network**, never caller-supplied. That closes the look-alike gap for both quotes and registries.
  - **Bounds:** the escrow reads `max_panel` at creation.
- **Atomic booking:** the escrow's `init` is `payable` and requires `Call.value == terms.price` (`WRONG_AMOUNT`). It starts in **Funded**; there's no `Created` state and no `fund` entrypoint, so creating the shipment and locking its funds is one signature.
- **Round limit:** each quote thread counts proposals against the `max_rounds` captured when the quote was created, so later settings changes don't move the goalposts. The N-th proposal is a **final offer**: it can still be accepted, but any further proposal fails with `ROUND_LIMIT`.
- **Privacy standard** (HLD §6.8): on-chain data is public. Contracts stay simple and cheap, the **app** enforces confidentiality (screens, API, exports and logs, filtered by role), and we write down what stays inspectable on-chain. No cryptographic hiding schemes unless explicitly decided. Applied here:
  - **Arbiter votes** stay in the clear on-chain. The app shows an arbiter the other votes only after they've cast their own.
  - **Leg prices and margins** are shown only to the forwarder and that leg's carrier.

## Consequences

- **Good:**
  - Quotes can't be impersonated, rules change only by admin quorum, booking takes one signature fewer, and negotiations end.
  - The privacy approach costs nothing on-chain.
- **Dependencies:**
  - Value at contract creation (a payable `init`) and contracts creating contracts (`Chain.create`, used by `new_quote`) are unconfirmed on Gajumaru, so they're **HLD §7 Q12** for QPQ. Until they're confirmed, the real contracts wait (AGENTS.md hard rule 7); the demo models them.
  - If a payable `init` isn't available, `Platform.book(...)` becomes the single payable call that creates and funds the escrow.
- **Limits:**
  - App-level privacy is only as strong as the app. Anyone reading the chain can see votes and leg-escrow balances, and could link a forwarder's payments across shipments.
  - Admin keys need a recovery runbook (`sre` skill).
