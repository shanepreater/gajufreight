import { Status } from '../lib/shipment-escrow.js';
import { gaju, routeEvents, podEvent } from '../lib/fixtures.js';

const REF = 'GF-2026-0004';
const AMOUNT = gaju(1_500);
const DEADLINE_DAYS = 35;

export default {
  id: 'lost-shipment-refund',
  title: 'Shipment goes dark: refund after the deadline',
  summary: 'Tracking stops mid-ocean. The shipper cannot reclaim early, but gets a full refund once the deadline passes.',

  async run(d) {
    await d.step('Book and fund with a 35-day delivery deadline');
    const s = d.book({ ref: REF, amount: AMOUNT, deadlineInDays: DEADLINE_DAYS });
    d.fund('shipper', s, AMOUNT);

    await d.step('Container leaves Shenzhen… then the updates stop');
    for (const event of routeEvents(REF).slice(0, 2)) d.track(s, event);
    d.advanceDays(20, 'no further milestones');

    await d.step('Shipper tries to reclaim early: blocked until the deadline');
    d.refund('shipper', s, { expect: 'NOT_EXPIRED' });

    await d.step('Deadline passes with no delivery');
    d.advanceDays(DEADLINE_DAYS - 20 + 1, 'deadline passes');

    await d.step('Only the shipper can claim the refund');
    d.refund('carrier', s, { expect: 'ONLY_SHIPPER' });
    d.refund('mallory', s, { expect: 'ONLY_SHIPPER' });
    const receipt = d.refund('shipper', s);
    d.expectStatus(s, Status.Refunded);
    d.waitFinal(receipt);

    await d.step('A late "delivered" claim cannot re-open a settled shipment');
    d.confirmDelivery('portAgent', s, podEvent(REF, { signedBy: 'portAgent' }), { expect: 'BAD_STATE' });
    d.showBalances();
  },
};
