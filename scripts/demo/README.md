# GajuFreight End-to-End Demo

A scripted, narrated run through the full GajuFreight shipment lifecycle, covering the failure cases customers ask about. It's safe to show live: each scenario runs in isolation, checks that funds are conserved at the end, and the demo carries on if one scenario fails.

> **Placeholder backend.** The demo currently runs on an in-memory **simulated chain** (`lib/sim-chain.js`). Its JS model of the escrow contract (`lib/shipment-escrow.js`) follows the [HLD contract sketch](../../docs/hld.md#5-contract-sketch-sophia). A `local-chain` backend that talks to a real Gajumaru demo chain arrives in [dev-approach phase 1](../../docs/dev-approach.md#3-delivery-phases). All companies are fictional. The ports and places are real.

## Run it

Requires Node.js ≥ 24. No dependencies to install.

```sh
cd scripts/demo
node run-demo.js                          # all scenarios, paced for an audience
node run-demo.js -i                       # press Enter between steps (live presenting)
node run-demo.js -s damaged-cargo-dispute # a single scenario
node run-demo.js --list                   # list scenarios
node run-demo.js --fast --log demo.jsonl  # no pacing, write a JSON Lines audit log
npm test                                  # test suite
npm run test:coverage                     # tests + coverage gate (lines 95%, branches 85%)
```

Exit codes: `0` all passed · `1` a scenario failed · `2` usage error · `130` interrupted.

## Scenarios

| Id | Story | What it proves |
| :--- | :--- | :--- |
| `happy-path` | Shenzhen → Singapore → Rotterdam → Tilburg, six milestones, consignee signs | Escrow releases automatically on proven delivery |
| `consignee-no-show` | Consignee never confirms | An attestor can prove delivery, and the carrier can't confirm its own delivery |
| `package-custody` | Three labelled pallets scanned out at Yantian and in at Rotterdam | One signed checkpoint per location; missing, foreign, unreadable and cloned labels are caught and recorded; a stranger can't record custody; the missing pallet becomes dispute evidence |
| `damaged-cargo-dispute` | Reefer temperature excursion, consignee disputes, 2-of-3 panel with one dissent | Funds freeze during a dispute. Only the panel can settle, a quorum of matching votes pays out, and invalid splits are rejected |
| `panel-deadlock-fallback` | Arbiters never agree | After the arbitration window, any party applies the fallback split agreed at booking, so funds never freeze |
| `lost-shipment-refund` | Tracking stops mid-ocean | No early refund, a full refund after the deadline, and settled shipments can't be reopened |
| `access-control` | Bad bookings, wrong amounts, strangers, self-dealing | Exact rejection codes, full revert, no double payment |
| `data-integrity` | Forged webhook, replay, micro-fork, edited document | Signatures are checked, duplicates ignored, forks recovered, tampering detected by hash |

## How it works

```
scenarios/*.js ──► Demo facade (lib/demo.js) ──► SimChain + ShipmentEscrow model
                        │                         (placeholder for a Gajumaru node)
                        ├──► FeedIngest (lib/shipping-feed.js): signed webhooks, evidence hashes
                        ├──► Narrator (lib/narrator.js): console output and pacing
                        └──► Audit log (lib/audit-log.js): JSON Lines record of every action
```

- **Shipping events** go through the same path the real system will use: a signed webhook is verified, deduplicated and stored off-chain, and then the reporting party's attestor signs a checkpoint that holds only the evidence hash.
- **Expected failures** are written into the script: `d.fund('mallory', s, amount, { expect: 'ONLY_SHIPPER' })`. The demo asserts the *exact* error code. An unexpected success, or the wrong code, fails the scenario.
- **Invariants** are checked after every scenario: each escrow's payouts equal its funding, and the total Gaju supply is unchanged.

## Adding a scenario

1. Create `scenarios/<kebab-case-id>.js` exporting `{ id, title, summary, run(d) }`. Copy an existing one.
2. Add it to `scenarios/index.js` in the order you want to present it.
3. Use `await d.step('…')` for each beat the audience should see. Use `{ expect: 'CODE' }` for anything that should be blocked.
4. `npm test` runs every scenario automatically.

## Keeping it in sync

`lib/shipment-escrow.js` must match the Sophia contract: same entrypoints, same check order (role → status → arguments), same error codes. Any change to the contract lifecycle updates this model and its tests in the same PR. When the real contract exists, the phase 1 `local-chain` backend replaces `SimChain`, and the scenarios should run unchanged.
