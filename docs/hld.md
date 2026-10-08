# High-Level Design: GajuFreight

| | |
| :--- | :--- |
| **Status** | Draft |
| **Last reviewed** | 2026-10-05 ([design audit](design-audit.md)) |
| **Related** | [Architecture](architecture-blueprint.md) · [Development approach](dev-approach.md) · [Sources](sources.md) |

## 1. Purpose

GajuFreight is a shipment-tracking and escrow-settlement service on the Gajumaru network. A shipper first agrees a price with a forwarder on-chain, then locks payment in Gaju (木) against a digital waybill. Authorised parties post signed milestones as the goods move, and the payment goes to the carrier once delivery is proven. If delivery is not proven, it is refunded or sent to dispute resolution.

In practice GajuFreight is an **oracle**. It brings real-world facts ("the container reached Rotterdam", "the consignee signed for it") onto the chain, where a contract can act on them. Most of the design risk is in that step, not in moving tokens.

## 2. Scope

**In scope (MVP)**

- Two small contracts per stage ([ADR 0004](adr/0004-staged-contracts.md)): a `QuoteRequest` for negotiating with invited forwarders, then a `ShipmentEscrow` (waybill + escrow together). Each subcontracted leg reuses the same pair between the forwarder and that leg's carrier.
- Milestone payments released by attested scan-ins, with the remainder paid on delivery.
- Milestones posted by a fixed set of *attestors* (carrier, port agent, customs broker) named when the shipment is created.
- Payment released on proof of delivery. Refund after a deadline. Disputes are settled by an M-of-N arbiter panel, with a fallback split if it deadlocks.
- Off-chain telemetry (GPS, temperature, documents). The chain holds only hashes of it.

**Out of scope (for now)**

