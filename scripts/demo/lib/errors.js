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
  ONLY_ARBITER: 'only the named arbiter can settle a dispute',
  UNAUTHORIZED: 'caller is not a party or registered attestor for this shipment',
  BAD_STATE: "not allowed in the shipment's current status",
  WRONG_AMOUNT: 'escrow must be funded with exactly the agreed amount',
  BAD_AMOUNT: 'shipment amount must be greater than zero',
  BAD_DEADLINE: 'delivery deadline must be in the future',
  BAD_SPLIT: 'dispute split must be between 0% and 100%',
  NOT_EXPIRED: 'the delivery deadline has not passed yet',
  NOT_PAYABLE: 'this action does not accept funds',
  INSUFFICIENT_BALANCE: 'account balance too low',
  UNKNOWN_CONTRACT: 'no such shipment contract',
  UNKNOWN_ENTRYPOINT: 'no such contract action',
  UNKNOWN_ACCOUNT: 'no such account',
  BAD_SIGNATURE: 'webhook signature invalid; event discarded',
  DUPLICATE: 'event already ingested; ignored',
};

export const explain = (code) => MESSAGES[code] ?? 'unknown error';
