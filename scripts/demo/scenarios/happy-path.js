import { Status } from '../lib/shipment-escrow.js';
import { gaju, routeEvents, podEvent } from '../lib/fixtures.js';

const REF = 'GF-2026-0001';
const AMOUNT = gaju(1_200);

export default {
  id: 'happy-path',
  title: 'On-time delivery: Shenzhen → Rotterdam → Tilburg',
  summary: 'Book, fund, track six real-world milestones, consignee signs for delivery, carrier is paid automatically.',

  async run(d) {
    await d.step('Shipper books the shipment and names the attestors');
    const s = d.book({ ref: REF, amount: AMOUNT, deadlineInDays: 35 });
    d.expectStatus(s, Status.Created);

    await d.step('Shipper locks payment in escrow');
    d.fund('shipper', s, AMOUNT);
    d.expectStatus(s, Status.Funded);
    d.showBalances();

    await d.step('Container moves; each milestone is reported, verified and signed on-chain');
    for (const event of routeEvents(REF)) {
      d.track(s, event);
      await d.pause();
    }
    d.expectCheckpoints(s, 6);
    d.expectStatus(s, Status.InTransit);

    await d.step('Consignee signs for delivery → escrow releases payment to the carrier');
    const receipt = d.confirmDelivery('consignee', s, podEvent(REF));
    d.expectStatus(s, Status.Released);
    d.waitFinal(receipt);

    await d.step('Settlement');
    d.showBalances();
  },
};
