import { Status } from '../lib/shipment-escrow.js';
import { gaju, routeEvents } from '../lib/fixtures.js';

const REF = 'GF-2026-0007';
const AMOUNT = gaju(1_800);

export default {
  id: 'panel-deadlock-fallback',
  title: 'Deadlocked panel: the fallback split applies',
  summary: 'The arbiters never reach a quorum. After the 3-day window, any party applies the fallback agreed at booking, so funds are never frozen.',

  async run(d) {
    await d.step('Book with a 2-of-3 panel and a 70% fallback to the carrier');
    const s = d.book({ ref: REF, amount: AMOUNT, deadlineInDays: 35, fallback: 70 });
    for (const event of routeEvents(REF).slice(0, 3)) d.track(s, event);

    await d.step('Shipper disputes a late arrival');
    d.dispute('shipper', s, 'arrived nine days late');

    await d.step('Every arbiter votes differently: no quorum');
    d.vote('arbiter1', s, 100);
    d.vote('arbiter2', s, 50);
    d.vote('arbiter3', s, 0);
    d.expectStatus(s, Status.Disputed);

    await d.step('The fallback cannot cut the panel short');
    d.advanceDays(2, 'panel still deliberating');
    d.fallback('carrier', s, { expect: 'ARBITRATION_OPEN' });

    await d.step('Window closes; a stranger still cannot act, but the carrier can');
    d.advanceDays(1.01, 'arbitration window closes');
    d.fallback('mallory', s, { expect: 'UNAUTHORIZED' });
    const receipt = d.fallback('carrier', s);
    d.expectStatus(s, Status.Resolved);
    d.waitFinal(receipt);
    d.showBalances();
  },
};
