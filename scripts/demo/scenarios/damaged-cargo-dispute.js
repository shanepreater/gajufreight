import { Status } from '../lib/shipment-escrow.js';
import { gaju, routeEvents, podEvent, temperatureExcursion } from '../lib/fixtures.js';

const REF = 'GF-2026-0003';
const AMOUNT = gaju(2_500);

export default {
  id: 'damaged-cargo-dispute',
  title: 'Cold-chain breach: dispute and arbitration',
  summary: 'A reefer temperature excursion is recorded. The consignee disputes, funds freeze, and the arbiter splits the payment.',

  async run(d) {
    await d.step('Book and fund a refrigerated shipment (set point 4 °C)');
    const s = d.book({ ref: REF, amount: AMOUNT, deadlineInDays: 35 });
    d.fund('shipper', s, AMOUNT);

    await d.step('Container departs and transships');
    for (const event of routeEvents(REF).slice(0, 3)) d.track(s, event);

    await d.step('Reefer telemetry reports a temperature excursion (11.5 °C for 190 min)');
    d.track(s, temperatureExcursion(REF));

    await d.step('Container arrives. Consignee inspects the goods and raises a dispute');
    for (const event of routeEvents(REF).slice(3)) d.track(s, event);
    d.dispute('consignee', s, 'cold-chain breach; 40% of pallets spoiled');
    d.expectStatus(s, Status.Disputed);

    await d.step('Funds are frozen: nobody can move them except the arbiter');
    d.confirmDelivery('consignee', s, podEvent(REF), { expect: 'BAD_STATE' });
    d.attest('carrier', s, 'Late update', 'f'.repeat(64), { expect: 'BAD_STATE' });
    d.refund('shipper', s, { expect: 'BAD_STATE' });
    d.resolve('mallory', s, 100, { expect: 'ONLY_ARBITER' });

    await d.step('Arbiter reviews the evidence; an invalid split is rejected');
    d.resolve('arbiter', s, 110, { expect: 'BAD_SPLIT' });

    await d.step('Arbiter rules 60% to carrier, 40% refunded to shipper');
    const receipt = d.resolve('arbiter', s, 60);
    d.expectStatus(s, Status.Resolved);
    d.waitFinal(receipt);
    d.showBalances();
  },
};
