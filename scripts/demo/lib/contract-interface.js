// How the demo model lines up with the compiled contracts' interface (contracts/interface/*.aci.json):
// each call's arguments in the contract's order, and each event's fields in the contract's order.
// The trace recorder uses it to write calls the chain runner can replay (#70), and the drift
// tests check it against the ACI, so a contract change fails until the model follows.
import { readFileSync } from 'node:fs';
import { CHARGE_KINDS } from './shipment-escrow.js';
import { quoteTerms } from './quote-request.js';

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

// What a client sends where the model takes something looser: a quote's typed quote_terms
// record holds only the quoted fields (the model drops the rest, as the record type does).
const ARG_TO_CONTRACT = {
  QuoteRequest: { quote: { t: quoteTerms } },
};

const camel = (snake) => snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

// A call's arguments in the contract's order. A missing argument is a drift between the model
// and the contract, so it throws; optional arguments the demo leaves out are null (None).
export function positionalArgs(contract, fn, args = {}) {
  const spec = aci(contract).functions.find((f) => f.name === fn);
  if (!spec) throw new Error(`${contract}.${fn} is not in the contract's interface`);
  const aliases = ARG_ALIASES[contract]?.[fn] ?? {};
  const convert = ARG_TO_CONTRACT[contract]?.[fn] ?? {};
  return spec.arguments.map(({ name, type }) => {
    const key = aliases[name] ?? camel(name);
    if (key in args) return convert[name] ? convert[name](args[key]) : args[key];
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

// Constructors the demo spells differently from the contract.
const VARIANT_ALIASES = { Delivered: 'Delivery' };

export class TypeMismatch extends Error {}

// Finds a named type: a contract (its address), or a typedef such as ShipmentEscrow.kind.
function resolve(contract, type) {
  if (typeof type !== 'string' || !/^[A-Z]/.test(type)) return type;
  if (FILES[type]) return { contract: type };
  const [owner, name] = type.includes('.') ? type.split('.') : [contract, type];
  const def = aci(owner).typedefs.find((t) => t.name === name);
  if (!def) throw new TypeMismatch(`no type ${type}`);
  return { ...def.typedef, owner };
}

// Encodes a model value as the type the contract expects at that position, or throws
// TypeMismatch. `ref` turns an address into its trace label ({ $addr }), and knows whether it
// is a contract; `hashOf` tags a hash the contracts compute themselves (contracts/test/README.md).
export function encodeAs(contract, type, value, { ref, hashOf }) {
  const t = resolve(contract, type);
  const fail = (why) => {
    throw new TypeMismatch(`${JSON.stringify(type)}: ${why}`);
  };
  const at = (inner, v) => encodeAs(t.owner ?? contract, inner, v, { ref, hashOf });
  if (t === 'int') {
    if (typeof value === 'bigint') return { $int: value.toString() };
    if (Number.isSafeInteger(value)) return value;
    return fail(`${value} is not a whole number`);
  }
  if (t === 'bool') return typeof value === 'boolean' ? value : fail(`${value} is not a boolean`);
  if (t === 'string') return typeof value === 'string' ? value : fail(`${value} is not a string`);
  if (t === 'address' || t.contract) return ref(value, Boolean(t.contract)) ?? fail(`${value} is not ${t.contract ? 'a contract' : 'an address'}`);
  if (t === 'hash' || t.bytes) {
    if (typeof value !== 'string') return fail(`${value} is not ${t === 'hash' ? 'a hash' : 'bytes'}`);
    // Only a hash can be one the contracts compute; bytes (a salt) are always opaque.
    const source = t === 'hash' ? hashOf(value) : null;
    if (source) return { $hash: { kind: source.kind, of: source.of } };
    return value.length === 64 ? value : fail(`'${value}' is not 32 bytes`);
  }
  if (t.option) return value === null || value === undefined ? null : at(t.option[0], value);
  if (t.list) return Array.isArray(value) ? value.map((v) => at(t.list[0], v)) : fail('not a list');
  if (t.tuple?.length === 0 && (value === undefined || value === null)) return []; // unit: ()
  if (t.tuple) {
    const items = Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : null;
    if (!items || items.length !== t.tuple.length) return fail('not a tuple of the right size');
    return items.map((v, i) => at(t.tuple[i], v));
  }
  if (t.record) {
    if (!value || typeof value !== 'object') return fail('not a record');
    const given = Object.fromEntries(Object.entries(value).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), v]));
    const extra = Object.keys(given).filter((k) => !t.record.some((f) => f.name === k));
    if (extra.length) return fail(`fields the contract lacks: ${extra.join(', ')}`);
    return Object.fromEntries(t.record.map((f) => {
      if (!(f.name in given) && !f.type?.option) return fail(`no ${f.name}`);
      return [f.name, at(f.type, given[f.name] ?? null)];
    }));
  }
  if (t.variant) {
    const [name, ...rest] = typeof value === 'string' ? [value] : value && typeof value === 'object' ? [value.type, ...Object.values(value).slice(1)] : [];
    const constructor = VARIANT_ALIASES[name] ?? name;
    const spec = t.variant.map((v) => Object.entries(v)[0]).find(([c]) => c === constructor);
    if (!spec || spec[1].length !== rest.length) return fail(`no constructor ${name} with ${rest.length} arguments`);
    return { $variant: [constructor, ...rest.map((v, i) => at(spec[1][i], v))] };
  }
  return fail('a type the recorder does not encode');
}

// A function's argument types, return type, and an event's field types, from the ACI.
export const argTypes = (contract, fn) => aci(contract).functions.find((f) => f.name === fn).arguments.map((a) => a.type);
export const returnType = (contract, fn) => aci(contract).functions.find((f) => f.name === fn)?.returns ?? null;
export const eventTypes = (contract, name) => (aci(contract).event.variant.map((v) => Object.entries(v)[0]).find(([n]) => n === name) ?? [name, []])[1];