- A dedicated freight Associate Chain (see [§6.2](#62-where-the-contract-runs)).
- Multi-currency pricing and stablecoin settlement.
- Staked or reputation-weighted attestor networks.
- Automated customs/IoT integrations beyond a signed-webhook ingest.

## 3. Actors

| Actor | Role | On-chain powers |
| :--- | :--- | :--- |
| **Shipper** | Requests quotes, agrees the terms, funds the escrow: the escrow's payer | Quote: `propose`, `accept`, `withdraw`. Platform: `book` (books and funds in one call). Escrow: `raise_dispute`, `refund_after_deadline`, `add_attestor`, `remove_attestor` (with the payee) |
| **Forwarder** | The transport and logistics company: quotes, takes the shipment, subcontracts legs | Quote: `propose`, `accept`. The main escrow's payee: `add_checkpoint`, `raise_dispute`, `release_to_payer`, `remove_attestor` (with the payer). For each leg, the requester and payer (as the shipper above), and `settle_bond` once the main shipment ends |
| **Carrier** | Moves the goods, or one leg of them, and gets paid: a leg's payee | Quote (leg): `propose`, `accept`. Escrow: `add_checkpoint`, `raise_dispute` (not once a delivery is held), `release_to_payer`, `remove_attestor` (with the payer) |
| **Consignee** | Receives the goods. Needs no wallet when the final-mile proof of delivery is the proof (§7 Q16) | With a wallet: `confirm_delivery`, `raise_dispute`. Without one: reports problems in the app, and the shipper disputes |
| **Attestor** | Trusted third party (port, customs, surveyor), never the payee ([ADR 0006](adr/0006-final-mile-proof-of-delivery.md)) | `add_checkpoint`, `confirm_delivery` |
| **Final-mile agent** | Delivers to the consignee's door (a courier such as DPD or DHL): the last leg's carrier | Attestor on the upstream escrow, never on its own leg. Proof of delivery is a scan, photos and an optional delivery code ([ADR 0006](adr/0006-final-mile-proof-of-delivery.md)) |
| **Arbiter panel** | N independent arbiters; M must agree ([ADR 0002](adr/0002-arbiter-panel.md)) | `vote`, `resolve_by_fallback` |
| **Admin team** | Sets platform rules by M-of-N approval: limits, fee, pilot cap, booking switch, templates ([ADR 0005](adr/0005-platform-booking-privacy.md), [ADR 0011](adr/0011-agreed-booking-terms.md)) | Platform: `propose`, `approve` |
| **Anyone** | Keeps funds moving when parties don't | Escrow: `release_after_window`. Platform: `release_leg` |

## 4. Shipment lifecycle

Negotiation and execution are separate contracts ([ADR 0004](adr/0004-staged-contracts.md)). The escrow can only be created from an agreed quote, on exactly the agreed terms.

```
 Stage 1 · negotiate                          Stage 2 · execute
 Platform.new_quote → QuoteRequest           ShipmentEscrow (payer: shipper, payee: forwarder)
   (shipper ↔ invited forwarders)
   propose / counter / accept ──Agreed──────►   created and funded in one call, on the agreed terms
                                                       │ forwarder subcontracts each leg
 QuoteRequest (forwarder ↔ carriers, per leg)  ShipmentEscrow (payer: forwarder, payee: leg carrier)
   propose / counter / accept ──Agreed──────►   handover = the next party confirms delivery on the incoming
                                                  leg's escrow, then scans in on their own: two calls, two signatures (Q10)
```

Each escrow then follows this lifecycle:

```
  Platform.book (one call)   add_checkpoint()               confirm_delivery()
 ──────────────────► Funded ─────────────────► InTransit ─────────────────────────► Released  (payee paid)
                       │                          │  ▲          by the consignee, or by an attestor
                       │                          └──┘          whose delivery code matched
                       │                          │
                       │                          │ confirm_delivery() by an attestor, no code
                       │                          ▼
                       │                      Delivered ── release_after_window() ──► Released
                       │                          │        (anyone, after the challenge window)
                       │ raise_dispute()          │ raise_dispute() (consignee or shipper)
                       ▼                          ▼
                     Disputed ◄───────────────────┘   (also from InTransit)
                       │
                       │ vote(pct) × M matching   or   resolve_by_fallback() after the window
                       ▼
                   Resolved    (the unpaid remainder split by the panel, or by the fallback)

 Funded / InTransit ── deadline passed, no delivery ──► refund_after_deadline() ──► Refunded
 Funded / InTransit / Delivered ── the payee steps back ──► release_to_payer() ──► Refunded
```

Rules:

1. **Booking:** the payer books and funds the escrow in one call, `Platform.book`, from a quote the platform created and both sides agreed ([ADR 0005](adr/0005-platform-booking-privacy.md), [ADR 0011](adr/0011-agreed-booking-terms.md)). The agreed terms (price, schedule, deadline, attestors, panel, quorum, window, fallback, challenge window) are stored on-chain in full on the quote, and the escrow books exactly those ([decision log](decision-log.md) #4). The goods manifest and the consignee are bound by the job hash only.
2. **Checkpoints:** only the payee or a registered attestor can add one. Each stores a hash of its off-chain evidence, not the evidence itself. Package scans are one `ScanIn`/`ScanOut` checkpoint per location ([§6.6](#66-package-labels-and-custody-scanning)).
3. **Delivery:** the consignee **or** an attestor confirms it, normally the final-mile agent's proof of delivery ([ADR 0006](adr/0006-final-mile-proof-of-delivery.md)). Without that, a consignee who doesn't want to pay could hold the payee's money forever by never confirming.
4. **A held delivery:** a delivery confirmed by the consignee, or by an attestor whose delivery code matched (with every package delivered), pays the remainder in the same call. Any other attestor delivery moves to `Delivered` and holds the remainder for the agreed challenge window, during which the consignee or the shipper can dispute. After it, anyone can release it, so it can't freeze ([ADR 0006](adr/0006-final-mile-proof-of-delivery.md)).
5. **Disputes:** the payer, payee or consignee can raise one before settlement; once a delivery is held, only the consignee or the shipper can. A dispute freezes the unpaid remainder until the panel rules.
6. **Refund:** if the deadline (a block height) passes with no delivery and no dispute, the payer can reclaim the unpaid remainder. Until a refund is claimed, a late delivery can still be confirmed: the first call wins.
7. **Panel:** the dispute resolves as soon as M arbiters vote the same split. If the arbitration window passes without a quorum, any party or arbiter can apply the agreed fallback split, so a deadlocked or absent panel never freezes funds.
8. **Milestones:** each agreed `(location, pct)` pays once, in order, when an attestor signs a scan-in at that location. Delivery pays the remainder. Disputes and refunds act only on the unpaid remainder; paid milestones are final.
9. **Platform fee:** every payout to the payee of a main escrow sends GajuFreight's fee (1%, minimum 1 Gaju, never more than 10% of a payout; voted settings, fixed when the quote is requested) to the treasury, and the payee gets the rest. Refunds carry no fee. A leg's payouts carry none either, but its payer deposits a refundable bond, returned in proportion to what the parent paid its payee ([ADR 0010](adr/0010-platform-fee.md)).
10. **Stepping back:** the payee can release the escrow back to the payer at any time before settlement, which refunds the unpaid remainder ([ADR 0011](adr/0011-agreed-booking-terms.md)).
11. **Attestors:** the payer can add one after booking, never the payee. Removing one needs both payer and payee ([ADR 0006](adr/0006-final-mile-proof-of-delivery.md), [decision log](decision-log.md) #3).

## 5. Contract sketch (Sophia)

This sketch **compiles on Sophia 9.0.0** (the compiler packaged with GajuDesk, Q9), with `PLATFORM_ADDRESS` replaced by an address as the build will do. It isn't tested yet: Phase 1 adds the tests. **The demo model (`scripts/demo`) still implements the earlier design** (for example, delivery always pays at once, with no `Delivered` state), so it isn't an executable reference for this sketch until C10 ([#69](https://github.com/shanepreater/gajufreight/issues/69)) aligns it. It applies the accepted [ADR 0006](adr/0006-final-mile-proof-of-delivery.md) and [ADR 0011](adr/0011-agreed-booking-terms.md), agreed terms stored on-chain in full ([decision log](decision-log.md) #4), an optional consignee (#8), and the [design audit](design-audit.md)'s hardening. Sophia source files use the `.aes` extension.

Compiling found four bugs in the earlier, uncompiled sketch:
- a constructor name used twice: `Refunded` as an event and a status, and `Delivered` as a kind and a status;
- a one-line `switch`, which isn't valid Sophia 9;
- a datatype as an event field;
- a continuation line starting with `&&`.

**No contract calls back into one that's already running.** `Platform.book` clones the escrow, so the escrow's `init` must not call the platform: the platform passes its limits as arguments, and it does the leg accounting itself. A contract re-entering a caller further up the stack isn't verified on Gajumaru (hard rule 7), and this way the design never needs it.

### 5.1 ShipmentEscrow

One per shipment, and one per leg. It holds the money and runs the lifecycle in §4.

```sophia
// shipment-escrow.aes: one instance per shipment, and one per subcontracted leg. Booked only
// by Platform.book, which clones this template (ADR 0011).
@compiler >= 9

include "List.aes"

// The quote's agreed terms, stored on-chain in full (decision log #4). The escrow reads them
// once at booking and books exactly that record (ADR 0004, ADR 0011).
contract interface QuoteRequest =
  record terms =
    { price     : int                 // puck (10¹⁸ puck = 1 Gaju, Q3)
    , schedule  : list(string * int)  // milestones: (location, pct), paid in order
    , deadline  : int                 // block height; the payer can reclaim after it
    , attestors : list(address)
    , panel     : list(address)       // arbiters
    , quorum    : int                 // M of the N arbiters must agree
    , window    : int                 // arbitration window, in blocks
    , fallback  : int                 // payee's % if the window passes without a quorum
    , challenge : int }               // blocks to dispute a delivery made without a code (ADR 0006)
  entrypoint agreement : () => option(address * address * terms * hash)  // requester, payee, terms, job
  entrypoint parent    : () => option(address)  // the main escrow, for a leg quote (ADR 0010)
  entrypoint fee_terms : () => int * int * address  // fee_bps, min_fee, treasury, fixed at request

// What a leg reads from its parent to settle its bond (ADR 0010).
contract interface ParentEscrow =
  entrypoint price         : () => int
  entrypoint paid_to_payee : () => int
  entrypoint is_terminal   : () => bool
  entrypoint deadline      : () => int

payable contract ShipmentEscrow =

  record milestone = { location : string, pct : int, paid : bool }

  datatype status = Funded | InTransit | Delivered | Disputed | Released | Refunded | Resolved

  datatype kind = Milestone | ScanIn | ScanOut | Delivery

  // The indexer never reads live state: it rebuilds each escrow from the booking's call data,
  // the quote's agreed terms (on-chain in full), these events, and evidence-store preimages
  // (ADR 0013). So every state change and every payout emits one. Checkpoints are events
  // only. Event fields can't carry a datatype or an option, hence the codes.
  datatype event =
      Booked(address, address, hash)               // quote, payee, job hash
    | CheckpointAdded(address, int, hash, string)  // attestor, kind code, evidence, location
    | StatusChanged(string)
    | MilestonePaid(string, int)                   // location, amount
    | Voted(address, int)                          // arbiter, payee %
    | Settled(int, int)                            // payee's share before the fee, to payer
    | RefundPaid(int)                              // unpaid remainder returned to the payer
    | FeePaid(address, int)                        // treasury, amount (ADR 0010)
    | BondSettled(int, int)                        // returned to the leg's payer, kept as fee
    | AttestorAdded(address)                       // ADR 0006
    | AttestorRemovalApproved(address, address)    // attestor, first of payer and payee
    | AttestorRemoved(address)

  record state =
    { shipper      : address              // the payer: the shipper, or the forwarder for a leg
    , carrier      : address              // the payee: the forwarder, or a leg's carrier
    , consignee    : option(address)      // None when the final-mile proof is the proof (#8)
    , terms        : QuoteRequest.terms   // as agreed; read-only from here on
    , arbiters     : map(address, bool)
    , attestors    : map(address, bool)
    , max_attestors : int                 // the platform limit at booking, for add_attestor
    , removals     : map(address, address)  // attestor → who approved removing it first
    , votes        : map(address, int)
    , disputed_at  : int
    , delivered_at : int                  // when a delivery without a code started its window
    , manifest     : hash                 // hash of the package list (ADR 0003); stays off-chain
    , schedule     : list(milestone)      // paid on an attestor's ScanIn at each location
    , paid_out     : int                  // paid so far; disputes and refunds act on the rest
    , to_payee     : int                  // gross paid to the payee so far, before the fee
    , fee_bps      : int                  // fixed at quote time (ADR 0010); 0 for a leg
    , min_fee      : int
    , fee_paid     : int
    , treasury     : address
    , parent       : option(address)      // the main escrow, if this is a leg
    , bond         : int                  // a leg's refundable fee bond; 0 for a main escrow
    , bond_settled : bool
    , status       : status }

  // Cloned and funded by Platform.book in one call (ADR 0005, 0011). The platform is the
  // caller, so the payer comes as `shipper`, and the platform's limits come as arguments:
  // calling back into the platform during its own call would be re-entrant. Funding is read
  // from Contract.balance: in init, Call.value is 0 (spike E2b).
  entrypoint init(shipper : address, quote : QuoteRequest, manifest : hash,
                  consignee : option(address), max_panel : int, max_attestors : int,
                  max_price : int) : state =
    require(Call.caller == platform(), "NOT_PLATFORM")
    let (payee, t) =
      switch(quote.agreement(value = 0, gas = 20000))
        None => abort("NOT_AGREED")
        Some((requester, counterparty, agreed, job)) =>
          // Agreed by this payer, for this shipment: a quote can't be reused for another one.
          require(requester == shipper && job == Crypto.blake2b((manifest, consignee)),
                  "NOT_AGREED")
          (counterparty, agreed)
    require(t.price > 0, "BAD_AMOUNT")
    require(max_price == 0 || t.price =< max_price, "OVER_LIMIT")  // pilot cap (ADR 0011)
    require(valid_schedule(t.schedule), "BAD_SCHEDULE")
    require(t.deadline > Chain.block_height && t.window > 0 && t.challenge > 0, "BAD_DEADLINE")
    let arbiters = Map.from_list(List.map((a) => (a, true), t.panel))
    require(List.length(t.panel) =< max_panel && Map.size(arbiters) == List.length(t.panel)
            && t.quorum >= 1 && t.quorum =< List.length(t.panel), "BAD_QUORUM")
    require(List.all((a) => a != shipper && a != payee && Some(a) != consignee, t.panel),
            "CONFLICTED_ARBITER")
    let attestors = Map.from_list(List.map((a) => (a, true), t.attestors))
    require(List.length(t.attestors) =< max_attestors, "BAD_ATTESTORS")
    require(!Map.member(payee, attestors), "CONFLICTED_ATTESTOR")  // no payee pays itself (ADR 0006)
    require(t.fallback >= 0 && t.fallback =< 100, "BAD_SPLIT")
    // A payout to a non-payable contract fails and burns the gas (spike E6b).
    require(Address.is_payable(shipper) && Address.is_payable(payee), "NOT_PAYABLE_PARTY")
    let (bps, min, treasury) = quote.fee_terms(value = 0, gas = 10000)
    require(Address.is_payable(treasury), "BAD_TREASURY")
    // A main escrow skims the fee from payee payouts; a leg's payouts are fee-free, but its
    // payer deposits the fee as a bond (ADR 0010).
    let parent = quote.parent(value = 0, gas = 10000)
    let bond = if (parent == None) 0 else fee_due(bps, min, t.price)
    require(Contract.balance == t.price + bond, "WRONG_AMOUNT")
    let (fee_bps, min_fee) = if (parent == None) (bps, min) else (0, 0)
    Chain.event(Booked(quote.address, payee, Crypto.blake2b((manifest, consignee))))
    { shipper = shipper, carrier = payee, consignee = consignee, terms = t,
      arbiters = arbiters, attestors = attestors, max_attestors = max_attestors,
      removals = {}, votes = {}, disputed_at = 0, delivered_at = 0, manifest = manifest,
      schedule = List.map((m) => switch(m) (l, p) => { location = l, pct = p, paid = false },
                          t.schedule),
      paid_out = 0, to_payee = 0, fee_bps = fee_bps, min_fee = min_fee, fee_paid = 0,
      treasury = treasury, parent = parent, bond = bond, bond_settled = false,
      status = Funded }  // funded at creation: no Created state, no fund()

  // One call per location: the evidence bundle lists every package scanned there.
  stateful entrypoint add_checkpoint(location : string, kind : kind, evidence : hash) =
    require(is_attestor(Call.caller) || Call.caller == state.carrier, "UNAUTHORIZED")
    require(is_open(), "BAD_STATE")
    require(kind != Delivery, "BAD_KIND")  // delivery only via confirm_delivery
    put(state{ status = InTransit })
    Chain.event(CheckpointAdded(Call.caller, kind_code(kind), evidence, location))
    // Only an attestor's scan-in fires a milestone: the payee can't pay itself.
    if (kind == ScanIn && is_attestor(Call.caller))
      release_milestone(location)

  // The consignee, or an attestor whose delivery code matched with every package delivered,
  // releases at once. Any other attestor delivery holds the remainder for the challenge
  // window, so the consignee (or the shipper for them) can dispute it (ADR 0006). Delivery
  // may be confirmed after the deadline until a refund is claimed: the first call wins.
  stateful entrypoint confirm_delivery(evidence : hash, code_checked : bool) =
    let by_consignee = Some(Call.caller) == state.consignee
    require(by_consignee || is_attestor(Call.caller), "UNAUTHORIZED")
    require(is_open(), "BAD_STATE")
    Chain.event(CheckpointAdded(Call.caller, kind_code(Delivery), evidence, "DELIVERED"))
    if (by_consignee || code_checked)
      release_remainder()
    else
      put(state{ status = Delivered, delivered_at = Chain.block_height })
      Chain.event(StatusChanged("Delivered"))

  // After an unchallenged window, anyone can release the held remainder: it can't freeze.
  stateful entrypoint release_after_window() =
    require(state.status == Delivered, "BAD_STATE")
    require(Chain.block_height > state.delivered_at + state.terms.challenge, "CHALLENGE_OPEN")
    release_remainder()

  // Any party while the goods move; once a delivery is held, the consignee or the shipper.
  stateful entrypoint raise_dispute() =
    require(is_party(Call.caller), "UNAUTHORIZED")
    require(is_open() || state.status == Delivered, "BAD_STATE")
    require(state.status != Delivered || Call.caller != state.carrier, "UNAUTHORIZED")
    put(state{ status = Disputed, disputed_at = Chain.block_height })
    Chain.event(StatusChanged("Disputed"))

  // A later vote replaces the arbiter's earlier one; the dispute settles as soon as
  // `quorum` arbiters hold the same split (ADR 0002).
  stateful entrypoint vote(pay_carrier_pct : int) =
    require(Map.member(Call.caller, state.arbiters), "ONLY_ARBITER")
    require(state.status == Disputed, "BAD_STATE")
    require(pay_carrier_pct >= 0 && pay_carrier_pct =< 100, "BAD_SPLIT")
    put(state{ votes[Call.caller] = pay_carrier_pct })
    Chain.event(Voted(Call.caller, pay_carrier_pct))
    if (votes_for(pay_carrier_pct) >= state.terms.quorum)
      settle(pay_carrier_pct)

  // Deadlock or absent panel: after the window anyone involved applies the fallback.
  stateful entrypoint resolve_by_fallback() =
    require(is_party(Call.caller) || Map.member(Call.caller, state.arbiters), "UNAUTHORIZED")
    require(state.status == Disputed, "BAD_STATE")
    require(Chain.block_height > state.disputed_at + state.terms.window, "ARBITRATION_OPEN")
    settle(state.terms.fallback)

  stateful entrypoint refund_after_deadline() =
    require(Call.caller == state.shipper, "ONLY_SHIPPER")
    require(is_open(), "BAD_STATE")
    require(Chain.block_height > state.terms.deadline, "NOT_EXPIRED")
    refund_remainder()

  // The payee gives up its claim to the unpaid remainder (ADR 0011): it can only give away
  // its own money, so it needs no one else's consent.
  stateful entrypoint release_to_payer() =
    require(Call.caller == state.carrier, "ONLY_PAYEE")
    require(is_open() || state.status == Delivered, "BAD_STATE")
    refund_remainder()

  // Adding an attestor can only release the payer's own money, so the payer alone can do
  // it; never the payee (ADR 0006).
  stateful entrypoint add_attestor(a : address) =
    require(Call.caller == state.shipper, "ONLY_SHIPPER")
    require(is_open(), "BAD_STATE")
    require(a != state.carrier, "CONFLICTED_ATTESTOR")
    require(!is_attestor(a) && Map.size(state.attestors) < state.max_attestors, "BAD_ATTESTORS")
    put(state{ attestors[a] = true })
    Chain.event(AttestorAdded(a))

  // Removal needs both payer and payee, in either order (ADR 0006, decision log #3).
  stateful entrypoint remove_attestor(a : address) =
    require(Call.caller == state.shipper || Call.caller == state.carrier, "UNAUTHORIZED")
    require(is_open(), "BAD_STATE")
    require(is_attestor(a), "NOT_ATTESTOR")
    switch(Map.lookup(a, state.removals))
      None =>
        put(state{ removals[a] = Call.caller })
        Chain.event(AttestorRemovalApproved(a, Call.caller))
      Some(first) =>
        require(first != Call.caller, "ALREADY_APPROVED")
        put(state{ attestors = Map.delete(a, state.attestors),
                   removals = Map.delete(a, state.removals) })
        Chain.event(AttestorRemoved(a))

  // A leg's payer recovers its bond in proportion to what the parent paid its payee; the
  // rest is the fee. Allowed once the parent ends or passes its deadline, so it can't be
  // frozen. Settling before a late delivery forfeits more than waiting would.
  stateful entrypoint settle_bond() =
    require(Call.caller == state.shipper, "ONLY_SHIPPER")   // the leg's payer
    require(state.bond > 0, "NO_BOND")
    require(!state.bond_settled, "BOND_SETTLED")
    let p = switch(state.parent)
      None => abort("NO_BOND")
      Some(a) => Address.to_contract(a) : ParentEscrow
    require(p.is_terminal() || Chain.block_height > p.deadline(), "PARENT_OPEN")
    let refund = state.bond * p.paid_to_payee() / p.price()
    put(state{ bond_settled = true })
    Chain.event(BondSettled(refund, state.bond - refund))
    if (state.bond - refund > 0)
      Chain.event(FeePaid(state.treasury, state.bond - refund))
    pay(state.shipper, refund)
    pay(state.treasury, state.bond - refund)

  // Read by legs, by the platform and by the indexer.
  entrypoint price() : int = state.terms.price
  entrypoint payee() : address = state.carrier
  entrypoint is_open() : bool = state.status == Funded || state.status == InTransit
  entrypoint is_leg() : bool = state.parent != None
  entrypoint is_terminal() : bool =
    state.status == Released || state.status == Refunded || state.status == Resolved
  entrypoint paid_to_payee() : int = state.to_payee   // gross, before the fee
  entrypoint deadline() : int = state.terms.deadline
  entrypoint get_status() : status = state.status

  stateful function release_remainder() =
    let remaining = state.terms.price - state.paid_out
    put(state{ status = Released, paid_out = state.terms.price })
    Chain.event(StatusChanged("Released"))
    pay_payee(remaining)

  stateful function refund_remainder() =
    let remaining = state.terms.price - state.paid_out
    put(state{ status = Refunded, paid_out = state.terms.price })
    Chain.event(StatusChanged("Refunded"))
    Chain.event(RefundPaid(remaining))
    pay(state.shipper, remaining)

  // Splits only what hasn't been paid; paid milestones are final. Rounding dust goes to the payer.
  stateful function settle(pct : int) =
    let remaining = state.terms.price - state.paid_out
    let to_carrier = remaining * pct / 100
    put(state{ status = Resolved, paid_out = state.terms.price })
    Chain.event(StatusChanged("Resolved"))
    Chain.event(Settled(to_carrier, remaining - to_carrier))
    pay_payee(to_carrier)                       // the fee applies only to the payee's share
    pay(state.shipper, remaining - to_carrier)

  // Pays the next unpaid milestone, once, and only at its own location. Each pays its
  // cumulative share minus what's already paid, so rounding lands on the last payout.
  stateful function release_milestone(location : string) =
    switch(List.find((m) => !m.paid, state.schedule))
      None => ()
      Some(next) =>
        if (next.location == location)
          let reached = List.sum(List.map((m) => m.pct, List.filter((m) => m.paid, state.schedule))) + next.pct
          let due = state.terms.price * reached / 100 - state.paid_out
          let marked = List.map((x) => if (x.location == location) x{ paid = true } else x, state.schedule)
          put(state{ schedule = marked, paid_out = state.paid_out + due })
          Chain.event(MilestonePaid(location, due))
          pay_payee(due)

  // Every payout to the payee carries the fee owed on all it has received so far, so the
  // total is exact and rounding lands on the last payout (ADR 0010). Spends come last.
  stateful function pay_payee(gross : int) =
    let fee = fee_due(state.fee_bps, state.min_fee, state.to_payee + gross) - state.fee_paid
    put(state{ to_payee = state.to_payee + gross, fee_paid = state.fee_paid + fee })
    if (fee > 0)
      Chain.event(FeePaid(state.treasury, fee))
    pay(state.treasury, fee)
    pay(state.carrier, gross - fee)

  // Every value transfer goes through here. Zero amounts are skipped: a zero spend would
  // create an empty account or fail on a contract (spike E12).
  stateful function pay(to : address, amount : int) =
    if (amount > 0)
      Chain.spend(to, amount)

  // A percentage with a minimum, never more than 10% of what was received (ADR 0010).
  function fee_due(bps : int, min : int, received : int) : int =
    if (received == 0) 0
    else
      let pct = received * bps / 10000
      let fee = if (pct > min) pct else min
      let cap = received * 1000 / 10000
      if (fee < cap) fee else cap

  // The canonical Platform for this network, substituted into the template at build time
  // (an `ak_…` literal of the platform's address). Never caller-supplied.
  function platform() : address = PLATFORM_ADDRESS

  function kind_code(k : kind) : int =
    switch(k)
      Milestone => 0
      ScanIn    => 1
      ScanOut   => 2
      Delivery  => 3

  function is_attestor(a : address) : bool = Map.member(a, state.attestors)
  function is_party(a : address) : bool =
    a == state.shipper || a == state.carrier || Some(a) == state.consignee
  // Each 1..100, unique places, total ≤ 100. A continuation line can't start with && in
  // Sophia 9, so each line ends with it.
  function valid_schedule(s : list(string * int)) : bool =
    List.all((m) => switch(m) (_, p) => p >= 1 && p =< 100, s) &&
      List.sum(List.map((m) => switch(m) (_, p) => p, s)) =< 100 &&
      Map.size(Map.from_list(s)) == List.length(s)
  function votes_for(pct : int) : int =  // bounded by the panel size
    List.length(List.filter((v) => switch(v) (_, p) => p == pct, Map.to_list(state.votes)))
```

### 5.2 QuoteRequest

The negotiation stage is its own contract and never holds money ([ADR 0004](adr/0004-staged-contracts.md)). Each offer carries the full terms, so an accepted agreement can always be read on-chain.

```sophia
// quote-request.aes: one per shipment request, and one per subcontracted leg. Cloned by
// Platform.new_quote, which passes the real requester and its current settings. It never
// holds money (ADR 0004).
@compiler >= 9

include "List.aes"

contract QuoteRequest =

  // Every term that moves money, stored on-chain in full in each offer (ADR 0011, decision
  // log #4), so both sides, and anyone later, can read exactly what was agreed. The goods
  // manifest and the consignee stay off-chain, as the job hash.
  record terms =
    { price     : int
    , schedule  : list(string * int)
    , deadline  : int
    , attestors : list(address)
    , panel     : list(address)
    , quorum    : int
    , window    : int
    , fallback  : int
    , challenge : int }

  datatype status = Open | Agreed | Withdrawn
  record offer = { terms : terms, valid_until : int, by : address, round : int }

  // Event fields can't carry a record: the indexer reads an offer's terms from the
  // propose call's data, and the hash here identifies them.
  datatype event =
      Proposed(address, address, hash)  // invitee, by, terms hash
    | Accepted(address, hash)           // invitee, terms hash
    | RequestWithdrawn

  record state =
    { requester  : address
    , invited    : map(address, bool)
    , job        : hash                  // blake2b((manifest, consignee)); the escrow checks it
    , offers     : map(address, offer)   // one thread per invitee
    , max_rounds : int                   // from Platform when created (ADR 0005)
    , parent     : option(address)       // the main escrow, if this is a leg (ADR 0010)
    , fee_terms  : int * int * address   // fee_bps, min_fee, treasury when requested (ADR 0010)
    , status     : status
    , agreed     : option(address * terms) }

  entrypoint init(requester : address, invited : list(address), job : hash, max_rounds : int,
                  parent : option(address), fee_terms : int * int * address) : state =
    require(invited != [] && !List.contains(requester, invited), "NOT_INVITED")  // no self-invites
    { requester = requester, invited = Map.from_list(List.map((a) => (a, true), invited)),
      job = job, offers = {}, max_rounds = max_rounds, parent = parent,
      fee_terms = fee_terms, status = Open, agreed = None }

  // The requester or the invitee replaces the offer on the invitee's thread. The escrow
  // checks the terms in full at booking; the app checks them before building this call.
  stateful entrypoint propose(invitee : address, t : terms, valid_until : int) =
    require(on_thread(Call.caller, invitee), "NOT_INVITED")
    require(state.status == Open, "BAD_STATE")
    let round =
      switch(Map.lookup(invitee, state.offers))
        None    => 1
        Some(o) => o.round + 1
    require(round =< state.max_rounds, "ROUND_LIMIT")  // the N-th offer is final
    require(valid_until > Chain.block_height, "OFFER_EXPIRED")
    put(state{ offers[invitee] = { terms = t, valid_until = valid_until, by = Call.caller,
                                   round = round } })
    Chain.event(Proposed(invitee, Call.caller, Crypto.blake2b(t)))

  // The other side accepts exactly the terms it saw, named by their hash; every other
  // thread closes.
  stateful entrypoint accept(invitee : address, terms_hash : hash) =
    require(on_thread(Call.caller, invitee), "NOT_INVITED")
    require(state.status == Open, "BAD_STATE")
    let o = switch(Map.lookup(invitee, state.offers))
      None => abort("NO_OFFER")
      Some(x) => x
    require(o.by != Call.caller, "OWN_OFFER")
    require(Crypto.blake2b(o.terms) == terms_hash, "TERMS_CHANGED")
    require(Chain.block_height =< o.valid_until, "OFFER_EXPIRED")
    put(state{ status = Agreed, agreed = Some((invitee, o.terms)) })
    Chain.event(Accepted(invitee, terms_hash))

  stateful entrypoint withdraw() =
    require(Call.caller == state.requester, "ONLY_REQUESTER")
    require(state.status == Open, "BAD_STATE")
    put(state{ status = Withdrawn })
    Chain.event(RequestWithdrawn)

  entrypoint agreement() : option(address * address * terms * hash) =
    switch(state.agreed)
      None => None
      Some((counterparty, t)) => Some((state.requester, counterparty, t, state.job))

  entrypoint offer(invitee : address) : option(offer) = Map.lookup(invitee, state.offers)
  entrypoint parent() : option(address) = state.parent
  entrypoint fee_terms() : int * int * address = state.fee_terms

  function on_thread(a : address, invitee : address) : bool =
    Map.member(invitee, state.invited) && (a == state.requester || a == invitee)
```

### 5.3 Platform

Settings, templates and the registry are a third entity, controlled by an M-of-N admin multisig ([ADR 0005](adr/0005-platform-booking-privacy.md)). Every quote and escrow is a clone of a voted template, booked through the platform ([ADR 0011](adr/0011-agreed-booking-terms.md)).

```sophia
// platform.aes: one per deployment, controlled by an M-of-N admin multisig. It holds the
// settings, clones every quote and escrow from voted templates, and keeps the registry that
// tells genuine quotes, escrows and legs apart (ADR 0005, 0010, 0011).
@compiler >= 9

include "List.aes"

// What the platform needs of a quote: its init (to clone it), its parent and agreed price.
contract interface QuoteRequest =
  record terms =
    { price : int, schedule : list(string * int), deadline : int, attestors : list(address)
    , panel : list(address), quorum : int, window : int, fallback : int, challenge : int }
  entrypoint init : (address, list(address), hash, int, option(address), int * int * address) => void
  entrypoint agreement : () => option(address * address * terms * hash)
  entrypoint parent : () => option(address)

// What the platform needs of an escrow: its init (to clone it) and what legs check.
contract interface ShipmentEscrow =
  entrypoint init : (address, QuoteRequest, hash, option(address), int, int, int) => void
  entrypoint payee : () => address
  entrypoint is_open : () => bool
  entrypoint is_terminal : () => bool
  entrypoint paid_to_payee : () => int

main contract Platform =

  datatype change = SetSetting(string, int) | SetTreasury(address)
                  | SetEscrowTemplate(address) | SetQuoteTemplate(address)
                  | AddAdmin(address) | RemoveAdmin(address)
  record proposal = { change : change, approvals : map(address, bool), expires : int }
  record escrow_info = { parent : option(address), price : int, released : bool }

  // Event fields can't carry a datatype: the indexer reads a proposal's change from the
  // propose call's data.
  datatype event = Proposed(int, address) | Applied(int)       // proposal id, proposer
                 | QuoteCreated(address, address)              // quote, requester
                 | EscrowBooked(address, address, address)     // escrow, quote, payer
                 | LegReleased(address, int)                   // leg, budget returned to its parent

  record state =
    { admins          : map(address, bool)
    , quorum          : int                    // M admin approvals apply a change
    , settings        : map(string, int)
    , treasury        : address                // receives platform fees (ADR 0010)
    , escrow_template : option(ShipmentEscrow)
    , quote_template  : option(QuoteRequest)
    , quotes          : map(address, bool)        // every quote this platform cloned
    , escrows         : map(address, escrow_info) // every escrow it booked, legs with their parent
    , leg_total       : map(address, int)         // leg value booked against each main escrow
    , proposals       : map(int, proposal)
    , next_id         : int }

  entrypoint init(admins : list(address), quorum : int, treasury : address) : state =
    let set = Map.from_list(List.map((a) => (a, true), admins))
    require(Map.size(set) == List.length(admins), "BAD_QUORUM")  // no duplicate admins
    require(quorum >= 1 && quorum =< List.length(admins), "BAD_QUORUM")
    require(Address.is_payable(treasury), "BAD_TREASURY")
    { admins = set, quorum = quorum,
      settings = { ["max_rounds"] = 5, ["max_panel"] = 7, ["max_attestors"] = 10,
                   ["max_invited"] = 20, ["fee_bps"] = 100, ["min_fee"] = 1000000000000000000,
                   ["max_price"] = 0,          // pilot cap in puck; 0 means none (ADR 0011)
                   ["bookings_open"] = 1,      // 0 stops new quotes and bookings, never live escrows
                   ["proposal_ttl"] = 3360 },  // blocks a proposal stays open (≈ 7 days)
      treasury = treasury, escrow_template = None, quote_template = None, quotes = {},
      escrows = {}, leg_total = {}, proposals = {}, next_id = 0 }

  // An admin proposes a change; it counts as their approval.
  stateful entrypoint propose(change : change) : int =
    require(Map.member(Call.caller, state.admins), "ONLY_ADMIN")
    require(valid(change), "BAD_SETTING")
    let id = state.next_id
    put(state{ proposals[id] = { change = change, approvals = { [Call.caller] = true },
                                 expires = Chain.block_height + setting("proposal_ttl") },
               next_id = id + 1 })
    Chain.event(Proposed(id, Call.caller))
    apply_if_ready(id)
    id

  stateful entrypoint approve(id : int) =
    require(Map.member(Call.caller, state.admins), "ONLY_ADMIN")
    let p = switch(Map.lookup(id, state.proposals))
      None    => abort("NO_PROPOSAL")
      Some(x) => x
    require(Chain.block_height =< p.expires, "PROPOSAL_EXPIRED")  // design audit F28
    put(state{ proposals[id].approvals[Call.caller] = true })
    apply_if_ready(id)

  // A leg quote names its parent: one of this platform's main escrows, still open, paying
  // the caller. The quote carries today's fee terms, fixed for the whole negotiation.
  stateful entrypoint new_quote(invited : list(address), job : hash,
                                parent : option(address)) : QuoteRequest =
    require(setting("bookings_open") == 1, "BOOKINGS_CLOSED")
    require(List.length(invited) =< setting("max_invited"), "BAD_INVITED")
    switch(parent)
      None => ()
      Some(p) =>
        let info = switch(Map.lookup(p, state.escrows))
          None    => abort("UNKNOWN_ESCROW")
          Some(i) => i
        require(info.parent == None, "NOT_MAIN")
        let e = Address.to_contract(p) : ShipmentEscrow
        require(e.payee() == Call.caller, "NOT_PAYEE")
        require(e.is_open(), "BAD_STATE")
    let template = switch(state.quote_template)
      None    => abort("NO_TEMPLATE")
      Some(t) => t
    let fees = (setting("fee_bps"), setting("min_fee"), state.treasury)
    let q = Chain.clone(ref = template, Call.caller, invited, job, setting("max_rounds"),
                        parent, fees)
    put(state{ quotes[q.address] = true })
    Chain.event(QuoteCreated(q.address, Call.caller))
    q

  // Books and funds an escrow from an agreed quote in one call (ADR 0005, 0011). The clone's
  // init checks the agreement and the terms; it never calls back into the platform, so this
  // passes the limits it needs. A leg's price counts against its parent's (ADR 0010).
  payable stateful entrypoint book(quote : QuoteRequest, manifest : hash,
                                   consignee : option(address)) : ShipmentEscrow =
    require(setting("bookings_open") == 1, "BOOKINGS_CLOSED")
    require(Map.member(quote.address, state.quotes), "UNKNOWN_QUOTE")
    let price = switch(quote.agreement())
      None => abort("NOT_AGREED")
      Some((_, _, t, _)) => t.price
    let parent = quote.parent()
    switch(parent)
      None => ()
      Some(p) =>
        let total = Map.lookup_default(p, state.leg_total, 0) + price
        require(total =< state.escrows[p].price, "LEG_TOO_LARGE")
        put(state{ leg_total[p] = total })
    let template = switch(state.escrow_template)
      None    => abort("NO_TEMPLATE")
      Some(t) => t
    let e = Chain.clone(ref = template, value = Call.value, Call.caller, quote, manifest,
                        consignee, setting("max_panel"), setting("max_attestors"),
                        setting("max_price"))
    put(state{ escrows[e.address] = { parent = parent, price = price, released = false } })
    Chain.event(EscrowBooked(e.address, quote.address, Call.caller))
    e

  // Once a leg ends, anyone can return the part of its price never paid to its carrier to
  // the parent's leg budget, once, so a failed carrier can be replaced (ADR 0011). A pull:
  // no refund path ever depends on a call into the platform.
  stateful entrypoint release_leg(leg : address) =
    let info = switch(Map.lookup(leg, state.escrows))
      None    => abort("NOT_LEG")
      Some(i) => i
    let p = switch(info.parent)
      None    => abort("NOT_LEG")
      Some(x) => x
    require(!info.released, "LEG_RELEASED")
    let e = Address.to_contract(leg) : ShipmentEscrow
    require(e.is_terminal(), "LEG_OPEN")
    let returned = info.price - e.paid_to_payee()
    put(state{ escrows[leg].released = true, leg_total[p] = state.leg_total[p] - returned })
    Chain.event(LegReleased(leg, returned))

  entrypoint is_quote(a : address) : bool = Map.member(a, state.quotes)
  entrypoint is_escrow(a : address) : bool = Map.member(a, state.escrows)
  entrypoint setting(key : string) : int = state.settings[key]
  entrypoint treasury() : address = state.treasury

  stateful function apply_if_ready(id : int) =
    let p = state.proposals[id]
    if (Map.size(p.approvals) >= state.quorum)
      // Re-check: state may have changed since it was proposed (e.g. two removals).
      require(valid(p.change), "BAD_SETTING")
      switch(p.change)
        SetSetting(k, v)     => put(state{ settings[k] = v })
        SetTreasury(t)       => put(state{ treasury = t })
        SetEscrowTemplate(a) => put(state{ escrow_template = Some(Address.to_contract(a)) })
        SetQuoteTemplate(a)  => put(state{ quote_template = Some(Address.to_contract(a)) })
        AddAdmin(a)          => put(state{ admins[a] = true })
        RemoveAdmin(a)       => put(state{ admins = Map.delete(a, state.admins) })
      put(state{ proposals = Map.delete(id, state.proposals) })
      Chain.event(Applied(id))

  // Only known settings, within bounds; never leave fewer admins than the quorum.
  function valid(c : change) : bool =
    switch(c)
      SetSetting(k, v)     => Map.member(k, state.settings) && in_bounds(k, v)
      SetTreasury(t)       => Address.is_payable(t)   // else every payout would fail (spike E6b)
      SetEscrowTemplate(a) => Address.is_contract(a)
      SetQuoteTemplate(a)  => Address.is_contract(a)
      AddAdmin(a)          => !Map.member(a, state.admins)
      RemoveAdmin(a)       => Map.member(a, state.admins) && Map.size(state.admins) - 1 >= state.quorum

  // The rate is capped at 10%, and fee_due caps the minimum there too, so a captured
  // quorum can't take more (ADR 0010).
  function in_bounds(k : string, v : int) : bool =
    if (k == "fee_bps") v >= 0 && v =< 1000
    elif (k == "min_fee" || k == "max_price") v >= 0
    elif (k == "bookings_open") v == 0 || v == 1
    else v >= 1
```

### 5.4 Deploying one instance per shipment

The platform clones a voted template for every quote and escrow (`Chain.clone`, verified on testnet with value, spike E4). A clone points at the template's code and source, so a booking stores no new copy of them on-chain and costs about a third less than a full create at the escrow's size (spike [round 2](spikes/phase-0-testnet.md#round-2-2026-10-06), E14 and E18).

**Deployment order** ([ADR 0011](adr/0011-agreed-booking-terms.md)):
1. Deploy `Platform`.
2. Build the escrow template with its address in place of `PLATFORM_ADDRESS`.
3. Deploy both templates.
4. The admins vote `SetEscrowTemplate` and `SetQuoteTemplate`.

Live escrows are never upgraded. A fix ships as a new template, voted in, while existing escrows run to completion on the code they started with.

## 6. Key design decisions

### 6.1 Escrow and waybill live in the same contract

An earlier draft kept the escrow on Groot and the waybill on an Associate Chain, with Groot releasing funds "on proof from the AC". **That doesn't work as described.** According to the Un-White Paper, Groot and an Associate Chain are connected only by a value-transfer protocol (deposits and withdrawals), and Groot "does not need to know anything about what happens inside an Associate Chain". No documented mechanism lets a Groot contract read AC contract state.

Keeping the escrow and the tracking state machine in one contract, on one chain, means the release condition is checked where the funds are held.

### 6.2 Where the contract runs

| Option | Pros | Cons | When |
| :--- | :--- | :--- | :--- |
| **Groot (root chain)** | Simplest. No AC to run. Strongest finality: witness-finalised about one keyblock behind the top on mainnet ([spike round 2](spikes/phase-0-testnet.md#round-2-2026-10-06)); the depth used is a per-network setting (§7 Q17). | Groot fees for every checkpoint. | **MVP / testnet** |
| **Existing public AC** | Cheaper and faster milestones. | Depends on another AC's operators. Funds must be deposited and withdrawn. | When one is available |
| **Dedicated freight AC** | Own consensus, block times and fee policy. Can be permissioned for regulated parties. | We run operators and validators. More operational load. | Once volume or compliance needs justify it |

The contract is the same in each case. Only the deployment target changes, which keeps the decision open.

### 6.3 Trust model for attestations

On-chain logic can only be as honest as the parties who sign attestations. The MVP relies on a **named, fixed attestor set per shipment**, agreed by the shipper and carrier when the shipment is booked. Later options:

- **M-of-N attestation** before delivery counts (for example, carrier plus port agent).
- **Staked attestors** who lose their stake on a successful dispute.
- **Signed device telemetry** (tamper-evident trackers), with the signature checked off-chain and only the hash anchored on-chain.

The Un-White Paper doesn't document a native oracle primitive for Gajumaru, so the oracle role is played by attestor accounts calling the contract, as above.

### 6.4 Data on-chain vs off-chain

Status, parties, amounts, **the agreed terms in full** (price, schedule, attestors, panel and dispute terms, deadline, fee terms; [decision log](decision-log.md) #4) and **evidence hashes** go on-chain. The goods manifest and personal data go on-chain only as hashes. Raw telemetry, photos and documents are stored off-chain in a private evidence store ([ADR 0013](adr/0013-off-chain-data.md)), and the hash lets anyone holding the document check it. Checkpoints are events, not contract state, and should stay few: record milestones and one scan checkpoint per location, not GPS pings or one entry per package.

**Data TTL** sets how long a chain object stays on-chain after inclusion, as a span of block heights. Groot doesn't enforce it yet (that needs a hard fork), so it has no effect on gas or pruning today ([QPQ Q&A](qpq-q-and-a.md#data-ttl)). We don't depend on it: the escrow must never expire while it holds funds, and how a TTL is set on contract state is still a follow-up (Q2).

### 6.5 Signing and payment UX

- Parties sign with their existing Gajumaru wallets (GajuDesk / GajuMobile) using **GRIDS** QR payloads. GajuFreight never holds user keys.
- Settlement confirmation can use the same pattern as **GajuPay**: watch microblocks (≈3 s) for the expected transaction and treat keyblock finality as final.

### 6.6 Package labels and custody scanning

Every handling unit carries a printed QR label that only **identifies** it (`gajufreight://s/<contract>/p/<package-id>`). A label is checked against the booking `manifest` hash, then the attestor or carrier scans all units at a location and signs **one** `ScanIn` or `ScanOut` checkpoint whose evidence lists them. Missing, unknown and duplicate-sighted packages are recorded as exceptions rather than blocking the shipment. Full design: [ADR 0003](adr/0003-package-labels-and-scanning.md).

### 6.7 Staged contracts and milestones

Negotiating, executing and subcontracting are separate, small contracts ([ADR 0004](adr/0004-staged-contracts.md)). A `QuoteRequest` holds no money: invited parties propose and counter, and the other side accepts exactly the terms it saw. A `ShipmentEscrow` can only be created from an agreed quote: it checks the agreement with one read-only `agreement()` call. Under [ADR 0011](adr/0011-agreed-booking-terms.md) it reads the agreed terms from the quote, where they're stored in full, instead of recomputing a hash. Each subcontracted leg is another quote and escrow between the forwarder and that leg's carrier, so every escrow conserves its own funds and the forwarder's margin is just the difference. Milestones pay on an attestor's scan-in, so no payee can release money to themselves. Today that rests on the booking not listing the payee as an attestor; [ADR 0006](adr/0006-final-mile-proof-of-delivery.md) proposes enforcing it (`CONFLICTED_ATTESTOR`).

### 6.8 Privacy standard

Everything on-chain is public. By default we keep the contracts simple and cheap, and enforce confidentiality **in the app**: screens, API responses, exports and logs are filtered by the viewer's role. We also document what remains inspectable on-chain. We don't add cryptographic hiding schemes (commit-reveal, encryption) unless that's explicitly decided ([ADR 0005](adr/0005-platform-booking-privacy.md)). Applied so far:

- **Arbiter votes** are stored in the clear. The app shows an arbiter the other votes only after they've cast their own.
- **Agreed terms are public by decision** ([decision log](decision-log.md) #4, #5). Every accepted agreement, legs included, is on-chain in full, so both parties can rely on it later. That means a chain reader can see each leg's price and the forwarder's margin. The app still shows leg prices only to the forwarder and that leg's carrier.
- **Platform fees** are public: the fee settings, the treasury address, each quote's fee terms, every `FeePaid` event and each leg's bond and parent, so anyone can total GajuFreight's fee income and see which escrows are legs of which shipment. A zero fee alone doesn't mark a leg: fees can be voted to zero, and a refunded main escrow pays none ([ADR 0010](adr/0010-platform-fee.md)).

## 7. Open questions

Answered questions move into the design above and keep their row here as a record. Protocol questions go to the QPQ dev team (asked 2026-10-03). Their answers and our follow-up questions are in the [QPQ Q&A](qpq-q-and-a.md). The Phase 0 spike verifies each answer on testnet before the contracts rely on it.

| # | Question | Status | Why it matters |
| :-: | :--- | :--- | :--- |
| 1 | Is `Chain.clone` available on Gajumaru FATE (testnet and mainnet), and what does it cost compared with a full deployment? | **Partly answered (QPQ):** a clone pays only for its own state and `init`, not the code. Availability, gas and funding a clone are [follow-ups](qpq-q-and-a.md#contract-cloning). **Verified on testnet ([spike](spikes/phase-0-testnet.md) E4, E11):** `Chain.clone` works from a contract, funded in the same call; a clone shares its template's bytecode hash. **Costed in [round 2](spikes/phase-0-testnet.md#round-2-2026-10-06) (E14, E18):** a 4.4 KB escrow cost 2.23 × 10¹⁴ puck to create and 2.01 × 10¹⁴ to clone. A call's fixed charge outweighs a create's at small sizes, so clones save about a third only at full escrow size. | Per-shipment cost; fallback in [§5.4](#54-deploying-one-instance-per-shipment) |
| 2 | Data TTL: what is the API, and does it apply to contract state or only to some transaction types? | **Partly answered (QPQ):** a span of block heights from inclusion, not yet enforced on Groot (needs a hard fork). How to set it on contract state is a [follow-up](qpq-q-and-a.md#data-ttl). | Whether settled shipment state can be pruned ([§6.4](#64-data-on-chain-vs-off-chain)) |
| 3 | Smallest Gaju denomination: its name and decimal precision? | **Answered (QPQ):** the puck; 10¹⁸ puck = 1 Gaju, so the demo's placeholder holds ([Q&A](qpq-q-and-a.md#denomination)). | Amount types end to end |
| 4 | Is there a public testnet we can deploy to? | **Answered 2026-10-02 (QPQ):** yes. Deploy with GajuDesk and pay gas from the faucet ([ecosystem reference §4](ecosystem-reference.md#4-deploying-contracts-to-testnet)). Whether a public AC testnet exists is still open; the MVP doesn't need one. | MVP deployment target |
| 5 | Arbitration model? | **Decided 2026-10-03:** an M-of-N arbiter panel with a deadline fallback ([ADR 0002](adr/0002-arbiter-panel.md)) | Dispute entrypoints and UI |
| 6 | Protected accounts (Travel Rule co-signing): does `Chain.spend` to a protected carrier account need a co-signature, fail, or queue? | **Answered (QPQ):** Groot has no protected accounts, so `Chain.spend` payouts can't stall there. They exist only on Associate Chains, under that AC's rules ([Q&A](qpq-q-and-a.md#protected-accounts)). **Verified on testnet ([spike](spikes/phase-0-testnet.md) E6):** payouts arrive with no co-signature. A contract payee must be `payable`, or the payout fails and burns the gas (E6b). | Payouts could stall |
| 7 | Is there a maintained client for the node HTTP API (submit transactions, read microblocks and contract events)? What are the public endpoints and spec? | **Partly answered (QPQ):** no SDK; the node's HTTP API is the interface, with Hakuzaru's `hz` module as the best reference. Public endpoints are listed. Reading events and microblocks, and finality, are [follow-ups](qpq-q-and-a.md#node-api). **Verified on testnet ([spike](spikes/phase-0-testnet.md) E7, E8):** events are read from `/transactions/{hash}/info` and recognised by name hash; agreement hashes can be rebuilt off-chain. **[Round 2](spikes/phase-0-testnet.md#round-2-2026-10-06):**<br>• The node publishes its OpenAPI spec at `/api`.<br>• Testnet's node pushes SSE (contract events and calls, top header, balances) and reports finality per transaction; mainnet's older node does neither yet.<br>• No public endpoint encodes FATE, and no rate limits were seen.<br>• A clone's `init` events appear in the booking transaction's log (E15). | Indexer and API ([ADR 0001](adr/0001-python-fastapi-uv-workspace.md)) |
| 8 | What is the GRIDS payload format for *contract calls* (not only spends), and how does GajuDesk/GajuMobile show it before signing? | **Partly answered (QPQ):** the payload is the unsigned call data; the wallet returns the signed and unsigned data and its public key. A safer request format (chain, contract, function, args) is coming. Transport and wallet display are [follow-ups](qpq-q-and-a.md#grids). **Verified with GajuDesk 0.9.0 ([round 2](spikes/phase-0-testnet.md#round-2-2026-10-06), E9):**<br>• A dead-drop URL delivers the request.<br>• The wallet POSTs the signed transaction back, and the service submits it.<br>• A payable call, a funded create and a sign-in message all worked.<br>• The dialog shows raw transaction data only (no contract, function or amount).<br>GajuMobile 0.2.1 (Android emulator, [spike E9b](spikes/phase-0-testnet.md#e9b-gajumobile-2026-10-06)): the same, plus deep links work; it fetches only over HTTPS, and it can't sign offline. | The API builds unsigned calls (hard rule 1) |
| 9 | Which Sophia compiler version do GajuDesk and the testnet support? | **Answered (QPQ):** Sophia 9.0.0, the version packaged with GajuDesk ([Q&A](qpq-q-and-a.md#sophia)). **Verified ([spike](spikes/phase-0-testnet.md) E1):** probes compile on 9.0.0 and deploy from GajuDesk. | Pinning `@compiler` |
| 10 | Can one GRIDS request carry several contract calls, signed once? | **Answered (QPQ): no.** One instruction per GRIDS message, so a handover takes two signatures ([Q&A](qpq-q-and-a.md#batching)). **Tested ([round 2](spikes/phase-0-testnet.md#round-2-2026-10-06), E16):** a wrapper contract can't batch them either, because the callees see the wrapper, not the signer, as `Call.caller`. | A handover is the next leg's scan-in plus the incoming leg's delivery ([ADR 0004](adr/0004-staged-contracts.md)) |
| 11 | Roughly what gas does a simple contract call (e.g. a quote `propose`) cost on testnet and mainnet? | **Partly answered (QPQ):** gas varies with payload size, TTL, storage and computation; no figure yet. A ballpark and gas estimation are [follow-ups](qpq-q-and-a.md#fees), and the spike measures it. **Measured on testnet ([spike](spikes/phase-0-testnet.md) E5, E10):** a small call ≈ 3,700 gas, a payout ≈ 9,000, at 10⁹ puck per gas plus a size fee; `/dry_run` gives an exact estimate before signing. **[Round 2](spikes/phase-0-testnet.md#round-2-2026-10-06) (E17, E18):**<br>• 10⁹ puck/gas is the enforced floor.<br>• Unused gas isn't charged.<br>• Every call carries a fixed charge of about 182,600 gas (≈ 0.00018 Gaju a call) that `/dry_run` doesn't include, so the fee shown must add it. | Showing the fee before each negotiation round |
| 12 | Can a contract be created **with value** (payable `init`), and can a contract create another (`Chain.create`)? | **Answered (QPQ): yes to both.** A create transaction carries an amount, and a contract can create or clone another ([Q&A](qpq-q-and-a.md#contract-creation)). **Verified on testnet ([spike](spikes/phase-0-testnet.md) E2–E4), with a change:** in `init`, `Call.value` is 0 and `Contract.balance` holds the amount, so funding checks read the balance. | Atomic booking and `Platform.new_quote` ([ADR 0005](adr/0005-platform-booking-privacy.md)) |
| 13 | How many Pucks (the smallest unit) make one Gaju? | **Answered (QPQ):** 10¹⁸ (see Q3). | Amount display and input (relates to Q3) |
| 14 | Consolidated shipments: one master shipment with final-mile legs, or a hub master with a child shipment per order? | **Deferred to FOC** (2026-10-06, [decision log](decision-log.md) #1); the spike runs then ([ADR 0007](adr/0007-consolidated-shipments.md)) | Bulk shipping of many orders |
| 15 | Should an organisation act on-chain through one org-level contract that delegates to its current members, instead of individual addresses? It covers attesting **and** every other party role: requester, invitee, payer and payee are single addresses, so staff with their own wallets can't quote, accept or fund for the company ([design audit](design-audit.md) F8) | **Decided for the MVP** (2026-10-06, [decision log](decision-log.md) #7): each company names one operating wallet for quotes, escrows and payouts; handlers attest with their own wallets. The org contract is FOC work, and QPQ are asked how GajuPay models it ([Q&A](qpq-q-and-a.md#organisations)) | Handlers who join after booking can't attest; staff can't act for the company without its key |
| 16 | Must every consignee have a Gajumaru wallet? `init` takes the consignee's address, and only a party can dispute. Door-to-door parcel deliveries (ADR 0006, 0007) imply consignees with no wallet, reached by email or SMS | **Decided** (2026-10-06, [decision log](decision-log.md) #8): **no.** When the final-mile proof of delivery is the proof, the consignee is optional on-chain. A consignee without a wallet gets the delivery code and tracking by email and reports problems in the app, and the shipper raises the dispute ([ADR 0006](adr/0006-final-mile-proof-of-delivery.md)) | Who can confirm or dispute delivery; what contact data the app holds |
| 17 | How many keyblocks make a transaction final on Groot mainnet, and how does a client detect a dropped microblock? `/status` reports `finalized` at genesis on testnet | **Partly answered by test ([round 2](spikes/phase-0-testnet.md#round-2-2026-10-06)):**<br>• Mainnet finalises by witness: `finalized` is at top − 1, and key blocks carry testimonies.<br>• Testnet has no witnesses, so it relies on depth: `/transactions/{h}/finality` returns `on_chain` with a depth.<br>**QPQ (2026-10-08):** a transaction in generation G is final once key block G + 1 is sealed by a majority of witness testimonies, i.e. when `finalized` ≥ G + 1. A micro-fork means waiting 2 more key blocks, and a netsplit shows as missing testimonies ([Q&A](qpq-q-and-a.md#node-api)).<br>N stays a per-network setting where there are no witnesses. The day-long fork watch (E13) is pending | Pending vs final in the UI, indexer reorg depth, alert thresholds |
