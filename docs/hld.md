# High-Level Design: GajuFreight

| | |
| :--- | :--- |
| **Status** | Draft |
| **Last reviewed** | 2026-09-26 |
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
| **Shipper** | Requests quotes, agrees a price, funds the escrow | Quote: `propose`, `accept`, `withdraw`. Escrow: create and fund in one call, `raise_dispute`, `refund_after_deadline` |
| **Forwarder** | The transport and logistics company: quotes, takes the shipment, subcontracts legs | Quote: `propose`, `accept`. The escrow's payee; for each leg, the requester and payer |
| **Carrier** | Moves the goods, or one leg of them, and gets paid | Quote (leg): `propose`, `accept`. Escrow: `add_checkpoint`, `raise_dispute` |
| **Consignee** | Receives the goods | `confirm_delivery`, `raise_dispute` |
| **Attestor** | Trusted third party (port, customs, surveyor) | `add_checkpoint`, `confirm_delivery` |
| **Arbiter panel** | N independent arbiters; M must agree ([ADR 0002](adr/0002-arbiter-panel.md)) | `vote`, `resolve_by_fallback` |
| **Admin team** | Sets platform rules (round limit, panel cap) by M-of-N approval ([ADR 0005](adr/0005-platform-booking-privacy.md)) | Platform: `propose`, `approve` |

## 4. Shipment lifecycle

Negotiation and execution are separate contracts ([ADR 0004](adr/0004-staged-contracts.md)). The escrow can only be created from an agreed quote, on exactly the agreed terms.

```
 Stage 1 · negotiate                          Stage 2 · execute
 Platform.new_quote → QuoteRequest           ShipmentEscrow (payer: shipper, payee: forwarder)
   (shipper ↔ invited forwarders)
   propose / counter / accept ──Agreed──────►   created from the agreed terms, then funded
                                                       │ forwarder subcontracts each leg
 QuoteRequest (forwarder ↔ carriers, per leg)  ShipmentEscrow (payer: forwarder, payee: leg carrier)
   propose / counter / accept ──Agreed──────►   handover = the next party confirms delivery on the incoming
                                                  leg's escrow, then scans in on their own: two calls (Q10)
```

Each escrow then follows this lifecycle:

```
  create + fund (one call)   add_checkpoint()          confirm_delivery()
 ──────────────────► Funded ─────────────────► InTransit ──────────────────► Released  (carrier paid)
                       │                          │  ▲
                       │                          └──┘ add_checkpoint()
                       │                          │
                       │ raise_dispute()          │ raise_dispute()
                       ▼                          ▼
                     Disputed ◄───────────────────┘
                       │
                       │ vote(pct) × M matching   or   resolve_by_fallback() after the window
                       ▼
                   Resolved    (funds split by the panel, or by the fallback split)

 Funded / InTransit ── deadline passed, no delivery ──► refund_after_deadline() ──► Refunded
```

Rules:

