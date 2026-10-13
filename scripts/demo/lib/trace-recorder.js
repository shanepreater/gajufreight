// Records what happens on a SimChain as a trace a chain runner can replay against the compiled
// contracts (#70): each step a wallet could take, in the contract's argument order, with the
// demo's outcome, events (in the contract's field order) and balance changes. The trace format
// is described in contracts/test/README.md.
//
// Addresses become labels: an account is its name (ak_demo_shipper -> shipper) and a contract is
// its kind and creation order (ShipmentEscrow#2), so the runner can map each to the address it
// gets on the chain. A step the chain can't replay (a call with no such entrypoint, a forked
// microblock) marks the whole trace unreplayable, with the reason.
import { positionalArgs, projectEvent } from './contract-interface.js';
import { sourceOf } from './hash-sources.js';

const snake = (key) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const isAddress = (v) => typeof v === 'string' && (v.startsWith('ak_demo_') || v.startsWith('ct_demo_'));

export class TraceRecorder {
  steps = [];
  unreplayable = null;
  #labels = new Map(); // contract id -> label
  #count = {};

  constructor(chain) {
    this.chain = chain;
    // Recording must never change a test's outcome: anything it can't record makes the trace
    // unreplayable instead.
    chain.observer = (step) => {
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
    if (address.startsWith('ak_demo_')) return address.slice('ak_demo_'.length);
    return this.#labels.get(address) ?? address;
  }

  // Values as JSON: amounts as { $int }, addresses as { $addr: label }, a hash the contracts
  // compute themselves as { $hash: { kind, of } }, record fields in the contract's snake_case.
  encode(value) {
    if (typeof value === 'bigint') return { $int: value.toString() };
    if (isAddress(value)) return { $addr: this.#label(value) };
    if (typeof value === 'string') {
      const source = sourceOf(value);
      return source ? { $hash: { kind: source.kind, of: this.encode(source.of) } } : value;
    }
    if (Array.isArray(value)) return value.map((v) => this.encode(v));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [snake(k), this.encode(v)]));
    return value ?? null;
  }

  #args(contract, fn, args) {
    try {
      return this.encode(positionalArgs(contract, fn, args));
    } catch (e) {
      this.#skip(e.message);
      return null;
    }
  }

  #record(step) {
    if (step.op === 'account') return this.steps.push({ op: 'account', account: this.#label(step.address), balance: this.encode(step.balance) });
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
      ...(step.op !== 'deploy' && { function: fn }),
      args: contract ? this.#args(contract, fn, step.args) : null,
      ...(step.op !== 'view' && { value: this.encode(step.value ?? 0n) }),
    };
    if (!step.ok) {
      if (step.error === null) this.#skip(`${contract}.${fn} failed outside the contract`);
      return this.steps.push({ ...recorded, error: step.error });
    }
    if (step.op === 'deploy') recorded.as = this.#label(step.result);
    else recorded.result = this.encode(step.result);
    if (step.op !== 'view') {
      recorded.events = step.events.map((e) => ({ contract: this.#label(e.contract), event: this.encode(projectEvent(e.name, e)) }));
      recorded.balances = Object.fromEntries(step.balances.map(([address, delta]) => [this.#label(address), this.encode(delta)]));
    }
    return this.steps.push(recorded);
  }
}
