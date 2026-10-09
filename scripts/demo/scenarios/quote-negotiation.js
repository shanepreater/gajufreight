import { gaju } from '../lib/fixtures.js';

const REF = 'GF-2026-0009';
const tasmanQuote = { price: gaju(3_200), schedule: [['Yantian, Shenzhen', 20]] };
const nordhavenQuote = { price: gaju(2_950), schedule: [['Rotterdam, Maasvlakte II', 30]] };
const tasmanRevised = { price: gaju(3_050), schedule: [['Yantian, Shenzhen', 20]] };
const tasmanFinal = { price: gaju(3_020), schedule: [['Yantian, Shenzhen', 20]] };

export default {
  id: 'quote-negotiation',
  title: 'Agreeing the price: forwarders quote, the shipper counters and accepts',
  summary: 'The shipper describes the consignment and invites three companies. They quote full terms; the shipper counters with a target price up to three times, and only the shipper accepts.',

  async run(d) {
    await d.step('Shipper describes the consignment (3 pallets, Yantian → Tilburg) and invites three companies to quote');
    d.note('Unit sizes, weights and the two places are on-chain for anyone to read; the consignee and addresses are not (ADR 0015).');
    const q = d.requestQuotes({ ref: REF, invite: ['forwarderA', 'forwarderB', 'carrier'] });

    await d.step('Only invited forwarders can quote, and the shipper cannot quote for them');
    d.quote('mallory', q, { terms: tasmanQuote, expect: 'NOT_INVITED' });
    d.quote('shipper', q, { terms: tasmanQuote, expect: 'NOT_INVITED' });

    await d.step('Kōwhai declines: it has no capacity on the lane');
    d.declineQuote('carrier', q, { reason: 'No space on Yantian sailings this month' });

    await d.step('A quote must carry the shipper’s arbiter panel and dispute terms unchanged');
    d.note('The shipper chose the panel when requesting quotes; forwarders set the price, schedule, deadline and attestors (ADR 0015).');
    d.quote('forwarderB', q, { terms: nordhavenQuote, changes: { quorum: 1 }, expect: 'DISPUTE_CHANGED' });

    await d.step('Tasman and Nordhaven quote, each on their own thread');
    d.quote('forwarderA', q, { terms: tasmanQuote });
    d.quote('forwarderB', q, { terms: nordhavenQuote, validForDays: 1 });

    await d.step('A forwarder cannot accept, even its own quote: only the shipper accepts');
    d.acceptQuote('forwarderB', q, { invitee: 'forwarderB', terms: nordhavenQuote, expect: 'ONLY_REQUESTER' });

    await d.step('The cheaper quote lapses while the shipper deliberates');
    d.advanceDays(1.5, 'shipper compares the offers');
    d.acceptQuote('shipper', q, { invitee: 'forwarderB', terms: nordhavenQuote, expect: 'OFFER_EXPIRED' });

    await d.step('Counter 1 of 3: the shipper asks Tasman for 3,000 木; Tasman revises to 3,050 木');
    d.counter('shipper', q, { invitee: 'forwarderA', price: gaju(3_000), note: 'Nordhaven was at 2,950' });
    d.acceptQuote('shipper', q, { invitee: 'forwarderA', terms: tasmanQuote, expect: 'NOT_YOUR_TURN' });
    d.quote('forwarderA', q, { terms: tasmanRevised });

    await d.step('Counters 2 and 3: Tasman holds at 3,050 木, then comes down to a final 3,020 木');
    d.counter('shipper', q, { invitee: 'forwarderA', price: gaju(3_000) });
    d.quote('forwarderA', q, { terms: tasmanRevised });
    d.counter('shipper', q, { invitee: 'forwarderA', price: gaju(3_000) });
    d.quote('forwarderA', q, { terms: tasmanFinal });

    await d.step('That was the last counter: the final quote can only be accepted or left to lapse');
    d.counter('shipper', q, { invitee: 'forwarderA', price: gaju(3_010), expect: 'ROUND_LIMIT' });
    d.acceptQuote('shipper', q, { invitee: 'forwarderA', terms: tasmanRevised, expect: 'TERMS_CHANGED' });

    await d.step('Shipper accepts the final quote: the deal is fixed on-chain');
    d.acceptQuote('shipper', q, { invitee: 'forwarderA', terms: tasmanFinal });
    d.expectAgreement(q, 'forwarderA', tasmanFinal);

    await d.step('Every other thread is now closed');
    d.quote('forwarderB', q, { terms: nordhavenQuote, expect: 'BAD_STATE' });
    d.note('Next: the shipment escrow is created from exactly these terms (ADR 0004).');
  },
};
