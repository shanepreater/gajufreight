import { Status } from '../lib/shipment-escrow.js';
import { gaju, routeEvents, podEvent } from '../lib/fixtures.js';

const REF = 'GF-2026-0005';
const AMOUNT = gaju(750);

export default {
  id: 'access-control',
  title: 'Guard rails: mistakes and bad actors are blocked',
  summary: 'Invalid bookings, a stranger booking with someone else’s quote, wrong amounts and self-dealing are rejected, and nothing is paid twice.',

  async run(d) {
    await d.step('Invalid bookings are rejected');
    d.book({ ref: `${REF}-X`, amount: 0n, deadlineInDays: 35, expect: 'BAD_AMOUNT' });
    d.book({ ref: `${REF}-Y`, amount: AMOUNT, deadlineInDays: 0, expect: 'BAD_DEADLINE' });

    await d.step('The price is agreed first, on a quote the platform created');
    const terms = { price: AMOUNT, schedule: [] };
    const q = d.requestQuotes({ ref: REF, invite: ['carrier'] });
    d.propose('carrier', q, { invitee: 'carrier', terms });
    d.acceptQuote('shipper', q, { invitee: 'carrier', terms });

    await d.step('Booking must come from the requester, funded with exactly the agreed price');
    d.book({ ref: REF, by: 'mallory', quote: q, terms, expect: 'NOT_AGREED' });
    d.book({ ref: REF, quote: q, terms, value: AMOUNT - gaju(1), expect: 'WRONG_AMOUNT' });
    d.book({ ref: REF, quote: q, terms, value: AMOUNT + gaju(1), expect: 'WRONG_AMOUNT' });
    d.note('Rejected bookings are fully reverted: the shipper balance is unchanged.');
    d.showBalances(['shipper']);
    const s = d.book({ ref: REF, quote: q, terms });
    d.expectStatus(s, 'Funded');

    await d.step('Strangers cannot touch the shipment');
    const [first] = routeEvents(REF);
    const { evidenceHash } = d.ingest(d.webhook(first));
    d.attest('mallory', s, first.location, evidenceHash, { expect: 'UNAUTHORIZED' });
    d.dispute('mallory', s, 'griefing', { expect: 'UNAUTHORIZED' });
    d.vote('mallory', s, 0, { expect: 'ONLY_ARBITER' });
    d.attest('carrier', s, first.location, evidenceHash);

    await d.step('No self-dealing: the carrier cannot confirm its own delivery');
    d.confirmDelivery('carrier', s, podEvent(REF), { expect: 'UNAUTHORIZED' });

    await d.step('Consignee confirms once. A second confirmation cannot pay twice');
    d.confirmDelivery('consignee', s, podEvent(REF));
    d.confirmDelivery('consignee', s, podEvent(REF), { expect: 'BAD_STATE' });
    d.expectStatus(s, Status.Released);
    d.showBalances();
  },
};
