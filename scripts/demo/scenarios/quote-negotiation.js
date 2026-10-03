import { gaju } from '../lib/fixtures.js';

const REF = 'GF-2026-0009';
const tasmanQuote = { price: gaju(3_200), schedule: [['Yantian, Shenzhen', 20]] };
const nordhavenQuote = { price: gaju(2_950), schedule: [['Rotterdam, Maasvlakte II', 30]] };
const shipperCounter = { price: gaju(3_000), schedule: [['Yantian, Shenzhen', 20]] };
const tasmanRevised = { price: gaju(3_050), schedule: [['Yantian, Shenzhen', 20]] };

export default {
  id: 'quote-negotiation',
  title: 'Agreeing the price: quotes, counter-offers, acceptance',
  summary: 'The shipper invites two forwarders to quote. Offers and counter-offers are on-chain, and the deal is fixed only when the other side accepts the exact terms.',

  async run(d) {
    await d.step('Shipper asks two invited forwarders to quote for moving 3 pallets Yantian → Tilburg');
    const q = d.requestQuotes({ ref: REF });

    await d.step('Only invited forwarders can quote');
    d.propose('mallory', q, { invitee: 'mallory', terms: tasmanQuote, expect: 'NOT_INVITED' });

    await d.step('Both forwarders quote, each on their own thread');
    d.propose('forwarderA', q, { invitee: 'forwarderA', terms: tasmanQuote });
    d.propose('forwarderB', q, { invitee: 'forwarderB', terms: nordhavenQuote, validForDays: 1 });

    await d.step('A forwarder cannot accept its own quote');
    d.acceptQuote('forwarderB', q, { invitee: 'forwarderB', terms: nordhavenQuote, expect: 'OWN_OFFER' });

    await d.step('The cheaper quote lapses while the shipper deliberates');
    d.advanceDays(1.5, 'shipper compares the offers');
    d.acceptQuote('shipper', q, { invitee: 'forwarderB', terms: nordhavenQuote, expect: 'OFFER_EXPIRED' });

    await d.step('Shipper counters Tasman at 3,000 木; Tasman revises to 3,050 木');
    d.propose('shipper', q, { invitee: 'forwarderA', terms: shipperCounter });
    d.propose('forwarderA', q, { invitee: 'forwarderA', terms: tasmanRevised });

    await d.step('Accepting the old 3,000 木 terms fails: Tasman’s revision replaced them');
    d.acceptQuote('shipper', q, { invitee: 'forwarderA', terms: shipperCounter, expect: 'TERMS_CHANGED' });

    await d.step('Shipper accepts the revised quote: the deal is fixed on-chain');
    d.acceptQuote('shipper', q, { invitee: 'forwarderA', terms: tasmanRevised });
    d.expectAgreement(q, 'forwarderA', tasmanRevised);

    await d.step('Every other thread is now closed');
    d.propose('forwarderB', q, { invitee: 'forwarderB', terms: nordhavenQuote, expect: 'BAD_STATE' });
    d.note('Next: the shipment escrow is created from exactly these terms (ADR 0004).');
  },
};
