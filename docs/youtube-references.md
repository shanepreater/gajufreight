# Video & Talk References

Notes from Gajumaru demos and discussions, with what each one means for GajuFreight. Full citations are in [sources.md](sources.md).

> These summaries were machine-generated from transcripts. Check details against the source before relying on them.

---

## 1. Quantum-resistant accounts (Associate Chain demo)

**Link:** [Gajumaru | Associate Chain Demo – Quantum resistant accounts](https://m.youtube.com/watch?v=R6XlrrWs2_0)
**Presenter:** Ulf Wiger (CTO, QPQ)

**Summary.** A live view of accounts on two parallel chains, Groot (PoW) and an Associate Chain (`AC1`). The demo creates an account with an ML-DSA key, posts a transaction on Groot, and moves 1 Gaju to the AC.

**Key points**

- **Signature types built into the protocol:** type 0 = Curve25519 (standard); types 2 & 3 = non-quantum fallback keys; types 44, 65, 87 = ML-DSA (post-quantum).
- **Protected accounts:** a `protected` flag means the account owner must co-sign incoming payments, which supports the Travel Rule and lets owners block unknown funds.
- **Deposit and withdrawal flow** between Groot and an AC.

**Relevance to GajuFreight:** QPQ confirm protected accounts exist only on Associate Chains, not Groot, so payouts on Groot can't stall on a co-signature ([HLD open question 6](hld.md#7-open-questions)). They matter only if we deploy to an AC that uses them.

---

## 2. GajuPay & GajuMarket discussion

**Source:** discussion excerpt, QPQ founders (Greg Chew, Craig Everett, Ulf Wiger)

**Summary.** Two apps intended to drive adoption:

1. **GajuPay:** the merchant shows a QR code with the target account, amount and reference code. The customer's wallet signs. The back end watches the ledger for a matching transaction and confirms settlement quickly enough for point-of-sale use.
2. **GajuMarket:** an on-chain marketplace (originally *Quid Pro Quo*). Each purchase clones a sales contract, which locks funds in escrow while the buyer and seller agree shipping and final price. On settlement 98% goes to the seller and a fixed 2% to the market operator.

The team also described Associate Chains tied to national fiat currencies (USD, JPY, GBP), which add smart-contract capability without changing how the fiat is issued.

**Relevance to GajuFreight:** GajuMarket is the closest existing design to ours (a cloned escrow contract per deal). GajuPay's microblock watcher is the model for our indexer.

---

## 3. Associate Chain setup (GM Demo Chain)

**Source:** technical demo, Ulf Wiger

**Summary.** `GM Demo Chain` sets up local test networks: a root mining node plus custom ACs, from templates and a config file, with cached test keys.

**Key points**

- Pre-seeded accounts and genesis contracts.
- Operator sets, consensus rules and threshold signatures for quorum.
- Block interval, throughput and finality configured per AC.
- Deposits and withdrawals approved by multi-operator consensus.

**Relevance to GajuFreight:** our local development and CI chain, and the starting point if we later run a dedicated freight AC.

---

## 4. Account-initiated multi-currency transactions

**Source:** technical demo, Ulf Wiger

**Summary.** Shows "Account Initiated Currencies": test accounts are created and funded in Gaju, then custom token representations and multi-asset transfers across ACs are demonstrated, without third-party bridge contracts.

**Key points**

- ACs can issue and track custom assets natively within the account structure.
- Multi-asset transfers run on the AC and stay interoperable with Groot.

**Relevance to GajuFreight:** a possible later route to pricing freight in stablecoins or fiat-backed AC currencies (out of MVP scope).
