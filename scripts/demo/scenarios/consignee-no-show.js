import { Status } from '../lib/shipment-escrow.js';
import { gaju, routeEvents, podEvent } from '../lib/fixtures.js';

const REF = 'GF-2026-0002';
const AMOUNT = gaju(900);

export default {
  id: 'consignee-no-show',
  title: 'Consignee goes quiet: attestor proves delivery',
  summary: 'The consignee never signs. A port attestor confirms delivery with proof, so the carrier is still paid.',

  async run(d) {
    await d.step('Book and fund');
    const s = d.book({ ref: REF, amount: AMOUNT, deadlineInDays: 35 });

    await d.step('Container travels the full route');
    for (const event of routeEvents(REF)) d.track(s, event);
    d.expectCheckpoints(s, 6);

    await d.step('Goods arrive, but the consignee does not confirm');
    d.advanceDays(3, 'no response from the consignee');
    d.note('Without an attestor path the carrier would wait forever. The contract prevents that.');

    await d.step('Carrier cannot confirm its own delivery');
    d.confirmDelivery('carrier', s, podEvent(REF, { signedBy: 'portAgent' }), { expect: 'UNAUTHORIZED' });

    await d.step('Port attestor confirms delivery with the signed POD and photos');
    const receipt = d.confirmDelivery('portAgent', s, podEvent(REF, { signedBy: 'portAgent' }));
    d.expectStatus(s, Status.Released);
    d.waitFinal(receipt);
    d.showBalances();
  },
};
