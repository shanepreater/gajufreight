# High-Level Design: GajuFreight

| | |
| :--- | :--- |
| **Status** | Draft |
| **Last reviewed** | 2026-09-26 |
| **Related** | [Architecture](architecture-blueprint.md) · [Development approach](dev-approach.md) · [Sources](sources.md) |

## 1. Purpose

GajuFreight is a shipment-tracking and escrow-settlement service on the Gajumaru network. A shipper locks payment in Gaju (木) against a digital waybill. Authorised parties post signed milestones as the goods move, and the payment goes to the carrier once delivery is proven. If delivery is not proven, it is refunded or sent to dispute resolution.

In practice GajuFreight is an **oracle**. It brings real-world facts ("the container reached Rotterdam", "the consignee signed for it") onto the chain, where a contract can act on them. Most of the design risk is in that step, not in moving tokens.

## 2. Scope

**In scope (MVP)**

- One contract instance per shipment (waybill + escrow together).
- Milestones posted by a fixed set of *attestors* (carrier, port agent, customs broker) named when the shipment is created.
- Payment released on proof of delivery. Refund after a deadline. A single named arbiter settles disputes.
- Off-chain telemetry (GPS, temperature, documents). The chain holds only hashes of it.

**Out of scope (for now)**

- A dedicated freight Associate Chain (see [§6.2](#62-where-the-contract-runs)).
- Multi-currency pricing and stablecoin settlement.
- Staked or reputation-weighted attestor networks.
- Automated customs/IoT integrations beyond a signed-webhook ingest.

## 3. Actors

| Actor | Role | On-chain powers |
| :--- | :--- | :--- |
| **Shipper** | Books the shipment and funds the escrow | `fund`, `raise_dispute`, `refund_after_deadline` |
| **Carrier** | Moves the goods and gets paid | `add_checkpoint`, `raise_dispute` |
| **Consignee** | Receives the goods | `confirm_delivery`, `raise_dispute` |
| **Attestor** | Trusted third party (port, customs, surveyor) | `add_checkpoint`, `confirm_delivery` |
| **Arbiter** | Settles disputes | `resolve` |

## 4. Shipment lifecycle

```
            fund()             add_checkpoint()          confirm_delivery()
 Created ──────────► Funded ─────────────────► InTransit ──────────────────► Released  (carrier paid)
                       │                          │  ▲
                       │                          └──┘ add_checkpoint()
                       │                          │
                       │ raise_dispute()          │ raise_dispute()
                       ▼                          ▼
                     Disputed ◄───────────────────┘
                       │
                       │ resolve(pay_carrier_pct)
                       ▼
                   Resolved    (funds split by the arbiter)

 Funded / InTransit ── deadline passed, no delivery ──► refund_after_deadline() ──► Refunded
```

Rules:

1. Only the shipper can fund, and only for the exact agreed amount.
2. Only the carrier or a registered attestor can add a checkpoint. Each checkpoint stores a hash of its off-chain evidence, not the evidence itself.
3. Delivery can be confirmed by the consignee **or** by an attestor. Without this, a consignee who doesn't want to pay could hold the carrier's money forever by never confirming.
4. Delivery confirmation and payout happen in one call, so there is no half-finished "Delivered but unpaid" state to handle.
5. The shipper, carrier or consignee can raise a dispute at any point before settlement. A dispute freezes the funds until the arbiter rules.
6. If the deadline (a block height) passes with no delivery and no dispute, the shipper can reclaim the funds.

## 5. Contract sketch (Sophia)

This is a design sketch. It has not been compiled. Pin the compiler version and add tests before relying on it. Sophia source files use the `.aes` extension.

```sophia
@compiler >= 6

include "List.aes"

// shipment-escrow.aes: one instance per shipment.
contract ShipmentEscrow =

  datatype status = Created | Funded | InTransit | Disputed | Released | Refunded | Resolved

  record checkpoint =
    { location  : string
    , evidence  : hash        // hash of the off-chain evidence bundle
    , timestamp : int         // Chain.timestamp (ms)
    , attestor  : address }

  record state =
    { shipper     : address
    , carrier     : address
    , consignee   : address
    , arbiter     : address
    , attestors   : map(address, bool)
    , amount      : int       // smallest Gaju denomination
    , deadline    : int       // block height
    , status      : status
    , checkpoints : list(checkpoint) }

  entrypoint init(carrier : address, consignee : address, arbiter : address,
                  attestors : list(address), amount : int, deadline : int) : state =
    require(amount > 0, "BAD_AMOUNT")
    require(deadline > Chain.block_height, "BAD_DEADLINE")
    { shipper     = Call.caller,
      carrier     = carrier,
      consignee   = consignee,
      arbiter     = arbiter,
      attestors   = Map.from_list(List.map((a) => (a, true), attestors)),
      amount      = amount,
      deadline    = deadline,
      status      = Created,
      checkpoints = [] }

  payable stateful entrypoint fund() =
    require(Call.caller == state.shipper, "ONLY_SHIPPER")
    require(state.status == Created, "BAD_STATE")
    require(Call.value == state.amount, "WRONG_AMOUNT")
    put(state{ status = Funded })

  stateful entrypoint add_checkpoint(location : string, evidence : hash) =
    require(is_attestor(Call.caller) || Call.caller == state.carrier, "UNAUTHORIZED")
    require(state.status == Funded || state.status == InTransit, "BAD_STATE")
    let cp = { location = location, evidence = evidence,
               timestamp = Chain.timestamp, attestor = Call.caller }
    put(state{ checkpoints = cp :: state.checkpoints, status = InTransit })

  stateful entrypoint confirm_delivery(evidence : hash) =
    require(Call.caller == state.consignee || is_attestor(Call.caller), "UNAUTHORIZED")
    require(state.status == Funded || state.status == InTransit, "BAD_STATE")
    let cp = { location = "DELIVERED", evidence = evidence,
               timestamp = Chain.timestamp, attestor = Call.caller }
    put(state{ checkpoints = cp :: state.checkpoints, status = Released })
    Chain.spend(state.carrier, state.amount)

  stateful entrypoint raise_dispute() =
    require(is_party(Call.caller), "UNAUTHORIZED")
    require(state.status == Funded || state.status == InTransit, "BAD_STATE")
    put(state{ status = Disputed })

  // pay_carrier_pct: 0..100; the remainder is refunded to the shipper.
  stateful entrypoint resolve(pay_carrier_pct : int) =
    require(Call.caller == state.arbiter, "ONLY_ARBITER")
    require(state.status == Disputed, "BAD_STATE")
    require(pay_carrier_pct >= 0 && pay_carrier_pct =< 100, "BAD_SPLIT")
    let to_carrier = state.amount * pay_carrier_pct / 100
    put(state{ status = Resolved })
    Chain.spend(state.carrier, to_carrier)
    Chain.spend(state.shipper, state.amount - to_carrier)

  stateful entrypoint refund_after_deadline() =
    require(Call.caller == state.shipper, "ONLY_SHIPPER")
    require(state.status == Funded || state.status == InTransit, "BAD_STATE")
    require(Chain.block_height > state.deadline, "NOT_EXPIRED")
    put(state{ status = Refunded })
    Chain.spend(state.shipper, state.amount)

  entrypoint get_status() : status = state.status
  entrypoint get_checkpoints() : list(checkpoint) = state.checkpoints

  function is_attestor(a : address) : bool = Map.member(a, state.attestors)
  function is_party(a : address) : bool =
    a == state.shipper || a == state.carrier || a == state.consignee
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

Only status, parties, amounts and **evidence hashes** go on-chain. Raw telemetry, photos and documents are stored off-chain (object storage or IPFS), and the hash lets anyone check them. The checkpoint list should stay short: record milestones, not GPS pings.

The Un-White Paper describes a **Data TTL** mechanism for limiting how much state the chain keeps. How it works isn't specified there, so we won't depend on it until the API is confirmed.

### 6.5 Signing and payment UX

- Parties sign with their existing Gajumaru wallets (GajuDesk / GajuMobile) using **GRIDS** QR payloads. GajuFreight never holds user keys.
- Settlement confirmation can use the same pattern as **GajuPay**: watch microblocks (≈3 s) for the expected transaction and treat keyblock finality as final.

## 7. Open questions

1. Is `Chain.clone` available on Gajumaru's FATE VM, and what does it cost compared with a full deployment?
2. What are the exact API and semantics of Data TTL, and do they apply to contract state or only to certain transaction types?
3. What is the name of the smallest Gaju denomination, and what precision does it have?
4. ~~Is there a public testnet we can deploy to?~~ **Answered (2026-10-02, QPQ dev team):** yes. Deploy Sophia contracts to the Gajumaru testnet with GajuDesk, using faucet Gaju for gas ([ecosystem reference §4](ecosystem-reference.md#4-deploying-contracts-to-testnet)). Whether a public *Associate Chain* testnet exists is still open; the MVP doesn't need one.
5. What arbitration model does the business want: a single arbiter, a panel, or an external body?
6. Protected accounts (Travel Rule co-signing, shown in the quantum-resistant accounts demo): do they affect `Chain.spend` to a protected carrier account?
7. Is there a maintained Python client for the Gajumaru node API (submitting transactions, reading microblocks and contract events)? If not, we write a thin, typed one ([ADR 0001](adr/0001-python-fastapi-uv-workspace.md)).
