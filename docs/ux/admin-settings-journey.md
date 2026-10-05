# Journey: change a platform rule (Admin team)

| | |
| :--- | :--- |
| **Status** | Draft (wireframe round 3) |
| **Last reviewed** | 2026-10-03 |
| **Related** | [Wireframes](../wireframes/index.html) · [ADR 0005](../adr/0005-platform-booking-privacy.md) · [HLD §5 Platform sketch](../hld.md#5-contract-sketch-sophia) |

## Job

When the platform's rules need changing (the negotiation round limit, the arbiter-panel cap, the platform fee rate, minimum and fee account, or who the admins are), I want to propose the change and have colleagues approve it, so no single person can change how every shipment works, and we can never lock ourselves out.

## Journey

| Stage | Doing | Thinking | Feeling | Pain point | Opportunity |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Notice | Sees that negotiations often run all 5 rounds | "Should the limit be lower?" | Curious | Changes feel risky | Show current values with a plain explanation of each |
| Propose | Proposes `max_rounds` = 4 | "What does this affect?" | Careful | Unclear impact | State the scope: **only quotes created after the change**; open negotiations keep their limit |
| Approve | A second admin reviews and approves | "Who asked for this, and why?" | Responsible | Approving without context | Show the proposer, the reason, the old and new values, and approvals so far (1 of 2) |
| **Applied** ⚙️ | The second approval applies it | "Did it take effect?" | Relieved | Not knowing if it's live | Pending → final; the change appears in the history |
| Admin changes | Adds or removes an admin | "Could we lock ourselves out?" | Cautious | Fear of breaking the quorum | Removals that would leave fewer admins than the quorum are refused before signing |

⚙️ = platform rules change for everyone.

## Flow

**Entry:** *Needs your action → Proposal #3 waiting for your approval*, or *Settings → Propose a change*.

1. **Settings:** current values, open proposals with approval progress, and history.
2. **Propose:** choose a setting or an admin change, enter the new value and a reason → **Sign proposal** (it counts as your approval).
3. **Approve:** review a colleague's proposal → **Sign approval**. It applies on the M-th approval.

**Steps:** 2 screens and 1 signature per admin. A change needs M signatures in total (2 of 3 today).

**Exits and edge cases:**
- **Not an admin:** read-only view (`ONLY_ADMIN`).
- **Invalid value** (unknown setting, below 1, not a whole number): blocked in the form (`BAD_SETTING`).
- **Removal would break the quorum:** blocked with "At least 2 admins must remain". Two pending removals are re-checked when each applies, so the second fails instead of locking the team out.
- **Already applied:** approving an applied proposal shows it as done (`NO_PROPOSAL`).
- **Lost admin key:** the remaining admins remove that account and add a replacement (runbook to follow, `sre` skill).
