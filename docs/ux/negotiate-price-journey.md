# Journey: agree the price (shipper and forwarder)

| | |
| :--- | :--- |
| **Status** | Draft (wireframe round 2; forwarder-led quoting, [ADR 0015](../adr/0015-forwarder-led-quoting.md)) |
| **Last reviewed** | 2026-10-09 |
| **Related** | [Wireframes](../wireframes/index.html) · [Book and fund](book-and-fund-journey.md) · [ADR 0004: staged contracts](../adr/0004-staged-contracts.md) |

## Jobs

- **Shipper:** When I need goods moved to a customer, I want quotes from forwarders I trust and a fair price fixed in writing, so I pay what was agreed and nothing more.
- **Forwarder:** When a shipper asks me to quote, I want to price the legs and the job at a margin and win it quickly, or say no fast when I can't take it, so I can fill my capacity without being haggled into a loss.

## Journey

| Stage | Doing | Thinking | Feeling | Pain point | Opportunity |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Ask | Shipper describes the consignment (unit lines with size and weight, origin, destination, deliver-by) and picks forwarders to invite | "Who should I ask?" | Purposeful | Re-typing the same job for each forwarder; not knowing the consignment becomes public | One request to several invited forwarders; saved contacts; a plain note on what's public (sizes, weights, places) and what isn't (the consignee, addresses) |
| Quote | Forwarder decides the legs and prices them: total, and % at pickup and arrival points. Or declines, with an optional reason | "Can I cover my carriers?" | Calculating | Committing before knowing leg costs | Show their own recent leg prices for the route as a reference (off-chain); a one-click decline keeps the shipper's queue honest |
| Compare | Shipper sees the quotes side by side | "Which is really cheaper?" | Careful | Different payment schedules are hard to compare | Normalise: total, upfront %, due-on-delivery %, and expiry countdown |
| Counter | Shipper names a target price, with an optional note; the forwarder revises its quote or declines | "Will they come down?" | Tense | Losing track of who offered what, and how many counters are left | A thread per forwarder; "Counter 1 of 3"; the latest quote highlighted, earlier ones struck through; the final quote clearly marked |
| **Agree** 💰 | The shipper accepts the forwarder's exact quote | "Is this final?" | Relieved | Fear the terms changed at the last second | Accept is tied to the exact terms; if they changed, the accept fails and shows what changed |
| Book | Shipper creates the escrow from the agreed terms and funds it | "Did anything change?" | Confident | — | Price and schedule are pre-filled and locked |

💰 = money commitment (funds move at booking).

## Flow

**Entry:** *My shipments* → **Request quotes**.

1. **Request quotes:** the consignment (unit lines, origin, destination, deliver-by), packages, invited forwarders → **Sign request** (fee shown).
2. **Negotiation:** one thread per forwarder. The shipper can *Accept* or *Counter* (target price and note, up to 3 times) a quote, or *Let it lapse*; the forwarder can *Quote*, *Revise* after a counter, or *Decline*. Each action signs (network fee shown). The total is what the shipper pays; GajuFreight's 1% platform fee comes out of the forwarder's payouts ([ADR 0010](../adr/0010-platform-fee.md)).
3. **Agreed:** a summary of the fixed terms → **Create shipment from these terms** (the existing booking screen, with price and schedule locked) → fund.

**Steps:** 3 screens. Signatures: 1 request, plus 1 per quote or counter (at most 4 quotes and 3 counters per thread), plus 1 acceptance.

**Exits and edge cases:**
- **Offer lapsed:** "Nordhaven's offer expired 6 hours ago" → *Ask Nordhaven to re-quote*.
- **Terms changed before accepting** (`TERMS_CHANGED`): show what changed, side by side.
- **Only the shipper accepts:** a forwarder sees no Accept button (the contract would reject it with `ONLY_REQUESTER`), and the shipper can't accept while a counter awaits an answer (`NOT_YOUR_TURN`).
- **Final quote** (after the 3rd counter): *Accept* or *Let it lapse* only; *Counter* is gone (`ROUND_LIMIT`).
- **Forwarder declined** (`THREAD_CLOSED` on any further move): the thread shows "Declined" and the reason if given; the other threads carry on. If every forwarder declines: *Invite others* on a new request, or *Withdraw request*.
- **No acceptable quote:** *Withdraw request*, which closes every thread (nothing was paid).
- **Forwarder view:** a quote inbox ordered by expiry; any request they weren't invited to is invisible.