1. The requester creates and funds the escrow in one call, for exactly the agreed price, from a quote the platform created ([ADR 0005](adr/0005-platform-booking-privacy.md)).
2. Only the carrier or a registered attestor can add a checkpoint. Each checkpoint stores a hash of its off-chain evidence, not the evidence itself. Package scans are one `ScanIn`/`ScanOut` checkpoint per location ([§6.6](#66-package-labels-and-custody-scanning)).
3. Delivery can be confirmed by the consignee **or** by an attestor. Without this, a consignee who doesn't want to pay could hold the carrier's money forever by never confirming.
4. Delivery confirmation and payout happen in one call, so there is no half-finished "Delivered but unpaid" state to handle.
5. The shipper, carrier or consignee can raise a dispute at any point before settlement. A dispute freezes the funds until the panel rules.
6. If the deadline (a block height) passes with no delivery and no dispute, the shipper can reclaim the unpaid remainder.
7. The dispute resolves as soon as M arbiters vote the same split. If the arbitration window passes without a quorum, any party or arbiter can apply the fallback split agreed at booking, so a deadlocked or absent panel never freezes funds.
8. **Milestones:** each agreed `(location, pct)` pays once, when an attestor signs a scan-in at that location. Delivery pays the remainder. Disputes and refunds act only on the unpaid remainder; paid milestones are final.

## 5. Contract sketch (Sophia)

This is a design sketch. It has not been compiled. Pin the compiler version and add tests before relying on it. Sophia source files use the `.aes` extension.

```sophia
@compiler >= 6

include "List.aes"

// The one read the escrow makes of the negotiation stage (ADR 0004).
contract interface QuoteRequest =
  entrypoint agreement : () => option(address * address * hash * hash)  // requester, counterparty, terms, job

// Registry and settings (ADR 0005).
contract interface Platform =
  entrypoint is_quote : (address) => bool
  entrypoint setting  : (string) => int

// shipment-escrow.aes: one instance per shipment, and one per subcontracted leg.
contract ShipmentEscrow =

  record terms     = { price : int, schedule : list(string * int) }  // what was negotiated
  record milestone = { location : string, pct : int, paid : bool }

  datatype status = Funded | InTransit | Disputed | Released | Refunded | Resolved

  datatype kind = Milestone | ScanIn | ScanOut | Delivered

  // The indexer projects the read model from these, so every state change emits one.
  datatype event =
      CheckpointAdded(address, string, hash)  // attestor, location, evidence
    | StatusChanged(string)
    | MilestonePaid(string, int)             // location, amount
    | Voted(address, int)                    // arbiter, carrier %
    | Settled(int, int)                      // to payee, to shipper

  record checkpoint =
    { location  : string
    , kind      : kind
    , evidence  : hash        // hash of the off-chain evidence bundle
    , timestamp : int         // Chain.timestamp (ms)
    , attestor  : address }

  record state =
    { shipper     : address
    , carrier     : address
    , consignee   : address
    , arbiters    : map(address, bool)
    , quorum      : int       // M of N arbiters must agree
    , window      : int       // arbitration window, in blocks
    , fallback    : int       // carrier % if the window passes without a quorum
    , disputed_at : int       // block height of raise_dispute
    , votes       : map(address, int)
    , attestors   : map(address, bool)
    , manifest    : hash      // hash of the package list (ADR 0003)
    , schedule    : list(milestone)  // paid on attested ScanIn at each location
    , paid_out    : int       // milestones paid so far; disputes and refunds act on the rest
    , amount      : int       // the agreed price, in the smallest Gaju denomination
    , deadline    : int       // block height
    , status      : status
    , checkpoints : list(checkpoint) }

  // Created and funded in one call (ADR 0005): Call.value must be the agreed price.
  payable entrypoint init(platform : Platform, carrier : address, consignee : address,
                  attestors : list(address), panel : list(address), quorum : int,
                  window : int, fallback : int, manifest : hash, quote : QuoteRequest,
                  terms : terms, deadline : int) : state =
    let arbiters = Map.from_list(List.map((a) => (a, true), panel))
    let amount = terms.price
    // Only a quote the platform created (no look-alikes) ...
    require(platform.is_quote(quote.address, value = 0, gas = 10000), "UNKNOWN_QUOTE")
    // ... agreed between these parties, on exactly these terms, for this job.
    switch(quote.agreement(value = 0, gas = 20000))
      None => abort("NOT_AGREED")
      Some((requester, counterparty, agreed, job)) =>
        // Crypto.blake2b hashes the FATE serialization of a value. Off-chain code must
        // produce the same bytes through the node client (HLD §7 Q7).
        require(requester == Call.caller && counterparty == carrier
                && agreed == Crypto.blake2b(terms)
                && job == Crypto.blake2b((manifest, consignee, deadline)), "NOT_AGREED")
    require(amount > 0, "BAD_AMOUNT")
    require(Call.value == amount, "WRONG_AMOUNT")
    require(valid_schedule(terms.schedule), "BAD_SCHEDULE")
    require(deadline > Chain.block_height && window > 0, "BAD_DEADLINE")
    require(List.length(panel) =< platform.setting("max_panel", value = 0, gas = 10000),
            "BAD_QUORUM")  // bounded, so votes_for stays cheap
    require(Map.size(arbiters) == List.length(panel), "BAD_QUORUM")  // no duplicates
    require(quorum >= 1 && quorum =< List.length(panel), "BAD_QUORUM")
    require(List.all((a) => a != Call.caller && a != carrier && a != consignee, panel),
            "CONFLICTED_ARBITER")
    require(fallback >= 0 && fallback =< 100, "BAD_SPLIT")
    { shipper     = Call.caller,
      carrier     = carrier,
      consignee   = consignee,
      arbiters    = arbiters,
      quorum      = quorum,
      window      = window,
      fallback    = fallback,
      disputed_at = 0,
      votes       = {},
      manifest    = manifest,
      schedule    = List.map((m) => switch(m) (l, p) => { location = l, pct = p, paid = false },
                             terms.schedule),
      paid_out    = 0,
      attestors   = Map.from_list(List.map((a) => (a, true), attestors)),
      amount      = amount,
      deadline    = deadline,
      status      = Funded,   // funded at creation: no Created state, no fund()
      checkpoints = [] }

  // One call per location: the evidence bundle lists every package scanned there.
  stateful entrypoint add_checkpoint(location : string, kind : kind, evidence : hash) =
    require(is_attestor(Call.caller) || Call.caller == state.carrier, "UNAUTHORIZED")
    require(state.status == Funded || state.status == InTransit, "BAD_STATE")
    require(kind != Delivered, "BAD_KIND")  // delivery only via confirm_delivery
    let cp = { location = location, kind = kind, evidence = evidence,
               timestamp = Chain.timestamp, attestor = Call.caller }
    put(state{ checkpoints = cp :: state.checkpoints, status = InTransit })
    Chain.event(CheckpointAdded(Call.caller, location, evidence))
    // Only an attestor's scan-in fires a milestone: the payee can't pay themselves.
    if (kind == ScanIn && is_attestor(Call.caller))
      release_milestone(location)

  stateful entrypoint confirm_delivery(evidence : hash) =
    require(Call.caller == state.consignee || is_attestor(Call.caller), "UNAUTHORIZED")
    require(state.status == Funded || state.status == InTransit, "BAD_STATE")
    let cp = { location = "DELIVERED", kind = Delivered, evidence = evidence,
               timestamp = Chain.timestamp, attestor = Call.caller }
    let remaining = state.amount - state.paid_out
    put(state{ checkpoints = cp :: state.checkpoints, status = Released, paid_out = state.amount })
    Chain.event(CheckpointAdded(Call.caller, "DELIVERED", evidence))
    Chain.event(StatusChanged("Released"))
    Chain.spend(state.carrier, remaining)

  stateful entrypoint raise_dispute() =
    require(is_party(Call.caller), "UNAUTHORIZED")
    require(state.status == Funded || state.status == InTransit, "BAD_STATE")
    put(state{ status = Disputed, disputed_at = Chain.block_height })
    Chain.event(StatusChanged("Disputed"))

  // pay_carrier_pct: 0..100. A later vote replaces the arbiter's earlier one;
  // the dispute settles as soon as `quorum` arbiters hold the same split.
  stateful entrypoint vote(pay_carrier_pct : int) =
    require(Map.member(Call.caller, state.arbiters), "ONLY_ARBITER")
    require(state.status == Disputed, "BAD_STATE")
    require(pay_carrier_pct >= 0 && pay_carrier_pct =< 100, "BAD_SPLIT")
    put(state{ votes[Call.caller] = pay_carrier_pct })
    Chain.event(Voted(Call.caller, pay_carrier_pct))
    if (votes_for(pay_carrier_pct) >= state.quorum)
      settle(pay_carrier_pct)

  // Deadlock or absent panel: after the window anyone involved applies the fallback.
  stateful entrypoint resolve_by_fallback() =
    require(is_party(Call.caller) || Map.member(Call.caller, state.arbiters), "UNAUTHORIZED")
    require(state.status == Disputed, "BAD_STATE")
    require(Chain.block_height > state.disputed_at + state.window, "ARBITRATION_OPEN")
    settle(state.fallback)

  // Splits only what hasn't been paid; paid milestones are final. Rounding dust goes to the shipper.
  stateful function settle(pct : int) =
    let remaining = state.amount - state.paid_out
    let to_carrier = remaining * pct / 100
    put(state{ status = Resolved, paid_out = state.amount })
    Chain.event(StatusChanged("Resolved"))
    Chain.event(Settled(to_carrier, remaining - to_carrier))
    Chain.spend(state.carrier, to_carrier)
    Chain.spend(state.shipper, remaining - to_carrier)

  // Pays the first unpaid milestone at this location, once.
  // Milestones pay in order: only the next unpaid one, and only at its own location.
  // Each pays its cumulative share minus what's already paid, so rounding lands last.
  stateful function release_milestone(location : string) =
    switch(List.find((m) => !m.paid, state.schedule))
      None => ()
      Some(next) =>
        if (next.location == location)
          let reached = List.sum(List.map((m) => m.pct, List.filter((m) => m.paid, state.schedule))) + next.pct
          let due = state.amount * reached / 100 - state.paid_out
          let marked = List.map((x) => if (x.location == location) x{ paid = true } else x, state.schedule)
          put(state{ schedule = marked, paid_out = state.paid_out + due })
          Chain.event(MilestonePaid(location, due))
          Chain.spend(state.carrier, due)

  stateful entrypoint refund_after_deadline() =
    require(Call.caller == state.shipper, "ONLY_SHIPPER")
    require(state.status == Funded || state.status == InTransit, "BAD_STATE")
    require(Chain.block_height > state.deadline, "NOT_EXPIRED")
    let remaining = state.amount - state.paid_out
    put(state{ status = Refunded, paid_out = state.amount })
    Chain.event(StatusChanged("Refunded"))
    Chain.spend(state.shipper, remaining)

  entrypoint get_status() : status = state.status
  entrypoint get_checkpoints() : list(checkpoint) = state.checkpoints

  function is_attestor(a : address) : bool = Map.member(a, state.attestors)
  function is_party(a : address) : bool =
    a == state.shipper || a == state.carrier || a == state.consignee
  function valid_schedule(s : list(string * int)) : bool =  // each 1..100, unique places, total ≤ 100
    List.all((m) => switch(m) (_, p) => p >= 1 && p =< 100, s)
    && List.sum(List.map((m) => switch(m) (_, p) => p, s)) =< 100
    && Map.size(Map.from_list(s)) == List.length(s)
  function votes_for(pct : int) : int =  // bounded by N
    List.length(List.filter((v) => switch(v) (_, p) => p == pct, Map.to_list(state.votes)))
```

The negotiation stage is its own contract and never holds money ([ADR 0004](adr/0004-staged-contracts.md)):

```sophia
// quote-request.aes: one per shipment request, and one per subcontracted leg.
contract QuoteRequest =

  datatype status = Open | Agreed | Cancelled
  record offer = { terms : hash, valid_until : int, by : address, round : int }
  datatype event = Proposed(address, address, hash) | Agreed(address, hash) | Cancelled  // invitee, by, terms

  record state =
    { requester : address
    , invited   : map(address, bool)
    , job       : hash                  // blake2b((manifest, consignee, deadline)); the escrow checks it
    , offers    : map(address, offer)   // one thread per invitee
    , max_rounds : int                  // from Platform when created (ADR 0005)
    , status    : status
    , agreed    : option(address * hash) }

  // Created by Platform.new_quote, which passes the real requester and its current
  // max_rounds. A quote deployed any other way isn't registered, so no escrow accepts it.
  entrypoint init(requester : address, invited : list(address), job : hash,
                  max_rounds : int) : state =
    require(invited != [] && !List.contains(requester, invited), "NOT_INVITED")  // no self-invites
    { requester = requester, invited = Map.from_list(List.map((a) => (a, true), invited)),
      job = job, offers = {}, max_rounds = max_rounds, status = Open, agreed = None }

  // The requester or the invitee replaces the offer on the invitee's thread.
  stateful entrypoint propose(invitee : address, terms : hash, valid_until : int) =
    require(on_thread(Call.caller, invitee), "NOT_INVITED")
    require(state.status == Open, "BAD_STATE")
    let round = switch(Map.lookup(invitee, state.offers)) None => 1 ; Some(o) => o.round + 1
    require(round =< state.max_rounds, "ROUND_LIMIT")  // the N-th offer is final
    require(valid_until > Chain.block_height, "OFFER_EXPIRED")
    put(state{ offers[invitee] = { terms = terms, valid_until = valid_until, by = Call.caller, round = round } })
    Chain.event(Proposed(invitee, Call.caller, terms))

  // The other side accepts exactly the terms it saw; every other thread closes.
  stateful entrypoint accept(invitee : address, terms : hash) =
    require(on_thread(Call.caller, invitee), "NOT_INVITED")
    require(state.status == Open, "BAD_STATE")
    let o = switch(Map.lookup(invitee, state.offers))
      None => abort("NO_OFFER")
      Some(x) => x
    require(o.by != Call.caller, "OWN_OFFER")
    require(o.terms == terms, "TERMS_CHANGED")
    require(Chain.block_height =< o.valid_until, "OFFER_EXPIRED")
    put(state{ status = Agreed, agreed = Some((invitee, terms)) })
    Chain.event(Agreed(invitee, terms))

  stateful entrypoint withdraw() =
    require(Call.caller == state.requester, "ONLY_REQUESTER")
    require(state.status == Open, "BAD_STATE")
    put(state{ status = Cancelled })
    Chain.event(Cancelled)

  entrypoint agreement() : option(address * address * hash * hash) =
    switch(state.agreed)
      None => None
      Some((counterparty, terms)) => Some((state.requester, counterparty, terms, state.job))

  function on_thread(a : address, invitee : address) : bool =
    Map.member(invitee, state.invited) && (a == state.requester || a == invitee)
```

Settings and the quote registry are a third, separate entity ([ADR 0005](adr/0005-platform-booking-privacy.md)):

```sophia
// platform.aes: one per deployment, controlled by an M-of-N admin multisig.
contract Platform =

  datatype change = SetSetting(string, int) | AddAdmin(address) | RemoveAdmin(address)
  record proposal = { change : change, approvals : map(address, bool) }
  datatype event = Proposed(int, change) | Applied(int, change) | QuoteCreated(address, address)

  record state =
    { admins    : map(address, bool)
    , quorum    : int                    // M admin approvals apply a change
    , settings  : map(string, int)       // "max_rounds" = 5, "max_panel" = 7
    , proposals : map(int, proposal)
    , next_id   : int
    , quotes    : map(address, bool) }   // every QuoteRequest this platform created

  entrypoint init(admins : list(address), quorum : int) : state =
    require(quorum >= 1 && quorum =< List.length(admins), "BAD_QUORUM")
    { admins = Map.from_list(List.map((a) => (a, true), admins)), quorum = quorum,
      settings = { ["max_rounds"] = 5, ["max_panel"] = 7 }, proposals = {}, next_id = 0, quotes = {} }

  // An admin proposes a change; it counts as their approval.
  stateful entrypoint propose(change : change) : int =
    require(Map.member(Call.caller, state.admins), "ONLY_ADMIN")
    require(valid(change), "BAD_SETTING")
    let id = state.next_id
    put(state{ proposals[id] = { change = change, approvals = { [Call.caller] = true } },
               next_id = id + 1 })
    Chain.event(Proposed(id, change))
    apply_if_ready(id)
    id

  stateful entrypoint approve(id : int) =
    require(Map.member(Call.caller, state.admins), "ONLY_ADMIN")
    require(Map.member(id, state.proposals), "NO_PROPOSAL")
    put(state{ proposals[id].approvals[Call.caller] = true })
    apply_if_ready(id)

  // Needs Chain.create from a contract (HLD §7 Q12).
  stateful entrypoint new_quote(invited : list(address), job : hash) : QuoteRequest =
    let q = Chain.create(Call.caller, invited, job, state.settings["max_rounds"]) : QuoteRequest
    put(state{ quotes[q.address] = true })
    Chain.event(QuoteCreated(q.address, Call.caller))
    q

  entrypoint is_quote(a : address) : bool = Map.member(a, state.quotes)
  entrypoint setting(key : string) : int = state.settings[key]

  stateful function apply_if_ready(id : int) =
    let p = state.proposals[id]
    if (Map.size(p.approvals) >= state.quorum)
      // Re-check: state may have changed since it was proposed (e.g. two removals).
      require(valid(p.change), "BAD_SETTING")
      switch(p.change)
        SetSetting(k, v) => put(state{ settings[k] = v })
        AddAdmin(a)      => put(state{ admins[a] = true })
        RemoveAdmin(a)   => put(state{ admins = Map.delete(a, state.admins) })
      put(state{ proposals = Map.delete(id, state.proposals) })
      Chain.event(Applied(id, p.change))

  // Only known settings, at least 1; never leave fewer admins than the quorum.
  function valid(c : change) : bool =
    switch(c)
      SetSetting(k, v) => Map.member(k, state.settings) && v >= 1
      AddAdmin(a)      => !Map.member(a, state.admins)
      RemoveAdmin(a)   => Map.member(a, state.admins) && Map.size(state.admins) - 1 >= state.quorum
```

### 5.1 Deploying one instance per shipment

A single deployed template plus a factory contract that clones it (`Chain.clone` in Sophia ≥ 6) keeps the cost of each shipment low. This works on æternity's FATE VM. **Check that Gajumaru supports it before building on it**, because the Un-White Paper doesn't mention cloning. The fallback is to deploy the full contract for each shipment, or to use a single registry contract that holds a `map(shipment_id, shipment)`.

## 6. Key design decisions

### 6.1 Escrow and waybill live in the same contract

An earlier draft kept the escrow on Groot and the waybill on an Associate Chain, with Groot releasing funds "on proof from the AC". **That doesn't work as described.** According to the Un-White Paper, Groot and an Associate Chain are connected only by a value-transfer protocol (deposits and withdrawals), and Groot "does not need to know anything about what happens inside an Associate Chain". No documented mechanism lets a Groot contract read AC contract state.

Keeping the escrow and the tracking state machine in one contract, on one chain, means the release condition is checked where the funds are held.

### 6.2 Where the contract runs

| Option | Pros | Cons | When |
| :--- | :--- | :--- | :--- |
| **Groot (root chain)** | Simplest. No AC to run. Strongest finality (≈2 keyblocks, 3–4 min). | Groot fees for every checkpoint. | **MVP / testnet** |
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

Only status, parties, amounts and **evidence hashes** go on-chain. Raw telemetry, photos and documents are stored off-chain (object storage or IPFS), and the hash lets anyone check them. The checkpoint list should stay short: record milestones and one scan checkpoint per location, not GPS pings or one entry per package.

The Un-White Paper describes a **Data TTL** mechanism for limiting how much state the chain keeps. How it works isn't specified there, so we won't depend on it until the API is confirmed.

### 6.5 Signing and payment UX

- Parties sign with their existing Gajumaru wallets (GajuDesk / GajuMobile) using **GRIDS** QR payloads. GajuFreight never holds user keys.
- Settlement confirmation can use the same pattern as **GajuPay**: watch microblocks (≈3 s) for the expected transaction and treat keyblock finality as final.

### 6.6 Package labels and custody scanning

Every handling unit carries a printed QR label that only **identifies** it (`gajufreight://s/<contract>/p/<package-id>`). A label is checked against the booking `manifest` hash, then the attestor or carrier scans all units at a location and signs **one** `ScanIn` or `ScanOut` checkpoint whose evidence lists them. Missing, unknown and duplicate-sighted packages are recorded as exceptions rather than blocking the shipment. Full design: [ADR 0003](adr/0003-package-labels-and-scanning.md).

### 6.7 Staged contracts and milestones

Negotiating, executing and subcontracting are separate, small contracts ([ADR 0004](adr/0004-staged-contracts.md)). A `QuoteRequest` holds no money: invited parties propose and counter, and the other side accepts exactly the terms it saw. A `ShipmentEscrow` can only be created from an agreed quote: it recomputes the terms hash from the price and schedule it's given, and checks it with one read-only `agreement()` call. Each subcontracted leg is another quote and escrow between the forwarder and that leg's carrier, so every escrow conserves its own funds and the forwarder's margin is just the difference. Milestones pay on an attestor's scan-in, so no payee can release money to themselves.

### 6.8 Privacy standard

Everything on-chain is public. By default we keep the contracts simple and cheap, and enforce confidentiality **in the app**: screens, API responses, exports and logs are filtered by the viewer's role. We also document what remains inspectable on-chain. We don't add cryptographic hiding schemes (commit-reveal, encryption) unless that's explicitly decided ([ADR 0005](adr/0005-platform-booking-privacy.md)). Applied so far:

- **Arbiter votes** are stored in the clear. The app shows an arbiter the other votes only after they've cast their own.
- **Leg prices and margins** are visible in the app only to the forwarder and that leg's carrier. A chain analyst can still read leg-escrow balances.

## 7. Open questions

Answered questions move into the design above and keep their row here as a record. Protocol questions go to the QPQ dev team (asked 2026-10-03), and answers are cited in [sources](sources.md).

| # | Question | Status | Why it matters |
| :-: | :--- | :--- | :--- |
| 1 | Is `Chain.clone` available on Gajumaru FATE (testnet and mainnet), and what does it cost compared with a full deployment? | Asked QPQ | Per-shipment cost; fallback in [§5.1](#51-deploying-one-instance-per-shipment) |
| 2 | Data TTL: what is the API, and does it apply to contract state or only to some transaction types? | Asked QPQ | Whether settled shipment state can be pruned ([§6.4](#64-data-on-chain-vs-off-chain)) |
| 3 | Smallest Gaju denomination: its name and decimal precision? | Asked QPQ | Amount types end to end (the demo assumes 10¹⁸ as a placeholder) |
| 4 | Is there a public testnet we can deploy to? | **Answered 2026-10-02 (QPQ):** yes. Deploy with GajuDesk and pay gas from the faucet ([ecosystem reference §4](ecosystem-reference.md#4-deploying-contracts-to-testnet)). Whether a public AC testnet exists is still open; the MVP doesn't need one. | MVP deployment target |
| 5 | Arbitration model? | **Decided 2026-10-03:** an M-of-N arbiter panel with a deadline fallback ([ADR 0002](adr/0002-arbiter-panel.md)) | Dispute entrypoints and UI |
| 6 | Protected accounts (Travel Rule co-signing): does `Chain.spend` to a protected carrier account need a co-signature, fail, or queue? | Asked QPQ | Payouts could stall |
| 7 | Is there a maintained client for the node HTTP API (submit transactions, read microblocks and contract events)? What are the public endpoints and spec? | Asked QPQ | Indexer and API ([ADR 0001](adr/0001-python-fastapi-uv-workspace.md)) |
| 8 | What is the GRIDS payload format for *contract calls* (not only spends), and how does GajuDesk/GajuMobile show it before signing? | Asked QPQ | The API builds unsigned calls (hard rule 1) |
| 9 | Which Sophia compiler version do GajuDesk and the testnet support? | Asked QPQ | Pinning `@compiler` |
| 10 | Can one GRIDS request carry several contract calls, signed once? | To ask QPQ | A handover is the next leg's scan-in plus the incoming leg's delivery ([ADR 0004](adr/0004-staged-contracts.md)) |
| 11 | Roughly what gas does a simple contract call (e.g. a quote `propose`) cost on testnet and mainnet? | To ask QPQ | Showing the fee before each negotiation round |
| 12 | Can a contract be created **with value** (payable `init`), and can a contract create another (`Chain.create`)? | To ask QPQ | Atomic booking and `Platform.new_quote` ([ADR 0005](adr/0005-platform-booking-privacy.md)) |
