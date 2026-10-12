# ADR 0022: Verified, paid and fairly chosen arbiters

| | |
| :--- | :--- |
| **Status** | Accepted (2026-10-12, [decision log](../decision-log.md) #32). Amends [ADR 0002](0002-arbiter-panel.md) (panel and pay), [ADR 0006](0006-final-mile-proof-of-delivery.md) (who disputes a held delivery), [ADR 0011](0011-agreed-booking-terms.md) and [ADR 0015](0015-forwarder-led-quoting.md) point 8 (who sets the panel) and [ADR 0019](0019-verification-record.md) (roles on the verification record) |
| **Last reviewed** | 2026-10-12 |
| **Related** | [HLD §4](../hld.md#4-shipment-lifecycle) · [HLD §9.6](../hld.md#96-disputes) · [ADR 0006](0006-final-mile-proof-of-delivery.md) · [Threat model](../threat-model.md) T22, T34, T35 |

## Context

Community feedback asked who the arbiters are, how they're chosen and paid, and what stops one party stacking the panel. The answers were weak:
- the shipper could name any addresses, including wallets it controls;
- the forwarder could only walk away;
- arbiters were unpaid, so absent panels would push disputes to the fallback split.

Two rules shape the answer:
- Paying arbiters only when a dispute fails would bias every ruling against the raiser.
- The consignee must never carry financial risk beyond not receiving the goods.

## Decision

1. **Only verified arbiters.**
   - The verification record (ADR 0019) now carries the organisation's roles: `Shipper`, `Forwarder`, `Carrier`, `FinalMile`, `Attestor` or `Arbiter`. There must be at least one, each listed once (`BAD_ROLES`).
   - `has_role(account, role)` and `is_arbiter(account)` are true only while the verification is current and unrevoked.
   - Every panel member must be a verified arbiter (`UNVERIFIED_ARBITER`).
   - Adding a role later is one new value, not a new field.
2. **Panel selection.** The shipper proposes the panel in its request. The forwarder can:
   - **veto it entirely** by declining (with "panel" as its reason in the app), after which the shipper starts again; or
   - **replace one arbiter** in its quote with `replace = (outgoing, newcomer)`. The outgoing arbiter must be on the panel and the newcomer not (`BAD_REPLACEMENT`). The newcomer can't be the shipper or the forwarder (`CONFLICTED_ARBITER`) and must be a verified arbiter.
   The swap is part of the quoted terms, so the shipper accepts it by accepting the quote, and the agreed panel applies it (ADR 0011).
3. **Raising a dispute.**
   - The payer or the payee raises one by staking a **deposit equal to the arbiter fee** (`deposit_due()`): `arbiter_fee_bps` of the unpaid remainder (starts at 2%), at least `min_arbiter_fee` (starts at 1 Gaju), and never more than the remainder. Once a delivery is held, only the payer can raise one, as before.
   - **The consignee never pays or signs.** Its problem comes through the final-mile delivery company: an attestor calls `flag_dispute(evidence)`, and the escrow waits in `DisputeFlagged`. Within `deposit_window` (starts at 1,440 key blocks, about 3 days), the shipper raises it with `raise_dispute()` and the deposit, funding the consignee's complaint; the forwarder may raise it too if it wants a ruling. Whoever raises it is the raiser for the deposit's return.
   - If the flag isn't funded in time, anyone can `lapse_dispute()`. The escrow returns to where it was, without resetting a held delivery's challenge clock. Nothing moves while a dispute is flagged.
   - **One flag per escrow** (`ALREADY_FLAGGED`), so repeated flags can't freeze the funds; after a lapse, the payer or payee can still raise a dispute directly.
   - Once the whole price has been paid out there is nothing to dispute (`NOTHING_DISPUTED`).
4. **Paying arbiters.** At settlement (panel ruling or fallback), the arbiters who voted share the fee equally, **whichever way they voted**. It comes off the unpaid remainder before the split, so both sides bear it in proportion to the ruling, and rounding stays in the split. If nobody voted, no fee is paid. Arbiters who didn't vote are visible from the recorded votes and tracked against their organisation.
5. **The deposit.** It goes back to the raiser if the ruling gives the raiser at least half of the disputed amount. Otherwise it goes to the other side, as compensation. **It never goes to the arbiters**, so they gain nothing from the ruling.
6. **Fixed at quote time.** `arbiter_fee_bps`, `min_arbiter_fee` and `deposit_window` are voted settings, copied into the quote's `fees` record when the quote is requested.

## Consequences

- **Good:**
  - Panels can't be stacked with a party's own wallets.
  - Both sides shape the panel.
  - Arbiters are paid to turn up, not to pick a side.
  - Frivolous disputes cost the raiser, and the consignee carries no financial risk.
- **Conservation:** in every terminal state, payouts to the payee, payer, treasury and voting arbiters, plus the bond and deposit returns, equal the price plus any bond and any deposit staked (AGENTS.md contract invariants).
- **Visible on-chain (HLD §6.8):** each organisation's verified roles, every deposit and who staked it, each arbiter's vote and fee share, and where each deposit went.
- **Costs:**
  - A dispute ties up the deposit until it settles.
  - A flagged dispute needs one more signature, from the shipper.
  - The arbiter fee comes out of the disputed amount.
- **Risks:**
  - A verified arbiter could still be biased. The forwarder's veto and swap, and the public voting record, bound this (threat model T22).
  - A shipper could leave a flag unfunded to keep a held delivery waiting for up to the deposit window. The window is short, the challenge clock isn't reset, and only one flag is allowed per escrow (T35).
  - Verification is checked when the panel is chosen, not again at a dispute: an arbiter revoked after booking still sits on that shipment's panel. Re-checking at booking or at voting is a later option.
  - The demo model doesn't yet have the held-delivery state, so the flag-while-delivered paths are tested only in the contract's own tests once they exist (C10, [#69](https://github.com/shanepreater/gajufreight/issues/69)).
- **Not decided here:**
  - arbiter onboarding screens and conflict declarations ([#116](https://github.com/shanepreater/gajufreight/issues/116));
  - appeals;
  - per-shipment fee overrides.
  QPQ's planned authorisation groups and proposal pools ([QPQ Q&A](../qpq-q-and-a.md#authorisation-groups)) may later offer a platform-level pattern for panels and admin quorums; revisit once confirmed (hard rule 7).
