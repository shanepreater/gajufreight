// PLACEHOLDER backend: an in-memory stand-in for a Gajumaru node (Groot or AC).
// Models what the demo needs: balances, contract calls with atomic revert,
// microblock inclusion (pending), keyblock finality, and dropped microblocks.
// Replace with a real-chain backend in dev-approach phase 1.
import { createHash } from 'node:crypto';
import { ContractError } from './errors.js';

export const MICROBLOCK_MS = 3_000;
export const KEYBLOCK_MS = 120_000;
export const FINALITY_KEYBLOCKS = 2;

export class SimChain {
  #balances = new Map();
  #contracts = new Map(); // id -> { def, state }
  #microblocks = []; // { txHash, keyHeight, before }
  #receipts = new Map(); // txHash -> { keyHeight, dropped }
  #events = [];
  #seq = 0;
  #nested = 0;

  keyHeight = 1;
  timestamp = Date.UTC(2026, 9, 1);

  createAccount(label, balance = 0n) {
    const address = `ak_demo_${label}`;
    if (this.#balances.has(address)) throw new Error(`account ${address} exists`);
    this.#balances.set(address, balance);
    return address;
  }

  balanceOf(address) {
    return this.#balances.get(address) ?? 0n;
  }

  totalSupply() {
    let total = 0n;
    for (const b of this.#balances.values()) total += b;
    return total;
  }

  contractState(id) {
    const c = this.#contracts.get(id);
    if (!c) throw new ContractError('UNKNOWN_CONTRACT');
    return structuredClone(c.state);
  }

  // Read-only call (a Sophia `entrypoint` without `stateful`): returns a copy, changes nothing.
  view(contractId, name, args = {}) {
    const c = this.#contracts.get(contractId);
    if (!c) throw new ContractError('UNKNOWN_CONTRACT');
    const fn = c.def.views?.[name];
    if (!fn) throw new ContractError('UNKNOWN_ENTRYPOINT');
    return structuredClone(fn(structuredClone(c.state), args));
  }

  events(contractId) {
    return this.#events.filter((e) => !contractId || e.contract === contractId).map((e) => structuredClone(e));
  }

  // `value` models a payable init: the new contract holds it before init runs (ADR 0005).
  deploy(def, caller, args, { value = 0n } = {}) {
    return this.#transact(caller, (txHash) => this.#create(def, caller, args, value, txHash, `ct_demo_${def.name}_${this.#seq}`));
  }

  #create(def, creator, args, value, txHash, id) {
    this.#balances.set(id, 0n);
    if (value > 0n) this.#move(creator, id, value);
    const ctx = this.#context(id, creator, value, txHash, null);
    this.#contracts.set(id, { def, state: def.init(ctx, args) });
    return id;
  }

  call(contractId, entrypoint, args = {}, { caller, value = 0n } = {}) {
    const c = this.#contracts.get(contractId);
    if (!c) throw new ContractError('UNKNOWN_CONTRACT');
    const fn = c.def.entrypoints[entrypoint];
    if (!fn) throw new ContractError('UNKNOWN_ENTRYPOINT');
    return this.#transact(caller, (txHash) => {
      if (value > 0n) {
        if (!c.def.payable?.includes(entrypoint)) throw new ContractError('NOT_PAYABLE');
        this.#move(caller, contractId, value);
      }
      const live = this.#contracts.get(contractId);
      return fn(this.#context(contractId, caller, value, txHash, live), args);
    });
  }

  receiptStatus(txHash) {
    const r = this.#receipts.get(txHash);
    if (!r) return 'unknown';
    if (r.dropped) return 'dropped';
    return this.keyHeight - r.keyHeight >= FINALITY_KEYBLOCKS ? 'final' : 'pending';
  }

  advanceKeyblocks(n) {
    if (!Number.isInteger(n) || n < 0) throw new Error(`bad keyblock count ${n}`);
    this.keyHeight += n;
    this.timestamp += n * KEYBLOCK_MS;
  }

  // Simulates a micro-fork: the newest microblock is dropped and its effects undone.
  dropLastMicroblock() {
    const mb = this.#microblocks.at(-1);
    if (!mb) return null;
    if (this.receiptStatus(mb.txHash) === 'final') throw new Error('cannot drop a final microblock');
    this.#microblocks.pop();
    this.#restore(mb.before);
    this.#receipts.get(mb.txHash).dropped = true;
    return mb.txHash;
  }

  #transact(caller, fn) {
    if (!this.#balances.has(caller)) throw new ContractError('UNKNOWN_ACCOUNT');
    const txHash = `th_${createHash('sha256').update(`${++this.#seq}:${caller}`).digest('hex').slice(0, 40)}`;
    const before = this.#snapshot();
    let result;
    try {
      result = fn(txHash);
    } catch (e) {
      this.#restore(before);
      throw e;
    }
    this.#microblocks.push({ txHash, keyHeight: this.keyHeight, before });
    this.#receipts.set(txHash, { keyHeight: this.keyHeight, dropped: false });
    this.timestamp += MICROBLOCK_MS;
    return { txHash, keyHeight: this.keyHeight, result };
  }

  #context(contractId, caller, value, txHash, live) {
    return {
      caller,
      value,
      contract: contractId,
      blockHeight: this.keyHeight,
      timestamp: this.timestamp,
      state: live?.state,
      spend: (to, amount) => this.#move(contractId, to, amount),
      query: (otherId, name, args) => this.view(otherId, name, args),
      // Chain.create from a contract: the new contract's creator is this contract.
      create: (def, args) => this.#create(def, contractId, args, 0n, txHash, `ct_demo_${def.name}_${this.#seq}_${++this.#nested}`),
      emit: (event) => this.#events.push({ ...event, contract: contractId, txHash }),
    };
  }

  #move(from, to, amount) {
    if (amount < 0n) throw new Error('negative transfer');
    if (this.balanceOf(from) < amount) throw new ContractError('INSUFFICIENT_BALANCE');
    this.#balances.set(from, this.balanceOf(from) - amount);
    this.#balances.set(to, this.balanceOf(to) + amount);
  }

  #snapshot() {
    return {
      balances: new Map(this.#balances),
      contracts: new Map([...this.#contracts].map(([id, c]) => [id, { def: c.def, state: structuredClone(c.state) }])),
      eventCount: this.#events.length,
    };
  }

  #restore(s) {
    this.#balances = new Map(s.balances);
    this.#contracts = new Map([...s.contracts].map(([id, c]) => [id, { def: c.def, state: structuredClone(c.state) }]));
    this.#events.length = s.eventCount;
  }
}
