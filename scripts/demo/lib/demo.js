// Facade the scenarios are written against. Each method performs one business
// action (book, fund, attest, dispute, ...), narrates it, and records it in the
// audit log. Pass `{ expect: 'CODE' }` to any action that should be blocked:
// the demo then asserts the exact rejection instead of failing.
import { ShipmentEscrow, Status, TERMINAL } from './shipment-escrow.js';
import { FeedIngest, signWebhook, hashEvidence, verifyEvidence } from './shipping-feed.js';
import { ContractError, DemoAssertionError, explain } from './errors.js';
import { PARTIES, KEYBLOCKS_PER_DAY, formatGaju } from './fixtures.js';
import { FINALITY_KEYBLOCKS } from './sim-chain.js';

const short = (hash) => `${hash.slice(0, 10)}…`;

export class Demo {
  #stepNo = 0;
  #startSupply;

  constructor({ chain, narrator, audit, feedSecret = 'demo-feed-secret' }) {
    this.chain = chain;
    this.narrator = narrator;
    this.audit = audit;
    this.feedSecret = feedSecret;
    this.feed = new FeedIngest(feedSecret);
    this.shipments = new Map(); // contract id -> reference
    this.parties = {};
    for (const p of PARTIES) {
      this.parties[p.key] = { ...p, address: chain.createAccount(p.key, p.balance) };
    }
    this.#startSupply = chain.totalSupply();
  }

  // ── Pacing and narration ──────────────────────────────────────────────

