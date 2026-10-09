# ADR 0015: Forwarder-led quoting

| | |
| :--- | :--- |
| **Status** | Accepted (decided 2026-10-09, [decision log](../decision-log.md) #13). Replaces the negotiation and round-limit parts of [ADR 0005](0005-platform-booking-privacy.md) |
| **Last reviewed** | 2026-10-09 |
| **Related** | [HLD §4](../hld.md#4-shipment-lifecycle) · [`quote-request.aes`](../../contracts/src/quote-request.aes) · [Contract interface](../contract-interface.md) · [ADR 0005](0005-platform-booking-privacy.md) · [ADR 0011](0011-agreed-booking-terms.md) · [Negotiation journey](../ux/negotiate-price-journey.md) |

## Context

In the first design, either side of a quote thread could propose full terms or accept the other's, with up to 5 proposals per thread. That let a shipper write the legs, milestone schedule and costs, but the forwarder knows which legs a shipment needs and what each one costs. And forwarders had nothing to price from on-chain: the request held only a hash of the manifest and consignee.

## Decision

1. **The request describes the consignment, on-chain.** `Platform.new_quote(invited, job, consignment, parent)` passes it, and the quote stores it at creation. It holds:
   - 1 to 20 unit lines, each with a count, length, width and height in mm, and weight in grams (integers only);
   - the origin and destination as location codes (UN/LOCODE, or a postcode district), never a street address;
   - an optional deliver-by block height.

   A bad consignment fails with `BAD_CONSIGNMENT`. It's public, so it carries no personal data: the consignee and the full addresses stay off-chain in the `job` hash, as before.
2. **Forwarders quote, and only they write terms.** Each invited forwarder calls `quote(terms, valid_until)` on its own thread: first, or in answer to a counter. Turns alternate, so a forwarder can't revise unprompted (`NOT_YOUR_TURN`).
3. **The requester counters with a target price.** `counter(invitee, price, note)` takes a price above 0 (`BAD_PRICE`) and an optional note, of which only the hash goes on-chain. The forwarder answers with a revised quote or declines.
4. **`max_rounds` counts counters, and its default is 3.** It's still a platform setting changed by admin quorum, captured when the quote is created. The forwarder's answer to the last counter allowed is final: it can be accepted or left to lapse, and a further counter fails with `ROUND_LIMIT`.
5. **Only the requester accepts** (`ONLY_REQUESTER`), and only an unexpired quote that isn't waiting for an answer to a counter. Accepting closes every other thread, as before.
6. **A forwarder can decline** with `decline(note)` at any point while the request is open. That closes its own thread (`THREAD_CLOSED`); the other threads carry on.
7. **Legs follow the same pattern**, with the forwarder in the requester's seat and carriers quoting.

`propose` and `OWN_OFFER` are removed. Events can't carry options in Sophia, so `Countered` and `Declined` omit the note hash. The indexer reads it from the call data, as it already does for terms. `ShipmentEscrow` and `Platform.book` don't change: they still read `agreement()`.

## Consequences

- **Good:**
  - The party that knows the costs sets them, and each side's moves are obvious: forwarders quote or decline, shippers counter or accept.
  - The chain shows what each price was for.
  - Negotiations are shorter, with at most 3 counters.
- **Cost:**
  - Lanes, volumes and weights are public, so competitors can read them. The shipper is told this when creating the request ([HLD §6.8](../hld.md#68-privacy-standard)).
  - A request costs a little more gas for its unit lines, capped at 20.
- **Not decided here:** open requests that any forwarder can see (requests stay invite-only), and checking the unit count against the package manifest at booking (an app-level check, later).
