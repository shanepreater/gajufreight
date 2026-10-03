// JS model of QuoteRequest (docs/hld.md §5, ADR 0004): the negotiation stage.
// It never holds money. Keep in lockstep with the Sophia sketch: same entrypoints,
// same check order (role → status → args), same error codes.
import { ContractError } from './errors.js';
import { hashEvidence } from './shipping-feed.js';

export const QuoteStatus = Object.freeze({ Open: 'Open', Agreed: 'Agreed', Cancelled: 'Cancelled' });

// Terms are negotiated off-chain as data and committed by hash.
export const termsHash = (terms) => hashEvidence(terms);

const require = (ok, code) => {
  if (!ok) throw new ContractError(code);
};
const onThread = (s, caller, invitee) => s.invited.includes(invitee) && (caller === s.requester || caller === invitee);

export const QuoteRequest = {
  name: 'QuoteRequest',
  payable: [],

  // Created by Platform.new_quote, which passes the real requester and its current
  // max_rounds (ADR 0005). A quote deployed any other way isn't registered.
  init(ctx, { requester, invited, job, maxRounds }) {
    const unique = [...new Set(invited)];
    require(unique.length > 0 && !unique.includes(requester), 'NOT_INVITED');
    return { requester, invited: unique, job, maxRounds, offers: {}, status: QuoteStatus.Open, agreed: null };
  },

  views: {
    // What the escrow reads at creation: null until agreed.
    agreement: (s) => (s.agreed ? { requester: s.requester, ...s.agreed, job: s.job } : null),
  },

  entrypoints: {
    // The requester or the invitee replaces the offer on the invitee's thread.
    propose(ctx, { invitee, terms, validUntil }) {
      const s = ctx.state;
      require(onThread(s, ctx.caller, invitee), 'NOT_INVITED');
      require(s.status === QuoteStatus.Open, 'BAD_STATE');
      const round = (s.offers[invitee]?.round ?? 0) + 1;
      require(round <= s.maxRounds, 'ROUND_LIMIT'); // the N-th offer is final
      require(Number.isInteger(validUntil) && validUntil > ctx.blockHeight, 'OFFER_EXPIRED');
      s.offers[invitee] = { terms, validUntil, by: ctx.caller, round };
      ctx.emit({ type: 'Proposed', invitee, by: ctx.caller, terms, validUntil });
    },

    // The other side accepts exactly the terms it saw; every other thread closes.
    accept(ctx, { invitee, terms }) {
      const s = ctx.state;
      require(onThread(s, ctx.caller, invitee), 'NOT_INVITED');
      require(s.status === QuoteStatus.Open, 'BAD_STATE');
      const offer = s.offers[invitee];
      require(offer, 'NO_OFFER');
      require(offer.by !== ctx.caller, 'OWN_OFFER');
      require(offer.terms === terms, 'TERMS_CHANGED');
      require(ctx.blockHeight <= offer.validUntil, 'OFFER_EXPIRED');
      s.status = QuoteStatus.Agreed;
      s.agreed = { counterparty: invitee, terms };
      ctx.emit({ type: 'Agreed', counterparty: invitee, terms });
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