  async step(text) {
    this.#stepNo += 1;
    this.narrator.step(this.#stepNo, text);
    this.audit.record({ kind: 'step', n: this.#stepNo, text });
    await this.narrator.pause();
  }

  pause() {
    return this.narrator.pause();
  }

  note(text) {
    this.narrator.info(text);
  }

  party(key) {
    const p = this.parties[key];
    if (!p) throw new Error(`unknown party "${key}"`);
    return p;
  }

  // ── Booking ───────────────────────────────────────────────────────────

  book({ ref, amount, deadlineInDays, attestors = ['portAgent', 'customs'], by = 'shipper', expect }) {
    const deadline = this.chain.keyHeight + Math.round(deadlineInDays * KEYBLOCKS_PER_DAY);
    const shipper = this.party(by);
    this.narrator.action(shipper.label, `${expect ? 'tries to book' : 'books'} ${ref}: ${formatGaju(amount)}, deliver by block #${deadline.toLocaleString('en-US')} (≈${deadlineInDays} days)`);
    const args = {
      carrier: this.party('carrier').address,
      consignee: this.party('consignee').address,
      arbiter: this.party('arbiter').address,
      attestors: attestors.map((k) => this.party(k).address),
      amount,
      deadline,
    };
    const receipt = this.#attempt({ action: 'book', ref, expect }, () => this.chain.deploy(ShipmentEscrow, shipper.address, args));
    if (!receipt) return null;
    const id = receipt.result;
    this.shipments.set(id, ref);
    this.narrator.info(`contract ${id} · attestors: ${attestors.map((k) => this.party(k).label).join(', ')}`);
    return id;
  }

  // ── Contract actions ──────────────────────────────────────────────────

  fund(who, id, amount, opts = {}) {
    return this.#invoke({ who, id, entrypoint: 'fund', value: amount, verb: `fund the escrow with ${formatGaju(amount)}`, ...opts });
  }

  attest(who, id, location, evidenceHash, opts = {}) {
    const args = { location, evidence: evidenceHash };
    return this.#invoke({ who, id, entrypoint: 'add_checkpoint', args, verb: `sign checkpoint "${location}" via GRIDS (evidence ${short(evidenceHash)})`, ...opts });
  }

  confirmDelivery(who, id, pod, opts = {}) {
    const evidence = this.#evidenceFor(pod);
    return this.#invoke({ who, id, entrypoint: 'confirm_delivery', args: { evidence }, verb: `confirm delivery via GRIDS (proof of delivery ${short(evidence)})`, ...opts });
  }

  dispute(who, id, reason, opts = {}) {
    return this.#invoke({ who, id, entrypoint: 'raise_dispute', verb: `raise a dispute: "${reason}"`, ...opts });
  }

  resolve(who, id, payCarrierPct, opts = {}) {
    const args = { payCarrierPct: BigInt(payCarrierPct) };
    return this.#invoke({ who, id, entrypoint: 'resolve', args, verb: `settle the dispute: ${payCarrierPct}% to carrier, ${100 - payCarrierPct}% refunded to shipper`, ...opts });
  }

  refund(who, id, opts = {}) {
    return this.#invoke({ who, id, entrypoint: 'refund_after_deadline', verb: 'reclaim the escrow after the deadline', ...opts });
  }

  // ── Shipping events (off-chain feed → attestor signature) ─────────────

  webhook(event, { tamper = false } = {}) {
    const hook = signWebhook(event, this.feedSecret);
    if (tamper) hook.event.location = `${hook.event.location} (edited in transit)`;
    return hook;
  }

  ingest(hook, { expect } = {}) {
    const e = hook.event;
    this.narrator.event(`${e.type} · ${e.location} · ${e.occurredAt.slice(0, 10)} (reported by ${this.party(e.source).label})`);
    const result = this.feed.ingest(hook);
    this.audit.record({ kind: 'ingest', eventId: e.id, ...result });
    if (expect && result.reason !== expect) throw new DemoAssertionError(`expected feed to reject with ${expect}, got ${result.reason ?? 'accepted'}`);
    if (!expect && !result.accepted) throw new DemoAssertionError(`feed unexpectedly rejected ${e.id}: ${result.reason}`);
    if (result.accepted) this.narrator.ok(`webhook verified · evidence stored off-chain · hash ${short(result.evidenceHash)}`);
    else this.narrator.rejected(result.reason, explain(result.reason));
    return result;
  }

  // Normal path: the feed ingests the event, then the reporting party's attestor signs it on-chain.
  track(id, event) {
    const { evidenceHash } = this.ingest(this.webhook(event));
    return this.attest(event.source, id, event.location, evidenceHash);
  }

  verifyEvidence(evidenceHash, { tamper = false } = {}) {
    const bundle = this.feed.evidence(evidenceHash);
    if (tamper) bundle.details = { ...bundle.details, tampered: true };
    const ok = verifyEvidence(bundle, evidenceHash);
    if (ok) this.narrator.ok(`evidence ${short(evidenceHash)} matches its on-chain hash`);
    else this.narrator.rejected('HASH_MISMATCH', 'document does not match the hash anchored on-chain; tampering detected');
    this.audit.record({ kind: 'verify', evidenceHash, tamper, ok });
    return ok;
  }

  // ── Time and finality ─────────────────────────────────────────────────

  advanceDays(days, reason) {
    const keyblocks = Math.round(days * KEYBLOCKS_PER_DAY);
    this.chain.advanceKeyblocks(keyblocks);
    this.narrator.info(`⏱  ${days} day(s) pass${reason ? `: ${reason}` : ''} (now block #${this.chain.keyHeight.toLocaleString('en-US')})`);
  }

  waitFinal(receipt) {
    const status = this.chain.receiptStatus(receipt.txHash);
    if (status === 'dropped') throw new DemoAssertionError(`tx ${receipt.txHash} was dropped; resubmit before waiting`);
    const remaining = FINALITY_KEYBLOCKS - (this.chain.keyHeight - receipt.keyHeight);
    if (remaining > 0) this.chain.advanceKeyblocks(remaining);
    this.narrator.ok(`tx ${short(receipt.txHash)} final after ${FINALITY_KEYBLOCKS} keyblocks (≈4 min)`);
  }

  dropLastMicroblock() {
    const txHash = this.chain.dropLastMicroblock();
    this.narrator.warn(`micro-fork: the microblock holding tx ${short(txHash)} was dropped before finality`);
    this.audit.record({ kind: 'micro-fork', txHash });
    if (this.chain.receiptStatus(txHash) !== 'dropped') throw new DemoAssertionError('microblock drop not reflected in receipt');
    this.narrator.info('indexer spots the missing tx and asks the attestor to resubmit');
    return txHash;
  }

  // ── Assertions and reporting ──────────────────────────────────────────

  expectStatus(id, expected) {
    const actual = this.chain.contractState(id).status;
    if (actual !== expected) throw new DemoAssertionError(`${this.shipments.get(id)}: expected status ${expected}, got ${actual}`);
    this.narrator.info(`shipment status: ${actual}`);
  }

  expectCheckpoints(id, expected) {
    const actual = this.chain.contractState(id).checkpoints.length;
    if (actual !== expected) throw new DemoAssertionError(`${this.shipments.get(id)}: expected ${expected} checkpoints, got ${actual}`);
    this.narrator.info(`on-chain checkpoints: ${actual}`);
  }

  showBalances(keys = ['shipper', 'carrier', 'consignee']) {
    const rows = keys.map((k) => {
      const p = this.party(k);
      const now = this.chain.balanceOf(p.address);
      const delta = now - p.balance;
      return [p.label, p.role, formatGaju(now), delta === 0n ? '·' : `${delta > 0n ? '+' : ''}${formatGaju(delta)}`];
    });
    for (const [id, ref] of this.shipments) rows.push([`Escrow ${ref}`, 'Contract', formatGaju(this.chain.balanceOf(id)), '']);
    this.narrator.table(['Account', 'Role', 'Balance', 'Change'], rows);
  }

  // Fund conservation (AGENTS.md contract invariants) + constant total supply.
  checkInvariants() {
    if (this.chain.totalSupply() !== this.#startSupply) throw new DemoAssertionError('total supply changed');
    for (const [id, ref] of this.shipments) {
      const state = this.chain.contractState(id);
      const held = this.chain.balanceOf(id);
      const paid = this.chain.events(id).filter((e) => e.type === 'Paid').reduce((sum, e) => sum + e.amount, 0n);
      if (TERMINAL.has(state.status)) {
        if (held !== 0n || paid !== state.amount) throw new DemoAssertionError(`${ref}: terminal escrow not fully paid out`);
      } else if (state.status !== Status.Created && held !== state.amount) {
        throw new DemoAssertionError(`${ref}: escrow holds ${held}, expected ${state.amount}`);
      }
    }
    this.narrator.ok('invariants hold: every escrow balanced, total Gaju supply unchanged');
  }

  // ── Internals ─────────────────────────────────────────────────────────

  #invoke({ who, id, entrypoint, args = {}, value = 0n, verb, expect }) {
    const p = this.party(who);
    this.narrator.action(p.label, expect ? `→ tries to ${verb}` : `→ ${verb}`);
    const receipt = this.#attempt({ action: entrypoint, ref: this.shipments.get(id), who, expect }, () =>
      this.chain.call(id, entrypoint, args, { caller: p.address, value }),
    );
    if (receipt) this.narrator.ok(`accepted · tx ${short(receipt.txHash)} · pending (in microblock, ≈3 s)`);
    return receipt;
  }

  // Runs a chain operation; returns the receipt, or null if it was rejected as expected.
  #attempt(context, operation) {
    let receipt;
    try {
      receipt = operation();
    } catch (error) {
      if (!(error instanceof ContractError)) throw error;
      this.audit.record({ kind: 'call', ...context, outcome: 'rejected', code: error.code });
      if (!context.expect) throw error;
      if (error.code !== context.expect) throw new DemoAssertionError(`expected ${context.expect}, got ${error.code}`);
      this.narrator.rejected(error.code, explain(error.code));
      return null;
    }
    this.audit.record({ kind: 'call', ...context, outcome: 'accepted', txHash: receipt.txHash, height: receipt.keyHeight });
    if (context.expect) throw new DemoAssertionError(`expected ${context.expect}, but ${context.action} succeeded`);
    return receipt;
  }

  #evidenceFor(event) {
    if (this.feed.hasEvent(event.id)) return hashEvidence(event);
    return this.ingest(this.webhook(event)).evidenceHash;
  }
}
