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
  #transfers = []; // value a contract sent: not an event on-chain, a balance change
  #seq = 0;
  #nested = 0;

  keyHeight = 1;
  timestamp = Date.UTC(2026, 9, 1);

  // Sees every step a wallet could take (accounts, deploys, calls, views, key blocks) with its
  // outcome and effects: how the trace recorder writes a replayable trace (#70). Called for
  // each new chain when set, e.g. by lib/trace-hook.js.
  static onCreate = null;
  observer = null;

  constructor() {
    SimChain.onCreate?.(this);
  }

  createAccount(label, balance = 0n) {
    const address = `ak_demo_${label}`;
    if (this.#balances.has(address)) throw new Error(`account ${address} exists`);
    this.#balances.set(address, balance);
    this.observer?.({ op: 'account', address, balance });
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

  // The contract's name (Platform, QuoteRequest, ShipmentEscrow), or null for an account.
  contractName(id) {
    return this.#contracts.get(id)?.def.name ?? null;
  }

  contractState(id) {
    const c = this.#contracts.get(id);
    if (!c) throw new ContractError('UNKNOWN_CONTRACT');
    return structuredClone(c.state);
  }

  // Read-only call (a Sophia `entrypoint` without `stateful`): returns a copy, changes nothing.
  view(contractId, name, args = {}) {
    return this.#observe({ op: 'view', contract: contractId, name, args }, () => this.#view(contractId, name, args));
  }

  #view(contractId, name, args) {
    const c = this.#contracts.get(contractId);
    if (!c) throw new ContractError('UNKNOWN_CONTRACT');
    const fn = c.def.views?.[name];
    if (!fn) throw new ContractError('UNKNOWN_ENTRYPOINT');
    // Like a dry-run call: a view sees the current block height (for expiry checks).
    return structuredClone(fn(structuredClone(c.state), args, { blockHeight: this.keyHeight }));
  }

  events(contractId) {
    return this.#events.filter((e) => !contractId || e.contract === contractId).map((e) => structuredClone(e));
  }

  // What a contract has sent (Chain.spend): { to, amount, kind, reason, txHash }. On-chain this
  // shows only as balance changes; the model keeps it for narration and tests.
  transfers(contractId) {
    return this.#transfers.filter((t) => t.from === contractId).map((t) => ({ ...t }));
  }

  // `value` is the amount attached to the create transaction: the new contract holds it
  // before init runs (ADR 0005).
  deploy(def, caller, args, { value = 0n } = {}) {
    return this.#observe({ op: 'deploy', caller, contract: def.name, args, value }, () =>
      this.#transact(caller, (txHash) => this.#create(def, caller, args, value, txHash, `ct_demo_${def.name}_${this.#seq}`)),
    );
  }

  #create(def, creator, args, value, txHash, id) {
    // Only a contract that accepts value may be created with it (`payableInit` in the model).
    if (typeof value !== 'bigint' || value < 0n) throw new ContractError('BAD_VALUE');
    if (value > 0n && !def.payableInit) throw new ContractError('NOT_PAYABLE');
    this.#balances.set(id, 0n);
    if (value > 0n) this.#move(creator, id, value);
    // The code exists before init runs, as on-chain (spike E11b).
    this.#contracts.set(id, { def, state: undefined });
    // As on Gajumaru (spike E2b): in init, Call.value is 0 and the balance already holds the amount.
    const ctx = this.#context(id, creator, 0n, txHash, null);
    this.#contracts.get(id).state = def.init(ctx, args);
    return id;
  }

  call(contractId, entrypoint, args = {}, { caller, value = 0n } = {}) {
    return this.#observe({ op: 'call', caller, contract: contractId, entrypoint, args, value }, () => this.#call(contractId, entrypoint, args, caller, value));
  }

  #call(contractId, entrypoint, args, caller, value) {
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
    this.observer?.({ op: 'advance', keyblocks: n });
  }

  // Simulates a micro-fork: the newest microblock is dropped and its effects undone.
  dropLastMicroblock() {
    const mb = this.#microblocks.at(-1);
    if (!mb) return null;
    if (this.receiptStatus(mb.txHash) === 'final') throw new Error('cannot drop a final microblock');
    this.#microblocks.pop();
    this.#restore(mb.before);
    this.#receipts.get(mb.txHash).dropped = true;
    this.observer?.({ op: 'drop' }); // a fork can't be replayed on demand
    return mb.txHash;
  }

  // Runs a step and tells the observer what came of it: the result or the error code, and,
  // for a step that succeeded, the events, the contracts it created and the balance changes.
  #observe(step, run) {
    if (!this.observer) return run();
    const balances = new Map(this.#balances);
    const eventCount = this.#events.length;
    const known = new Set(this.#contracts.keys());
    let out;
    try {
      out = run();
    } catch (e) {
      this.observer({ ...step, ok: false, error: e instanceof ContractError ? e.code : null });
      throw e;
    }
    const created = [...this.#contracts].filter(([id]) => !known.has(id)).map(([id, c]) => ({ id, name: c.def.name }));
    const changed = [...this.#balances].filter(([a, b]) => b !== (balances.get(a) ?? 0n)).map(([a, b]) => [a, b - (balances.get(a) ?? 0n)]);
    const events = this.#events.slice(eventCount).map((e) => ({ ...e, name: this.contractName(e.contract) }));
    this.observer({ ...step, ok: true, result: step.op === 'view' ? out : out.result, created, events, balances: changed });
    return out;
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
      spend: (to, amount, note = {}) => {
        this.#move(contractId, to, amount);
        this.#transfers.push({ from: contractId, to, amount, ...note, txHash });
      },
      balance: () => this.balanceOf(contractId), // Contract.balance
      query: (otherId, name, args) => this.#view(otherId, name, args),
      // Chain.clone(ref = template, value = …): a new contract running the template's code,
      // created by this contract and funded from its balance (spike E4).
      clone: (template, args, value = 0n) => {
        const t = this.#contracts.get(template);
        if (!t) throw new ContractError('UNKNOWN_CONTRACT');
        return this.#create(t.def, contractId, args, value, txHash, `ct_demo_${t.def.name}_${this.#seq}_${++this.#nested}`);
      },
      isContract: (address) => this.#contracts.has(address), // Address.is_contract
      // Address.is_payable: any account, or a contract declared `payable` (spike E12).
      isPayable: (address) => !this.#contracts.has(address) || this.#contracts.get(address).def.payableContract === true,
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
      transferCount: this.#transfers.length,
    };
  }

  #restore(s) {
    this.#balances = new Map(s.balances);
    this.#contracts = new Map([...s.contracts].map(([id, c]) => [id, { def: c.def, state: structuredClone(c.state) }]));
    this.#events.length = s.eventCount;
    this.#transfers.length = s.transferCount;
  }
}
