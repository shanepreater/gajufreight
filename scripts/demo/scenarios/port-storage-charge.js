import { Status } from '../lib/shipment-escrow.js';
import { gaju, routeEvents, podEvent } from '../lib/fixtures.js';
import { hashEvidence } from '../lib/shipping-feed.js';

const REF = 'GF-2026-0011';
const AMOUNT = gaju(1_200);

export default {
  id: 'port-storage-charge',
  title: 'Port storage after delivery: an extra charge',
  summary: 'The container sat three extra days at Rotterdam. The carrier bills the storage after delivery; the shipper pays it straight through, with no GajuFreight fee, and declines a duty charge it disputes.',

  async run(d) {
    await d.step('Book, confirm and deliver as usual');
    const s = d.book({ ref: REF, amount: AMOUNT, deadlineInDays: 35 });
    for (const event of routeEvents(REF)) d.track(s, event);
    d.confirmDelivery('consignee', s, podEvent(REF));
    d.expectStatus(s, Status.Released);

    await d.step('The carrier bills three days of port storage, with the terminal invoice as evidence');
    const storage = hashEvidence({ ref: REF, kind: 'terminal-invoice', days: 3, terminal: 'Maasvlakte II' });
    const proposed = d.proposeCharge('carrier', s, 'Demurrage', gaju(120), storage);
    d.note('Extra charges are allowed after delivery: port storage is usually billed then (ADR 0020).');

    await d.step('Only the shipper can accept it, and only for exactly the amount');
    d.acceptCharge('carrier', s, proposed.result, { expect: 'ONLY_SHIPPER' });
    d.acceptCharge('shipper', s, proposed.result, { value: gaju(100), expect: 'WRONG_AMOUNT' });
    d.acceptCharge('shipper', s, proposed.result);

    await d.step('A duty charge the shipper disputes is declined and settled off the platform');
    const duty = d.proposeCharge('carrier', s, 'Duty', gaju(60), hashEvidence({ ref: REF, kind: 'duty-receipt' }));
    d.declineCharge('shipper', s, duty.result);
    d.acceptCharge('shipper', s, duty.result, { expect: 'CHARGE_CLOSED' });

    await d.step('Balances: the storage went straight to the carrier. The treasury holds only the 1% booking fee Kōwhai paid on confirming; none on the storage');
    d.showBalances(['shipper', 'carrier', 'treasury']);
  },
};
