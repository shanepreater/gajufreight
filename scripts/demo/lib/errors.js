// Contract error codes mirror the require() strings in docs/hld.md §5.
export class ContractError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ContractError';
    this.code = code;
  }
}

// Raised when a scenario's expectation is not met (a demo bug, not a contract rejection).
export class DemoAssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DemoAssertionError';
  }
}

const MESSAGES = {
  ONLY_SHIPPER: 'only the shipper can do this',
  ONLY_ARBITER: 'only a member of the arbiter panel can vote',
  BAD_QUORUM: 'the panel needs distinct arbiters, no more than the platform’s current panel limit, and a quorum between 1 and the panel size',
  CONFLICTED_ARBITER: 'an arbiter cannot also be the shipper, carrier or consignee',
  ARBITRATION_OPEN: 'the panel still has time to rule; the fallback applies only after the arbitration window',
  UNAUTHORIZED: 'this account has no role in this shipment that allows the action',
  BAD_STATE: 'not allowed at this stage',
  NOT_AGREED: 'an escrow can only be created from an agreed quote, on exactly the agreed terms',
  BAD_SCHEDULE: 'milestones must each be 1–100%, at different places, and total at most 100%',
  ONLY_ADMIN: 'only a platform admin can propose or approve a settings change',
  BAD_SETTING: 'that change is not allowed: settings must be known and within their limits (counts at least 1, the fee rate 0–10%, the minimum fee 0 or more); you can only add someone who is not yet an admin, or remove a current admin while at least the quorum remain',
  BAD_TREASURY: 'the platform needs an account to receive its fees',
  UNKNOWN_ESCROW: 'a leg can only be subcontracted from a GajuFreight shipment',
  NOT_PAYEE: 'only the company being paid for that shipment can subcontract a leg of it',
  LEG_TOO_LARGE: 'a leg can’t cost more than the shipment it is part of',
  NO_PROPOSAL: 'there is no open settings proposal with that number',
  ROUND_LIMIT: 'the round limit for this negotiation has been reached; accept the final offer or let it lapse',
  UNKNOWN_QUOTE: 'that quote was not created by the GajuFreight platform',
  NOT_INVITED: 'only the requester and the invited party can act on this quote thread',
  ONLY_REQUESTER: 'only whoever asked for the quotes can withdraw the request',
  NO_OFFER: 'there is no offer on this thread to accept yet',
  OWN_OFFER: 'you cannot accept your own offer; the other side has to',
  TERMS_CHANGED: 'the offer changed since you saw it; review the latest terms',
  OFFER_EXPIRED: 'this offer is no longer valid; ask for a new one',
  WRONG_AMOUNT: 'escrow must be funded with exactly the agreed amount',
  BAD_AMOUNT: 'shipment amount must be greater than zero',
  BAD_DEADLINE: 'the delivery deadline must be in the future, and the arbitration window longer than 0 blocks',
  BAD_SPLIT: 'dispute split must be between 0% and 100%',
  BAD_KIND: 'checkpoints are Milestone, ScanIn or ScanOut; delivery is confirmed separately',
  BAD_MANIFEST: 'a manifest needs at least one package with unique, well-formed IDs',
  MANIFEST_MISMATCH: 'the package list on this device does not match the booked manifest; refresh before scanning',
  BAD_LABEL: 'not a GajuFreight package label',
  NOT_EXPIRED: 'the delivery deadline has not passed yet',
  NOT_PAYABLE: 'this action does not accept funds',
  BAD_VALUE: 'an amount sent must be a whole, non-negative number of the smallest Gaju unit',
  INSUFFICIENT_BALANCE: 'account balance too low',
  UNKNOWN_CONTRACT: 'no such shipment contract',
  UNKNOWN_ENTRYPOINT: 'no such contract action',
  UNKNOWN_ACCOUNT: 'no such account',
  BAD_SIGNATURE: 'webhook signature invalid; event discarded',
  DUPLICATE: 'event already ingested; ignored',
};

export const explain = (code) => MESSAGES[code] ?? 'unknown error';
