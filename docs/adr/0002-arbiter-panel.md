# ADR 0002: M-of-N arbiter panel with a deadline fallback

| | |
| :--- | :--- |
| **Status** | Accepted (decided 2026-10-03) |
| **Last reviewed** | 2026-10-03 |
| **Related** | [HLD §4 lifecycle](../hld.md#4-shipment-lifecycle) · [HLD §5 contract sketch](../hld.md#5-contract-sketch-sophia) · [HLD §7 Q5](../hld.md#7-open-questions) |

## Context

The contract sketch had a single named arbiter. A single arbiter is easy to build, but one person can be captured, can be unavailable, or can freeze a dispute forever by not ruling. The business chose an M-of-N panel ([HLD §7 Q5](../hld.md#7-open-questions)).

## Decision

- **Set at booking:** `arbiters` (1 ≤ N ≤ 7 distinct addresses, so counting votes stays within gas limits; none of them the shipper, carrier or consignee), `quorum` M (1 ≤ M ≤ N), `arbitration_window` in blocks (> 0), and `fallback_carrier_pct` (0–100, default 50).
- `raise_dispute()` records the dispute height. The panel has `arbitration_window` blocks to rule.
- `vote(pay_carrier_pct)` is arbiter-only. An arbiter's latest vote replaces their earlier one. **The dispute resolves automatically when M arbiters hold the same split**, and the funds are paid out in that call. Exact agreement means no averaging and no rounding arguments.
- `resolve_by_fallback()`: once the window has passed without a quorum, any party or arbiter can apply `fallback_carrier_pct`. A deadlocked or absent panel can never freeze funds.
- Payouts use the existing split rule: the carrier gets `amount × pct / 100`, and the shipper gets the remainder (including rounding dust), so funds are conserved.
- **Errors:** `ONLY_ARBITER`, `BAD_SPLIT` and `BAD_STATE` (existing). New: `BAD_QUORUM` (quorum out of range, an empty, oversized or duplicate panel), `CONFLICTED_ARBITER` (an arbiter is also a party), and `ARBITRATION_OPEN` (fallback called before the window has passed).
- A single arbiter is the M = N = 1 case, so nothing is lost.

## Consequences

- **Good:** no single point of capture or failure, and disputes always end: by quorum, or by the fallback after the window.
- **Cost:** more contract state (votes map, dispute height) and more entrypoints to test. The UI needs a panel view showing each vote, quorum progress and the fallback countdown.
- **Risk:** the fallback split is a business choice. If it's set badly (e.g. 100 % to one side), a party might want the panel to deadlock. That's mitigated by the 50 % default and by showing the fallback clearly at booking.
- **Follow-up:** the demo escrow model and its tests implement this in the same PR stack. The real Sophia contract follows in phase 1.
