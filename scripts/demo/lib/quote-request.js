// JS model of QuoteRequest (contracts/src/quote-request.aes, ADR 0004, ADR 0015): the
// negotiation stage. It never holds money. Keep in lockstep with the Sophia source: same
// entrypoints, same check order (role → status → args), same error codes.
import { ContractError } from './errors.js';
import { hashEvidence } from './shipping-feed.js';

export const QuoteStatus = Object.freeze({ Open: 'Open', Agreed: 'Agreed', Cancelled: 'Cancelled' });

// A request lists at most this many unit lines, so its storage stays small.
export const MAX_UNIT_LINES = 20;

// Terms are negotiated off-chain as data and committed by hash.
export const termsHash = (terms) => hashEvidence(terms);

// What a quote is for: the escrow must be booked for exactly this job (HLD §5).
export const jobHash = ({ manifest, consignee, deadline }) => hashEvidence({ manifest, consignee, deadline });

const require = (ok, code) => {
  if (!ok) throw new ContractError(code);
};
const positive = (n) => Number.isInteger(n) && n > 0;

function validConsignment({ units, origin, destination, deliverBy }, blockHeight) {
  const lineOk = (u) => [u.count, u.lengthMm, u.widthMm, u.heightMm, u.weightG].every(positive);
  return (
    units.length > 0 &&
    units.length <= MAX_UNIT_LINES &&
    units.every(lineOk) &&
    origin !== '' &&
    destination !== '' &&
    (deliverBy === null || (Number.isInteger(deliverBy) && deliverBy > blockHeight))
  );
}

const newThread = () => ({ quote: null, counter: null, counters: 0, declined: false });

// The invited thread for a requester's move: its role, then whether it's still open.
function requesterThread(s, caller, invitee) {
  require(caller === s.requester, 'ONLY_REQUESTER');
  require(s.invited.includes(invitee), 'NOT_INVITED');
  require(s.status === QuoteStatus.Open, 'BAD_STATE');
  const thread = s.threads[invitee] ?? newThread();
  require(!thread.declined, 'THREAD_CLOSED');
  return thread;
}

// The caller's own thread, for an invitee's move.
function inviteeThread(s, caller) {
  require(s.invited.includes(caller), 'NOT_INVITED');
  require(s.status === QuoteStatus.Open, 'BAD_STATE');
  const thread = s.threads[caller] ?? newThread();
  require(!thread.declined, 'THREAD_CLOSED');
  return thread;
}

export const QuoteRequest = {
  name: 'QuoteRequest',
  payable: [],

  // Created by Platform.new_quote, which passes the real requester, the consignment to
  // price, and its current max_rounds (counters per thread, ADR 0015), fee terms and the
  // parent escrow for a leg (ADR 0010). A quote deployed any other way isn't registered.
  init(ctx, { requester, invited, job, consignment, maxRounds, parent = null, feeTerms }) {
    const unique = [...new Set(invited)];
    require(unique.length > 0 && !unique.includes(requester), 'NOT_INVITED');
    require(validConsignment(consignment, ctx.blockHeight), 'BAD_CONSIGNMENT');
    return { requester, invited: unique, job, consignment, maxRounds, parent, feeTerms, threads: {}, status: QuoteStatus.Open, agreed: null };
  },

  views: {
    // The main escrow this leg was subcontracted from, or null (ADR 0010).
    parent: (s) => s.parent,
    // The fee in force when the quote was requested: fixed for the whole negotiation (ADR 0010).
    fee_terms: (s) => s.feeTerms,
    // What the forwarders are asked to price.
    consignment: (s) => s.consignment,
    // One forwarder's thread: its latest quote, the shipper's pending counter, the count.
    thread: (s, { invitee }) => s.threads[invitee] ?? null,
    // The latest quote answers the last counter allowed: accept it or let it lapse.
    is_final: (s, { invitee }) => {
      const t = s.threads[invitee];
      return Boolean(t?.quote && !t.counter && t.counters === s.maxRounds);
    },
    // What the escrow reads at creation: null until agreed.
    agreement: (s) => (s.agreed ? { requester: s.requester, ...s.agreed, job: s.job } : null),
  },

  entrypoints: {
    // An invited forwarder quotes full terms: first, or in answer to the shipper's counter.
    quote(ctx, { terms, validUntil }) {
      const s = ctx.state;
      const thread = inviteeThread(s, ctx.caller);
      require(thread.quote === null || thread.counter !== null, 'NOT_YOUR_TURN');
      require(Number.isInteger(validUntil) && validUntil > ctx.blockHeight, 'OFFER_EXPIRED');
      const round = thread.counters + 1;
      s.threads[ctx.caller] = { ...thread, quote: { terms, validUntil, round }, counter: null };
      ctx.emit({ type: 'Quoted', invitee: ctx.caller, terms, round });
    },

    // The shipper names a target price, with an optional note (a hash; the text stays
    // off-chain). The forwarder answers with a revised quote or declines.
    counter(ctx, { invitee, price, note = null }) {
      const s = ctx.state;
      const thread = requesterThread(s, ctx.caller, invitee);
      require(thread.quote !== null && thread.counter === null, 'NOT_YOUR_TURN');
      require(thread.counters < s.maxRounds, 'ROUND_LIMIT');
      require(typeof price === 'bigint' && price > 0n, 'BAD_PRICE');
      s.threads[invitee] = { ...thread, counter: { price, note }, counters: thread.counters + 1 };
      ctx.emit({ type: 'Countered', invitee, price });
    },

    // The shipper accepts exactly the quote it saw; every other thread closes.
    accept(ctx, { invitee, terms }) {
      const s = ctx.state;
      const thread = requesterThread(s, ctx.caller, invitee);
      require(thread.quote !== null, 'NO_OFFER');
      require(thread.counter === null, 'NOT_YOUR_TURN');
      require(thread.quote.terms === terms, 'TERMS_CHANGED');
      require(ctx.blockHeight <= thread.quote.validUntil, 'OFFER_EXPIRED');
      s.status = QuoteStatus.Agreed;
      s.agreed = { counterparty: invitee, terms };
      ctx.emit({ type: 'Agreed', counterparty: invitee, terms });
    },

    // An invited forwarder steps out, with an optional reason (a hash). Its thread closes;
    // the others carry on.
    decline(ctx, { note = null }) {
      const s = ctx.state;
      const thread = inviteeThread(s, ctx.caller);
      s.threads[ctx.caller] = { ...thread, declined: true };
      ctx.emit({ type: 'Declined', invitee: ctx.caller });
    },

    withdraw(ctx) {
      const s = ctx.state;
      require(ctx.caller === s.requester, 'ONLY_REQUESTER');
      require(s.status === QuoteStatus.Open, 'BAD_STATE');
      s.status = QuoteStatus.Cancelled;
      ctx.emit({ type: 'Cancelled' });
    },
  },
};
