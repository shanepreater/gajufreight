import { Kind, Status } from '../lib/shipment-escrow.js';
import { gaju } from '../lib/fixtures.js';

const REF = 'GF-2026-0010';
const YANTIAN = 'Yantian, Shenzhen';
const ROTTERDAM = 'Rotterdam, Maasvlakte II';
const H = (c) => c.repeat(64);

// What the shipper and the forwarder agree: 3,000 木, 20% on pickup, 50% at Rotterdam, rest on delivery.
const MAIN = { price: gaju(3_000), schedule: [[YANTIAN, 20], [ROTTERDAM, 50]] };
// What the forwarder agrees with each subcontracted carrier (paid on delivery of their leg).
const OCEAN = { price: gaju(1_500), schedule: [] };
const ROAD = { price: gaju(400), schedule: [] };

export default {
  id: 'forwarder-multi-leg',
  title: 'Forwarder with two subcontracted legs and milestone payments',
  summary: 'The shipper agrees a price with a forwarder, who subcontracts an ocean leg and a road leg. Each stage is its own contract; milestones pay the forwarder as the goods move.',

  async run(d) {
    await d.step('Stage 1: shipper and Tasman agree 3,000 木 (20% on pickup, 50% at Rotterdam, rest on delivery)');
    const q = d.requestQuotes({ ref: REF, invite: ['forwarderA'] });
    d.propose('forwarderA', q, { invitee: 'forwarderA', terms: MAIN });
    d.acceptQuote('shipper', q, { invitee: 'forwarderA', terms: MAIN });

    await d.step('Stage 2: the shipment escrow is created from exactly those terms, then funded');
    d.book({ ref: `${REF}-x`, deadlineInDays: 35, payee: 'forwarderA', quote: q, terms: { ...MAIN, price: gaju(2_000) }, expect: 'NOT_AGREED' });
    const main = d.book({ ref: REF, deadlineInDays: 35, payee: 'forwarderA', quote: q, terms: MAIN, attestors: ['originAgent', 'portAgent', 'customs'] });

    await d.step('Tasman subcontracts the ocean leg to Kōwhai: its own quote and escrow, funded by Tasman');
    const qOcean = d.requestQuotes({ ref: `${REF}-L1`, by: 'forwarderA', invite: ['carrier'], consignee: 'trucker', deadlineInDays: 30 });
    d.propose('carrier', qOcean, { invitee: 'carrier', terms: OCEAN });
    d.acceptQuote('forwarderA', qOcean, { invitee: 'carrier', terms: OCEAN });
    const ocean = d.book({ ref: `${REF}-L1`, by: 'forwarderA', payee: 'carrier', consignee: 'trucker', deadlineInDays: 30, quote: qOcean, terms: OCEAN, attestors: ['portAgent'] });

    await d.step('…and the road leg to Brabant Road Haulage');
    const qRoad = d.requestQuotes({ ref: `${REF}-L2`, by: 'forwarderA', invite: ['trucker'] });
    d.propose('trucker', qRoad, { invitee: 'trucker', terms: ROAD });
    d.acceptQuote('forwarderA', qRoad, { invitee: 'trucker', terms: ROAD });
    const road = d.book({ ref: `${REF}-L2`, by: 'forwarderA', payee: 'trucker', consignee: 'consignee', deadlineInDays: 35, quote: qRoad, terms: ROAD, attestors: [] });

    await d.step('Pickup: the Yantian terminal scans the container in, which releases 20% to Tasman');
    d.attest('originAgent', main, YANTIAN, H('1'), { kind: Kind.ScanIn });

    await d.step('Tasman scanning in at Rotterdam itself releases nothing: a payee cannot pay itself');
    d.attest('forwarderA', main, ROTTERDAM, H('2'), { kind: Kind.ScanIn });
    d.note('Checkpoint recorded, but no payout: only an attestor’s scan-in releases a milestone.');

    await d.step('Rotterdam: the port agent scans in (50% to Tasman); Brabant takes over and confirms the ocean leg (Kōwhai paid)');
    d.attest('portAgent', main, ROTTERDAM, H('3'), { kind: Kind.ScanIn });
    d.confirmDelivery('trucker', ocean, { id: `${REF}-handover`, type: 'HANDOVER', location: ROTTERDAM, occurredAt: '2026-10-28T08:00:00Z', source: 'trucker' });
    d.note('Handover = the incoming leg’s delivery plus the next scan-in. Until GRIDS can batch calls (HLD Q10), that may be two signatures.');

    await d.step('Tilburg: the consignee confirms the road leg (Brabant paid) and the shipment (the final 30% to Tasman)');
    const pod = { id: `${REF}-pod`, type: 'PROOF_OF_DELIVERY', location: 'Lindqvist DC, Tilburg', occurredAt: '2026-10-30T14:00:00Z', source: 'consignee' };
    d.confirmDelivery('consignee', road, pod);
    const receipt = d.confirmDelivery('consignee', main, pod);
    d.expectStatus(main, Status.Released);
    d.waitFinal(receipt);

    await d.step('Settlement: every stage settled independently; Tasman keeps the difference');
    d.showBalances(['shipper', 'forwarderA', 'carrier', 'trucker']);
    d.note('Tasman: received 3,000 木 from the shipper and paid 1,900 木 to its two carriers, a margin of 1,100 木.');
  },
};
