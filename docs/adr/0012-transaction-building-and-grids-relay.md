# ADR 0012: Building, relaying and tracking transactions

| | |
| :--- | :--- |
| **Status** | Proposed (2026-10-05): from the [design audit](../design-audit.md); decided after spikes S1, S2 and S4 in the [implementation blueprint](../implementation-blueprint.md) |
| **Last reviewed** | 2026-10-05 |
| **Related** | [ADR 0001](0001-python-fastapi-uv-workspace.md) · [Architecture §3](../architecture-blueprint.md#3-components) · [HLD §7 Q7, Q8, Q10, Q17](../hld.md#7-open-questions) · [Phase 0 spike](../spikes/phase-0-testnet.md) · [Scripted deployment](../scripted-contract-deployment.md) |

## Context

Hard rule 1 says the API builds unsigned transactions and wallets sign them. Four parts of that aren't designed yet:

- **Building a call.** There's no SDK in any language (Q7). An unsigned contract call needs FATE calldata encoded from the contract's ACI, plus the transaction serialisation, nonce, gas and TTL. ADR 0001 assumed a thin HTTP client would do, but the node doesn't build call data.
- **Relaying it.** GRIDS contract calls use a "dead drop" (spike finding 3). The wallet opens `grids://<host>/1/d/<path>`, fetches the request from our HTTPS host, and posts the signed transaction back to the same URL. That relay is a component in its own right, and it's missing from the architecture. **E9 has since confirmed this with GajuDesk 0.9.0** ([spike round 2](../spikes/phase-0-testnet.md#round-2-2026-10-06)):
  - The request is `{grids, chain, network_id, type: tx, public_id, payload: <unsigned tx>}`.
  - The wallet posts back the same fields, with the signed transaction and `signed: true`, and doesn't submit it.
  - A payable call, a funded create and a sign-in message all worked, and the checks in decision 2 caught a tampered message.
- **Nonces.** A transaction that never reaches the miner blocks every later nonce from that account (spike observations). A handover takes two signatures (Q10), so a second payload built on an abandoned first one would stall.
- **Offline.** The journeys promise "signed, will send when online", but a dead-drop wallet has to reach our host to fetch the request, and the nonce is fixed when the payload is built.

## Options for building calls

| Option | Pros | Cons | Cost to reverse | Recommendation |
| :--- | :--- | :--- | :--- | :--- |
| **A. Pure Python encoder** (FATE calldata, serialisation) | One language; no extra runtime | Re-implements subtle encodings with no reference tests; high effort and risk | Medium | No |
| **B. A tx-builder sidecar built on Hakuzaru and the Sophia compiler** (Erlang, the libraries GajuDesk installs, used as dependencies, not copied) | Reuses QPQ's maintained code, already proven by our scripted deploy; small surface | Adds an Erlang runtime to operate; an exception to ADR 0001 | Low: one internal HTTP API | **Yes, for the MVP** |
| **C. Wait for QPQ's utility node plugin or the safer GRIDS call request** | Least code for us | No date; blocks Phase 2 | — | Adopt when it ships |

## Decision (proposed)

1. **`services/tx-builder`, an internal sidecar (option B).** It has no keys and no public port. It does four things:
   - build an unsigned call (contract, function, JSON args, caller, nonce, TTL) and dry-run it for gas and fee;
   - FATE-encode a value and hash it (terms and job hashes, spike E8);
   - decode return values and events;
   - compile templates for the deployment script.

   This amends ADR 0001 for this one component. Every other service stays in Python.
2. **The GRIDS relay lives in the API.** For each action:
   - The API stores a request with an unguessable 128-bit id, the unsigned transaction, the expected signer, the action and an expiry.
   - It shows the `grids://` URL as a QR code on desktop and a deep link on a phone.
   - On the wallet's `POST`, it checks the signed transaction against what it built, checks the signature is from the expected account on this network, submits it, and tracks it.
   - Each request is single-use and expires with the transaction's TTL.
3. **Nonces and TTL:**
   - The nonce comes from the mined account state.
   - The API keeps at most one open request per account, and holds that account's lock until its **mined** nonce moves past the request: the transaction is in a microblock, or its TTL has lapsed and the request is dead.
   - Only then is the next request built, from the new mined nonce. The second signature of a handover therefore waits for the first to be included, a few seconds normally.
   - We don't chain pending nonces (n+1 built while n is unmined). One dropped transaction would strand everything after it, which is the jam the spike saw.
   - If an included transaction drops out of the chain before final, the relay re-posts it as it is, with the same nonce and signature (see Tracking). That also frees anything built after it, and no new request is built for the account until it's included again.
   - A transaction's TTL is short (about 20 keyblocks), so an abandoned request lapses and never blocks the account.
4. **Tracking:**
   - A transaction is *pending* when a microblock includes it, and *final* after N keyblocks. N is a per-network setting (Q17).
   - A signed transaction that drops out of the chain before final is re-posted as it is, while its TTL lasts.
   - Every request carries a correlation id from the API to the transaction hash and on to the indexer projection (`sre` skill).
5. **Offline:** the field app queues the *scan session and its evidence* offline, and asks for the signature once there's signal. It never claims "signed" before the wallet has posted. **Confirmed by spike E9b:** GajuMobile can't sign offline, and silently drops a request it can't fetch. So the app re-opens the request once there's signal, and treats it as unsigned until the dead drop receives the response.
6. **HTTPS only for phones:** GajuMobile refuses plain HTTP (E9b), so every dead-drop URL a phone opens is `grids://` on a host with a publicly trusted certificate.
7. **Forward compatibility:** when GRIDS's safer call request (chain, contract, function, args) ships, the relay sends that instead, and the tx-builder's call-data role shrinks to checking.

## Consequences

- **Good:**
  - Signing works with the wallets that exist today, and keys never leave them.
  - Abandoned or dropped requests can't jam an account.
  - There's one place to measure signing success, an SLI.
- **Cost:**
  - Two new components (tx-builder and relay).
  - The API's host must be public HTTPS that phones can reach, because wallets fetch from it.
  - An Erlang build in CI.
- **Risk:**
  - E9 passed with GajuDesk 0.9.0 ([spike round 2](../spikes/phase-0-testnet.md#round-2-2026-10-06)). The format may still change with the safer call request (decision 6).
  - GajuMobile's support for contract-call requests and deep links is unconfirmed (S2, QPQ follow-up).
