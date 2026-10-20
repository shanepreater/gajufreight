// Records what happens on a SimChain as a trace a chain runner can replay against the compiled
// contracts (#70): each step a wallet could take, in the contract's argument order, with the
// demo's outcome, events (in the contract's field order) and balance changes. The trace format
// is described in contracts/test/README.md.
//
// Addresses become labels: an account is its name (ak_demo_shipper -> shipper) and a contract is
// its kind and creation order (ShipmentEscrow#2), so the runner can map each to the address it
// gets on the chain. A step the chain can't replay (a call with no such entrypoint, a forked
// microblock) marks the whole trace unreplayable, with the reason.
import { positionalArgs, projectEvent, encodeAs, argTypes, returnType, eventTypes, TypeMismatch } from './contract-interface.js';
import { sourceOf } from './hash-sources.js';

// What each kind of contract-computed hash is made of, by type (contracts/test/README.md).
const HASH_SOURCES = {
  job: { manifest: 'hash', consignee: { option: ['address'] } },
  terms: 'QuoteRequest.quote_terms',
  commitment: { name: 'string', country: 'string', number: 'string', salt: { bytes: 32 } },
};

const isAccount = (v) => typeof v === 'string' && v.startsWith('ak_demo_');
const isContract = (v) => typeof v === 'string' && v.startsWith('ct_demo_');

export class TraceRecorder {
  steps = [];
  unreplayable = null;
  #labels = new Map(); // contract id -> label
  #count = {};

  constructor(chain) {
    this.chain = chain;
    // Recording must never change a test's outcome: anything it can't record makes the trace
    // unreplayable instead. A chain already observed (by the trace hook) keeps its observer.
    const previous = chain.observer;
    chain.observer = (step) => {
      previous?.(step);
      try {
        this.#record(step);
      } catch (e) {
        this.#skip(e.message);
      }
    };
  }

  toJSON() {
    return { version: 1, unreplayable: this.unreplayable, steps: this.steps };
  }

  #skip(reason) {
    this.unreplayable ??= reason;
  }

  #label(address) {
    if (isAccount(address)) return address.slice('ak_demo_'.length);
    return this.#labels.get(address) ?? address;
  }

  // An address as a trace label, or null if it isn't one (or isn't the contract asked for).
  #ref = (value, wantContract) => {
    if (isContract(value) && this.#labels.has(value)) return { $addr: this.#label(value) };
    if (isAccount(value) && !wantContract) return { $addr: this.#label(value) };
    return null;
  };

  // A hash the contracts compute themselves, with what it was made of, typed as the contract
  // hashes it, so the runner can rebuild it (contracts/test/README.md).
  #hashOf = (value) => {
    const source = sourceOf(value);
    if (!source) return null;
    const types = HASH_SOURCES[source.kind];
    const of = typeof types === 'string'
      ? this.#as('QuoteRequest', types, source.of)
      : Object.fromEntries(Object.entries(types).map(([field, type]) => [field, this.#as('Platform', type, source.of?.[field])]));
    return { kind: source.kind, of };
  };

  // Encodes a value as the contract's type at that position (contracts/test/README.md).
  #as(contract, type, value) {
    return encodeAs(contract, type, value, { ref: this.#ref, hashOf: this.#hashOf });
  }

  // What a hash was made of, and balances: amounts as { $int }, addresses as labels.
  plain(value) {
    if (typeof value === 'bigint') return { $int: value.toString() };
    if (isAccount(value) || isContract(value)) return { $addr: this.#label(value) };
    if (Array.isArray(value)) return value.map((v) => this.plain(v));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), this.plain(v)]));
    return value ?? null;
  }

  #args(contract, fn, args) {
    try {
      const values = positionalArgs(contract, fn, args);
      const types = argTypes(contract, fn);
      return values.map((v, i) => this.#as(contract, types[i], v));
    } catch (e) {
      this.#skip(`${contract}.${fn} arguments: ${e.message}`);
      return null;
    }
  }

  // A result the comparator can match, or { $untyped } where the model returns another shape.
  #result(contract, fn, value) {
    const type = returnType(contract, fn);
    if (type === null) return null;
    try {
      return this.#as(contract, type, value);
    } catch (e) {
      if (e instanceof TypeMismatch) return { $untyped: e.message };
      throw e;
    }
  }

  // An event it can't encode marks the trace, and the step is still recorded.
  #event(e) {
    try {
      const [name, ...fields] = projectEvent(e.name, e);
      const types = eventTypes(e.name, name);
      return { contract: this.#label(e.contract), event: [name, ...fields.map((v, i) => this.#as(e.name, types[i], v))] };
    } catch (err) {
      this.#skip(`${e.name}.${e.type} event: ${err.message}`);
      return { contract: this.#label(e.contract), event: [e.type] };
    }
  }

  #record(step) {
    if (step.op === 'account') return this.steps.push({ op: 'account', account: this.#label(step.address), balance: this.plain(step.balance) });
    if (step.op === 'advance') return this.steps.push({ op: 'advance', keyblocks: step.keyblocks });
    if (step.op === 'drop') {
      this.#skip('a dropped microblock (a fork) cannot be replayed');
      return this.steps.push({ op: 'drop' });
    }
    // Name new contracts first: the result and events may refer to them.
    for (const { id, name } of step.created ?? []) {
      this.#count[name] = (this.#count[name] ?? 0) + 1;
      this.#labels.set(id, `${name}#${this.#count[name]}`);
    }
    const contract = step.op === 'deploy' ? step.contract : this.chain.contractName(step.contract);
    if (!contract) this.#skip(`${step.op} on ${step.contract}, which is not a contract`);
    const fn = { deploy: 'init', call: step.entrypoint, view: step.name }[step.op];
    const recorded = {
      op: step.op,
      height: this.chain.keyHeight,
      ...(step.caller && { caller: this.#label(step.caller) }),
      contract: step.op === 'deploy' ? contract : this.#label(step.contract),
      // An escrow template is compiled with its platform's address (PLATFORM_ADDRESS).
      ...(step.platform && { platform: this.#label(step.platform) }),
      ...(step.op !== 'deploy' && { function: fn }),
      args: contract ? this.#args(contract, fn, step.args) : null,
      ...(step.op !== 'view' && { value: this.plain(step.value ?? 0n) }),
    };
    if (!step.ok) {
      if (step.error === null) this.#skip(`${contract}.${fn} failed outside the contract`);
      return this.steps.push({ ...recorded, error: step.error });
    }
    if (step.op === 'deploy') recorded.as = this.#label(step.result);
    else recorded.result = this.#result(contract, fn, step.result);
    if (step.op !== 'view') {
      recorded.events = step.events.map((e) => this.#event(e));
      recorded.balances = Object.fromEntries(step.balances.map(([address, delta]) => [this.#label(address), this.plain(delta)]));
    }
    return this.steps.push(recorded);
  }
}
