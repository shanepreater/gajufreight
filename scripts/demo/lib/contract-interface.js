// How the demo model lines up with the compiled contracts' interface (contracts/interface/*.aci.json):
// each call's arguments in the contract's order, and each event's fields in the contract's order.
// The trace recorder uses it to write calls the chain runner can replay (#70), and the drift
// tests check it against the ACI, so a contract change fails until the model follows.
import { readFileSync } from 'node:fs';
import { CHARGE_KINDS } from './shipment-escrow.js';

const FILES = { ShipmentEscrow: 'shipment-escrow', Platform: 'platform', QuoteRequest: 'quote-request' };

export function aci(contract) {
  if (!FILES[contract]) throw new Error(`${contract} is not one of the contracts`);
  return JSON.parse(readFileSync(new URL(`../../../contracts/interface/${FILES[contract]}.aci.json`, import.meta.url)));
}

// Where the demo names an argument differently from the contract: contract name -> demo name.
// Every other argument is the demo's camelCase name in snake_case.
const ARG_ALIASES = {
  ShipmentEscrow: { add_attestor: { a: 'attestor' }, remove_attestor: { a: 'attestor' } },
  Platform: { is_quote: { a: 'address' }, is_escrow: { a: 'address' }, has_role: { r: 'role' } },
  QuoteRequest: { init: { c: 'consignment', d: 'dispute' }, quote: { t: 'terms' }, accept: { terms_hash: 'terms' } },
};

// Arguments the demo lets callers leave out, with the default it then uses.
const ARG_DEFAULTS = {
  ShipmentEscrow: { confirm_delivery: { code_checked: false } },
};

const camel = (snake) => snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

// A call's arguments in the contract's order. A missing argument is a drift between the model
// and the contract, so it throws; optional arguments the demo leaves out are null (None).
export function positionalArgs(contract, fn, args = {}) {
  const spec = aci(contract).functions.find((f) => f.name === fn);
  if (!spec) throw new Error(`${contract}.${fn} is not in the contract's interface`);
  const aliases = ARG_ALIASES[contract]?.[fn] ?? {};
  return spec.arguments.map(({ name, type }) => {
    const key = aliases[name] ?? camel(name);
    if (key in args) return args[key];
    const fallback = ARG_DEFAULTS[contract]?.[fn];
    if (fallback && name in fallback) return fallback[name];
    if (type?.option) return null;
    throw new Error(`${contract}.${fn}: the model passes no '${key}' for the contract's '${name}'`);
  });
}

// Codes the contract puts in events in place of its datatypes (event fields can't carry one).
const KIND_CODES = { Milestone: 0, ScanIn: 1, ScanOut: 2, Delivered: 3 };
const kindCode = (kind) => KIND_CODES[kind];
const chargeCode = (kind) => CHARGE_KINDS.indexOf(kind);

// Each event's fields in the contract's order: a field name, or [name, encode] where the
// contract carries a code. Extra fields the demo emits (a status's `from`) aren't compared.
export const EVENT_FIELDS = {
  ShipmentEscrow: {
    Booked: ['quote', 'payee', 'job'],
    CheckpointAdded: ['attestor', ['kind', kindCode], 'evidence', 'location'],
    StatusChanged: ['to'],
    MilestonePaid: ['location', 'amount'],
    Voted: ['arbiter', 'payCarrierPct'],
    Settled: ['toPayee', 'toPayer'],
    RefundPaid: ['amount'],
    Confirmed: ['bond', 'fee'],
    Cancelled: ['by'],
    FeePaid: ['treasury', 'amount'],
    BondReleased: ['toPayee', 'toPayer'],
    AttestorAdded: ['attestor'],
    AttestorRemovalApproved: ['attestor', 'by'],
    AttestorRemoved: ['attestor'],
    ChargeProposed: ['id', ['kind', chargeCode], 'amount'],
    ChargeAccepted: ['id', 'amount'],
    ChargeDeclined: ['id'],
    DisputeRaised: ['raiser', 'deposit'],
    Flagged: ['attestor', 'evidence'],
    DisputeLapsed: [],
    ArbiterPaid: ['arbiter', 'amount'],
    DepositReturned: ['to', 'amount'],
    DepositForfeited: ['to', 'amount'],
  },
  Platform: {
    Proposed: ['id', 'proposer'],
    Applied: ['id'],
    QuoteCreated: ['quote', 'requester'],
    EscrowBooked: ['escrow', 'quote', 'payer'],
    LegReleased: ['leg', 'returned'],
    Verified: ['account', 'expires'],
    Revoked: ['account'],
  },
  QuoteRequest: {
    Quoted: ['invitee', 'terms', 'round'],
    Countered: ['invitee', 'price'],
    Declined: ['invitee'],
    Accepted: ['invitee', 'terms'],
    RequestWithdrawn: [],
  },
};

// An event as the contract emits it: its name and its fields in order.
export function projectEvent(contract, event) {
  const fields = EVENT_FIELDS[contract]?.[event.type];
  if (!fields) throw new Error(`${contract} emits no ${event.type} event`);
  return [event.type, ...fields.map((f) => (Array.isArray(f) ? f[1](event[f[0]]) : event[f]))];
}
