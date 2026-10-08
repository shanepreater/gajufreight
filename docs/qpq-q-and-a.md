# QPQ Q&A
As part of the design phase for the GajuFreight app, we have found several unknown parts that need the QPQ team to demystify. This is the record of the questions asked and the responses gathered.

Each section gives the question as tracked in [HLD §7](hld.md#7-open-questions), QPQ's answer as received, and our follow-up questions (all sent; awaiting answers). When QPQ answer a follow-up, move it into the answer with the date.

The [Phase 0 testnet spike](spikes/phase-0-testnet.md) has since answered several follow-ups by experiment (2026-10-05): `Chain.clone` works from Sophia and can be funded in the same call (Cloning 1, 2); gas figures (Cloning 3, Fees 1); events and off-chain hashes (Node API 1, 3); dry-run gas estimates (Fees 2); and the `Chain.create`/`Chain.clone` value syntax (Contract creation 2). It also found that `init` sees the attached amount in `Contract.balance`, not `Call.value`. QPQ's answers to those follow-ups are still welcome, but the design no longer waits on them.

Round 2 of the spike (2026-10-06) tested more of them ([spike round 2](spikes/phase-0-testnet.md#round-2-2026-10-06)). Each one it answered is marked **Tested** below, with the result. Anything QPQ might still clarify is in a short note. Every follow-up has been sent to QPQ; their answers still take precedence over our tests.

## Contract Cloning

### Question
**HLD Q1.** Is `Chain.clone` available on Gajumaru FATE (testnet and mainnet), and what does it cost compared with a full deployment? It sets the per-shipment cost, with a fallback in [HLD §5.4](hld.md#54-deploying-one-instance-per-shipment).

### Answer
Oh! These are great questions and a cool idea for a service.

As soon as I get to a computer I'll get back to you wIth details. The clone() function is remarkably more efficient than create(). The biggest cost is storage of the compiled artifact, the source, and the initial state (the processing init() does is usually trivial). The clone() function creates a pointer to the existing compiled contract and source, dropping the cost to just the new state plus whatever init() might do.

This also enhances processing efficiency. The heaviest task in contract call execution is loading the contract and then loading the state. Optimizations can be made around frequently referenced chain objects, and a frequently referenced contract can be cached and then the only heavy bit is loading the state for the given call.
I hate typing on phones, so I'll get to the rest in a bit.

### Follow-up questions
Sent to QPQ; awaiting answers.

1. Is `Chain.clone` callable from Sophia 9 contracts on Groot testnet and mainnet today?
2. Can a clone be funded in the same call (passing value to a `payable init`), so cloning and funding an escrow is one transaction?
3. Roughly what gas does a clone cost compared with a full create, for a contract of about 10 KB compiled? **Tested:** a 4.4 KB escrow cost 2.23 × 10¹⁴ puck to create and 2.01 × 10¹⁴ to clone through a contract call (E14). A call's fixed charge (about 182,600 gas) is larger than a create's (about 88,000), and a create adds about 11.5 gas per byte of code and source, so clones win by about a third only at full escrow size (E18). *Note for QPQ:* is that fixed charge per transaction type documented, and is it stable?

## Data TTL

### Question
**HLD Q2.** Data TTL: what is the API, and does it apply to contract state or only to some transaction types? It decides whether settled shipment state can be pruned ([HLD §6.4](hld.md#64-data-on-chain-vs-off-chain)).

### Answer
The data TTL is a number that says how long a chain object should continue to exist on chain from the moment it is included. The number itself is a time span in "heights". "Time" is a relative concept, as in distributed computing (especially very wide area distributed computing) there is no concrete notion of "wall clock time", so instead the mining puzzle contest serves as a probabilistic, distributed clock (a sort of Lamport clock -- whether this is the "strong" or "weak" version of a Lamport clock is a debatable subject). There is a spec sheet that may be worth looking over.
https://gajumaru.io/specs/

NOTE: TTL's have not been fully implemented on Groot just yet -- so don't expect any impact on gas or garbage collection just yet. This will be a hard fork on Groot, which is why we had to create the white list, actually (along with ACs coming online).

### Follow-up questions
Sent to QPQ; awaiting answers.

1. How is a data TTL set on a contract and its state? Is it the `TTL` argument of `hz:contract_create/8`, or is that the transaction's own validity window?
2. Once enforced, what happens to a contract whose TTL expires while it still holds a balance? Can a TTL be extended, and do clones inherit the template's TTL?
3. When is the TTL hard fork expected, and does it change anything for contracts deployed before it?
4. What does the white list cover, and does it affect who can deploy contracts on Groot?

## Denomination

### Question
**HLD Q3 and Q13.** What is the smallest Gaju denomination called, what is its decimal precision, and how many Pucks make one Gaju? It sets the amount types end to end and how amounts are displayed and entered (the demo assumed 10¹⁸ as a placeholder).

### Answer
1 puck is 1 quintillionth of a Gaju. If you play around with hz_format:amount/1  and hz_format:read/1 you'll get a feel for the denomination scale.
https://gajumaru.io/docs/hakuzaru/latest/

```
ceverett@steak:~$ zxh run gajudesk
Erlang/OTP 28 [erts-16.4] [source] [64-bit] [smp:16:16] [ds:16:16:10] [async-threads:1] [jit:ns]

Eshell V16.4 (press Ctrl+G to abort, type help(). for help)
Starting otpr-gajudesk-0.9.0.
hz_man starting.
Started [sasl,crypto,asn1,public_key,ssl,gajudesk]
1> io:format("~ts~n", [hz_format:amount(1)]).
木0.000,000,000,000,000,001
2> io:format("~ts~n", [hz_format:amount(1_000_000_000_000_000_000)]).
木1
3> hz_format:read("木123.456,789,012").
{ok,123456789012000000000}
```

After relocating the repos to avert the bot deluge I've started setting up read-only mirrors on GitLab for the time being until we can come up with something more permanent.
https://gitlab.com/zxq9/hakuzaru/-/blob/master/src/hz_format.erl?ref_type=heads#L41

## Protected Accounts

### Question
**HLD Q6.** Protected accounts (Travel Rule co-signing): does `Chain.spend` to a protected carrier account need a co-signature, fail, or queue? If it does, forwarder payouts could stall.

### Answer
Protected accounts are not a Groot thing. The "Travel Rule" is a big convoluted mess that is currently subject to all kinds of lopsided rulings and over-rulings that make it pretty much pointless to contemplate in the context of Groot (the actual function of the Travel Rule is... a discussion of its own -- under the theory of "the purpose of a thing is what it actually does" its function is to lock in an oligopoly amongst the three major exchanges and three major KYC providers). The place where a protected account can be applied is on an associate chain. You can create any kind of contract-governed system to manage funds that you might dream up, though, so anything is technically possible, it just isn't possible to actually censor accounts on Groot in any way (again, censorship/compliance/submission is entirely possible to create on an AC via custom governance rules, though).

## Node API

### Question
**HLD Q7.** Is there a maintained client for the node HTTP API (submit transactions, read microblocks and contract events)? What are the public endpoints and spec? Also, which languages are supported? The indexer and API services depend on it ([ADR 0001](adr/0001-python-fastapi-uv-workspace.md)).

### Answer
There is a public API, though our current documentation is a bit out of sync with the reality The current best reference is actually the hz module from Hakuzaru:
https://gitlab.com/zxq9/hakuzaru/-/blob/master/src/hz.erl

As for canonical endpoints, the current HTTP/HTTPS endpoints are going to all be going behind HTTPS shortly to satisfy some Android requirements, and we'll at least maintain these for the forseeable future, but the mandate from app stores that everything be behind HTTPS rather than allowing HTTP basically mandates centralization of access points -- which is totally against the basic principle of blockchain. So instead we will be putting out an additional endpoint protocol behind Noise tunnels to allow the network to once again be fully peer-based (that is, GajuDesk/GajuMobile, etc will be performing their own network discovery crawls, with initial endpoints only being seed node recommendations -- this becomes particularly important in the context of ACs).

The current endpoints (HTTP, not HTTPS until later this week):

Testnet:
- http://groot.testnet.gajumaru.io:3013/v3
- http://tsuriai.jp:4013/v3

Mainnet:
- http://groot.mainnet.gajumaru.io:3013/v3
- http://tsuriai.jp:3013/v3

When I do change those to HTTPS, they will be running on the normal HTTPS port.
The Tsuriai endpoints will be called something different then -- I'll make a page for this on the gajumaru.io site.

**EDIT:** You asked about languages... we don't really have an "SDK" as such, instead we are making everything that the nodes can do public via an HTTP endpoint you can run yourself locally (we are working on a "utility node plugin" that will open up all the functionality), and from there anyone can write anything in any language with local web requests instead of having to port some gigantic blob of code wrongly for each language they want to do Gajumaru stuff in.

### Follow-up questions
Sent to QPQ; awaiting answers.

1. Which endpoints return contract events (call logs) and the transactions in a microblock, so an indexer can follow one contract? Is there a push or subscription option, or do we poll by height? **Tested:** the node's OpenAPI spec is at `GET /api`. Polling uses generations → microblock transactions → `/transactions/{h}/info`. Testnet's node (0.1.0+287) adds SSE subscriptions for contract events and calls, the top header and balances, but mainnet's (0.1.0+211) doesn't. *Note for QPQ:* when will mainnet run the newer node?

   **QPQ (Craig and Ulf, 2026-10-08):** Craig is upgrading some nodes. Ulf's node at `http://wpuab.com:3013` already runs the newest endpoints (0.1.0+289, mainnet), with the spec at `/api?oas3`. **Tested (2026-10-08):** it serves the SSE subscriptions, `/transactions/{hash}/finality` (with `wait`, `timeout` and `stream` for push updates) and `/key-blocks/height/{h}/testimonies`.
2. How should a client tell when a transaction is final (how many keyblocks)? On testnet, `/status` reports `finalized` at height 0 (genesis). **Tested (partly):**
   - Mainnet finalises by witness: `finalized` sits at top − 1, and key blocks carry testimonies.
   - Testnet has no witnesses. Its `/transactions/{h}/finality` endpoint reports `on_chain` and a depth, but never `final`.

   *Note for QPQ:* is witness finality the signal to use on mainnet, and will testnet get witnesses?

   **QPQ (Ulf, 2026-10-08):** yes. Designated witnesses testify that a key block is their top. A key block that carries a majority of signed testimonies for its predecessor seals that predecessor, which can then never be evicted. So a transaction in generation G:
   - is valid, but can still move, once it's in a microblock;
   - is final once key block G + 1 is sealed, which happens when key block G + 2 carries its testimonies. That's when `/status` `finalized` reaches G + 1.

   If the next key block micro-forks, the dropped transactions go back to the mempool and usually reappear early in the next generation, so wait 2 more key blocks. A netsplit shows as no majority of testimonies: wait. If witnessing is offline, normal fork resolution applies. Testimonies can be read from `/key-blocks/height/{h}/testimonies` (three witnesses on mainnet, 2026-10-08). Whether testnet will get witnesses is still open.
3. Is there an endpoint that FATE-encodes a value, so off-chain code can reproduce a contract's `Crypto.blake2b` hash of a record? **Tested:** no public one. `/debug/contracts/call` and `/create` build unsigned transactions, but they take encoded call data and are internal. Round 1 reproduced the hash with `gmb_fate_encoding` (E8).
4. Should a production service run its own node rather than use the public endpoints? Are the public ones rate-limited? **Tested (partly):** no rate limit was seen at 120 requests with 12-way concurrency. SSE subscriptions are capped per node. The recommendation is still QPQ's call.
5. When will the HTTPS hostnames and the utility node plugin be available? **Tested:** HTTPS isn't serving the API yet (2026-10-06).
6. We now deploy and call contracts from a script built on Hakuzaru and the Sophia compiler, not GajuDesk ([scripted contract deployment](scripted-contract-deployment.md)). Is that the approach you'd recommend, or is there something better (the utility node plugin, an HTTP compile endpoint)?

## GRIDS

### Question
**HLD Q8.** What is the GRIDS payload format for *contract calls* (not only spends), and how does GajuDesk/GajuMobile show it before signing? Our API builds unsigned calls for wallets to sign (AGENTS.md hard rule 1).

### Answer
The payload for a GRIDS contract call is the unsigned contract call data (you get this from hz:contract_call/5,6,10). The returned GRIDS message should contain the signed, and unsigned call data as well as the public key that signed the call so the receiver can verify it.

**Important note here:**
GRIDS will be advancing a bit soonish to include a much safer form of contract call request object which will indicate the chain ID, the contract ID/name, the function name, and the args that the signature device is being requested to form and sign a call for -- to eliminate any possibility of pre-formed call data being malicious (the current state of "security" in blockchain systems is utterly laughable because of this gap!). This also allows the signature device or the user to reference the contract source from the chain, the requested call, and dry run the call in its own environment or on chain to independently verify the actual effects of the call before signing anything.

This is the most obvious baseline duh I can't believe that's not the security standard everywhere level of independent verification minimally necessary for blockchain to be used in commerce.

Anyway, I will document this and put it up on the gajumaru.io site as soon as I can.

These questions are really really good for me to force me to focus on the things devs are going to need to be able to self-service!

### Follow-up questions
Sent to QPQ; awaiting answers.

1. How is a contract-call request delivered to the wallet today: a `grids://` URL or QR code like a spend, with the call data inside? Is there a size limit? **Tested:** by a dead-drop URL, `grid(s)://<host>/1/d/<path>`. The wallet fetches JSON (`grids`, `chain`, `network_id`, `type: tx`, `public_id`, `payload: <unsigned tx>`) from `http(s)://<host>/<path>`, so the URL stays short whatever the call size (E9).
2. Can GRIDS carry a contract *create* transaction (with an amount), so a shipper's wallet can create and fund an escrow directly? **Tested: yes.** GajuDesk 0.9.0 signed a funded create (E9).
3. What does GajuDesk or GajuMobile show the user before they sign a contract call today: the decoded function and arguments, or the raw data? **Tested (GajuDesk):** the raw `tx_…` data, with the account, chain, network ID and originating URL, but no contract, function, amount or fee. Message requests show the full text (E9). GajuMobile 0.2.1 on Android was tested in E9b (emulator) and shows the same: raw transaction data, the full message for message requests. iOS is untested.
4. How does the signed result get back to the requesting app (callback URL, or the wallet submits it), and who posts it to the chain? **Tested:** the wallet POSTs the response, with the signed transaction and `signed: true`, to the same URL. It doesn't submit the transaction; the requesting service does (E9).
5. Is there a draft spec or rough date for the safer call-request object, and will the current format stay supported after it ships?
6. Does GajuMobile (Android and iOS) accept GRIDS `tx` requests for contract calls today, and does it register the `grids://` scheme so a web app on the same phone can open it with a deep link? Our field users sign on the phone they scan with ([design audit](design-audit.md) F5). **Tested on Android (E9b, emulator):**
   - GajuMobile 0.2.1 registers both schemes, so a web-app link opens it.
   - It fetches only over HTTPS: a `grid://` HTTP request fails silently.

   iOS is untested. *Note for QPQ:* is HTTPS-only intended, and could a failed fetch show an error?
7. Can a wallet sign a GRIDS request while offline (for example, one fetched earlier), or must it reach the dead-drop host at signing time ([design audit](design-audit.md) F21)? **Tested (E9b):** it must be online. Offline, GajuMobile returns to its home screen with no error, and it doesn't retry once the network is back, so the request is lost.

## Sophia

### Question
**HLD Q9.** Which Sophia compiler version do GajuDesk and the testnet support? We pin `@compiler` to it.

### Answer
The Sophia compiler is v9.0.0 and can be found here: https://gitlab.com/zxq9/sophia

I extracted a (crappy) docs site for it here: https://gajumaru.io/docs/sophia/

The sophia version packaged with GajuDesk is the de facto current standard:

```
ceverett@steak:~$ zx describe sophia
Package : otpr-sophia-9.0.0
Name    : Sophia Compiler
Type    : lib
Desc    : The Sophia smart contract language for the FATE VM
Author  : QPQ AG
Web     : 
Repo    : https://git.qpq.swiss/QPQ-AG/sophia
Tags    : ["gaju","gajumaru","blockchain","sophia","crypto","compiler","puck"]
```

### Follow-up questions
Sent to QPQ; awaiting answers.

1. Is there a stand-alone Sophia 9 compiler (CLI or package) we can pin and run in CI, without GajuDesk?
2. Which language changes since æternity's Sophia 8 should we know about?

## Batching

### Question
**HLD Q10.** Can one GRIDS request carry several contract calls, signed once? A handover is the next leg's scan-in plus the incoming leg's delivery ([ADR 0004](adr/0004-staged-contracts.md)).

### Answer
GRIDS requests can carry only a single instruction at a time.
GRIDS instructions for SpendTXs are actually just the URL itself (there is no additional message). GRIDS instructions for contract calls, binary signatures, message/string signatures, and so on are all one instruction per message.

### Follow-up questions
Sent to QPQ; awaiting answers.

1. For two calls that must happen together (a handover), is one contract entrypoint that makes both calls the recommended pattern? **Tested: no, not for calls that check the caller.** The inner calls see the wrapper contract as `Call.caller` and the signer only as `Call.origin`. A role check rejects them, and trusting `Call.origin` would let any contract act as its user. A handover stays two signatures (E16).

## Fees

### Question
**HLD Q11.** Roughly what gas does a simple contract call (e.g. a quote `propose`) cost on testnet and mainnet? We show the fee before each negotiation round.

### Answer
The gas fees for contract calls (well, for all transactions) are variable based on what the call actually does. A spend TX with no payload costs less than a spend TX with a payload (especially a large one), and similarly, the larger the TTL the larger the gas fee as well. A contract call that stores a lot of data or consumes a lot of cycles (like traversing a really large map or list) will also consume more gas.

### Follow-up questions
Sent to QPQ; awaiting answers.

1. What is the current minimum gas price on testnet and mainnet, and a ballpark fee for a simple call that updates a small record? **Tested:** 10⁹ puck/gas. Anything lower is rejected when posted (E17), and recent mainnet transactions all paid 10⁹ or just over. A simple call costs about 1.83 × 10¹⁴ puck (0.00018 Gaju), mostly a fixed charge, and unused gas isn't charged (E18).
2. Can a dry run return the gas used, so the app can show an estimated fee before the user signs?
3. How does GajuMarket take its platform fee: a split inside the escrow contract at settlement, or otherwise?
4. Can one account pay for another's transaction (`PayingForTx`)? **QPQ (Ulf, 2026-10-08):** yes, as in aeternity, with the same chain object tag (82), except that `fee` becomes `gas_price` and `gas`: version 1 is `[payer_id, nonce, gas_price, gas, tx]`. The inner transaction is signed over `"<network_id>-inner_tx"`. **Tested (2026-10-08):** the node's `/dry_run` refuses it ("Unsupported transaction type paying_for_tx"), so its gas can't be estimated by dry run. This would let the platform pay a new user's first call. Not designed in: it needs a decision.

## Contract creation

### Question
**HLD Q12.** Can a contract be created **with value** (payable `init`), and can a contract create another (`Chain.create`)? Atomic booking and `Platform.new_quote` rely on both ([ADR 0005](adr/0005-platform-booking-privacy.md)).

### Answer
Yes, a contract can be created with a value (the create call has a value field in it for this.
hz:contract_create/8's spec has an Amount arg for this:

```erlang
contract_create(CreatorID, Nonce, Gas, GasPrice, Amount, TTL, Path, InitArgs) -> Result
  when
    CreatorID = pubkey()
    Nonce = pos_integer()
    Gas = pos_integer()
    GasPrice = pos_integer()
    Amount = non_neg_integer()
    TTL = non_neg_integer()
    Path = file:filename()
    InitArgs = [string()] | {erlang, [term()]} | {fate, [term()]} | {sophia, [string()]}
    Result = {ok, CreateTX} | {error, Reason}
    CreateTX = binary()
    Reason = term()
```

A contract can create or clone another contract as well as call them. There are a few structures that have become kind of common around how to have a single management contract interface for a service that has a lot of child contracts that handle a discrete issue each (GajuMarket works this way, actually).

I can find examples of each of these things as they come up. Just ping me and I'll get back to you.

Gajumaru has a lot of really awesome features and even though it is complicated, it is so much easier to write a system that doesn't do your own head in to try to re-read 6 months later here than anywhere else I've tried.

### Follow-up questions
Sent to QPQ; awaiting answers.

1. Could you share the GajuMarket management-contract and child-contract example? It's the same shape as our `Platform` and escrows.
2. From Sophia, is the syntax `Chain.create(value = x, ...)` and `Chain.clone(ref = t, value = x, ...)` as on æternity?
3. Inside `init`, `Call.value` is 0 and `Contract.balance` already holds the amount attached to the create, for a create transaction, `Chain.create` and `Chain.clone` alike (Phase 0 spike E2b). Is that intended, and will it stay that way?
4. Does `Chain.spend(to, 0)` succeed, revert or error? And what does `Address.is_payable` return for an account that has never received funds, and for a contract with no `payable` entrypoints? **Tested:** a zero spend succeeds to any account (and creates an unfunded one) but errors to a non-payable contract. `is_payable` is true for unfunded accounts and false for non-payable contracts (E12). Our payouts skip zero amounts and refuse non-payable parties ([design audit](design-audit.md) F2, F3); the spike's probe E12 checks both on testnet.

*Note (Phase 0 spike, 2026-10-05): the question's "payable `init`" isn't valid Sophia 9, which rejects `payable` on `init`; value attaches to the create transaction without it. Both `Chain.create(value = …)` and `Chain.clone(ref = …, value = …)` compile.*

## Organisations

### Question
**HLD Q15** ([decision log](decision-log.md) #7). How does GajuPay model a company with many staff, each with their own wallet? For the MVP, each GajuFreight company names one operating wallet for quotes, escrows and payouts, and its handlers attest with their own wallets. Later we'd like one company account that delegates to its current members (an authorisation-group account, as in Ulf Wiger's demo, or a contract). Does GajuPay have a pattern we should follow?

### Answer
Asked 2026-10-06, with the round 2 questions below. Awaiting an answer.

## Round 2 findings and questions

### Question
Sent to Craig and the QPQ team on Discord on 2026-10-06, after spike round 2 and E9b ([results](spikes/phase-0-testnet.md#round-2-2026-10-06)). The message also reported the issues the spike found: both wallets show transactions as raw data only; GajuMobile fetches only over HTTPS and fails silently; GajuDesk's dialog title and no-`init` crash; mainnet's older node; testnet's lack of witnesses; unfunded-account transactions blocking nonces; and `/dry_run` omitting the fixed charge. It also listed the earlier follow-ups that testing had answered, so QPQ can skip them.

1. When will mainnet run the newer node, with the SSE subscriptions and `/transactions/{hash}/finality`?
2. On mainnet, is witness finality the right signal that a transaction won't be reversed? Will testnet get witnesses, and without them, what depth is safe?
3. How is the roughly 182,600 gas charge per call worked out, and is it stable? Could `/dry_run` include it?
4. Is GajuMobile's HTTPS-only fetching intended? Could a failed fetch show an error or offer a retry? Is there an iOS version to test?
5. Is there a rough date for the safer call request, and will today's dead-drop format keep working after it?
6. How does GajuPay model a company whose staff each have their own wallet? (See [Organisations](#organisations).)
7. Is `Call.value` being 0 in `init` intended, and will it stay that way?
8. Can a contract call back into one already on the call stack in FATE? The design avoids it ([decision log](decision-log.md) #9).
9. For production, should we run our own node rather than use the public endpoints?
10. Is there a stand-alone Sophia 9 package to pin in CI without GajuDesk?

### Answer
- **1 and 2 (2026-10-08):** see [Node API](#node-api) follow-ups 1 and 2. The finality rule is now in [HLD §7](hld.md#7-open-questions) Q17.
- The rest await answers. Record each with its date, and move the result into the HLD, an ADR or the spike where it changes the design.
