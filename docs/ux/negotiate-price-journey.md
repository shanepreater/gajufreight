# Journey: agree the price (shipper and forwarder)

| | |
| :--- | :--- |
| **Status** | Draft (wireframe round 2) |
| **Last reviewed** | 2026-10-03 |
| **Related** | [Wireframes](../wireframes/index.html) · [Book and fund](book-and-fund-journey.md) · [ADR 0004: staged contracts](../adr/0004-staged-contracts.md) |

## Jobs

- **Shipper:** When I need goods moved to a customer, I want quotes from forwarders I trust and a fair price fixed in writing, so I pay what was agreed and nothing more.
- **Forwarder:** When a shipper asks me to quote, I want to price the job at a margin and win it quickly, so I can fill my capacity without being haggled into a loss.

## Journey

| Stage | Doing | Thinking | Feeling | Pain point | Opportunity |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Ask | Shipper describes goods, packages, route and deadline, and picks forwarders to invite | "Who should I ask?" | Purposeful | Re-typing the same job for each forwarder | One request to several invited forwarders; saved contacts |
| Quote | Forwarder prices it: total, and % at pickup and arrival points | "Can I cover my carriers?" | Calculating | Committing before knowing leg costs | Show their own recent leg prices for the route as a reference (off-chain) |
| Compare | Shipper sees the quotes side by side | "Which is really cheaper?" | Careful | Different payment schedules are hard to compare | Normalise: total, upfront %, due-on-delivery %, and expiry countdown |
| Counter | Either side proposes new terms | "Will they take it?" | Tense | Losing track of who offered what | A thread per forwarder; the latest offer is highlighted with who made it; earlier offers are struck through |
| **Agree** 💰 | The other side accepts the exact terms | "Is this final?" | Relieved | Fear the terms changed at the last second | Accept is tied to the exact terms; if they changed, the accept fails and shows what changed |
| Book | Shipper creates the escrow from the agreed terms and funds it | "Did anything change?" | Confident | — | Price and schedule are pre-filled and locked |

💰 = money commitment (funds move at booking).

## Flow

**Entry:** *My shipments* → **Request quotes**.

1. **Request quotes:** goods, packages, route, deadline, invited forwarders → **Sign request** (fee shown).
2. **Negotiation:** one thread per forwarder; *Accept*, *Counter* or *Let it lapse*. Each action signs (fee shown).
3. **Agreed:** a summary of the fixed terms → **Create shipment from these terms** (the existing booking screen, with price and schedule locked) → fund.

**Steps:** 3 screens. Signatures: 1 request, plus 1 per offer or counter, plus 1 acceptance.

**Exits and edge cases:**
- **Offer lapsed:** "Nordhaven's offer expired 6 hours ago" → *Ask Nordhaven to re-quote*.
- **Terms changed before accepting** (`TERMS_CHANGED`): show what changed, side by side.
- **Accepting your own offer** isn't offered in the UI (the contract would reject it with `OWN_OFFER`).
- **No acceptable quote:** *Withdraw request*, which closes every thread (nothing was paid).
- **Forwarder view:** a quote inbox ordered by expiry; any request they weren't invited to is invisible.
