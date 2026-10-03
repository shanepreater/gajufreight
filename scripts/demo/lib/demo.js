// Facade the scenarios are written against. Each method performs one business
// action (book, fund, attest, dispute, ...), narrates it, and records it in the
// audit log. Pass `{ expect: 'CODE' }` to any action that should be blocked:
// the demo then asserts the exact rejection instead of failing.
import { ShipmentEscrow, Status, TERMINAL, Kind } from './shipment-escrow.js';
import { FeedIngest, signWebhook, hashEvidence, verifyEvidence } from './shipping-feed.js';
import { ContractError, DemoAssertionError, explain } from './errors.js';
import { CONTAINER, PARTIES, KEYBLOCKS_PER_DAY, formatGaju } from './fixtures.js';
import { FINALITY_KEYBLOCKS } from './sim-chain.js';
import { buildManifest, encodeLabel, manifestHash } from './package-labels.js';
import { CustodyLedger, ScanResult, ScanSession } from './scan-session.js';

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
    this.manifests = new Map(); // contract id -> manifest (off-chain; its hash is on-chain)
    this.custody = new Map(); // contract id -> CustodyLedger (read-model projection)
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

  // Default panel: 2 of 3 arbiters must agree within 3 days, else a 50/50 fallback (ADR 0002).
  book({
    ref,
    amount,
    deadlineInDays,
    attestors = ['portAgent', 'customs'],
    packages = [{ id: 'C1', description: `Container ${CONTAINER}` }],
    panel = ['arbiter1', 'arbiter2', 'arbiter3'],
    quorum = 2,
    arbitrationDays = 3,
    fallback = 50,
    by = 'shipper',
    expect,
  }) {
    const deadline = this.chain.keyHeight + Math.round(deadlineInDays * KEYBLOCKS_PER_DAY);
    const shipper = this.party(by);
    this.narrator.action(shipper.label, `${expect ? 'tries to book' : 'books'} ${ref}: ${formatGaju(amount)}, deliver by block #${deadline.toLocaleString('en-US')} (≈${deadlineInDays} days)`);
    const args = {
      carrier: this.party('carrier').address,
      consignee: this.party('consignee').address,
      attestors: attestors.map((k) => this.party(k).address),
      panel: panel.map((k) => this.party(k).address),
      quorum,
      window: Math.round(arbitrationDays * KEYBLOCKS_PER_DAY),
      fallback: BigInt(fallback),
      manifest: manifestHash(buildManifest(packages)),
      amount,
      deadline,
    };
    const receipt = this.#attempt({ action: 'book', ref, expect }, () => this.chain.deploy(ShipmentEscrow, shipper.address, args));
    if (!receipt) return null;
    const id = receipt.result;
    this.shipments.set(id, ref);
    this.manifests.set(id, buildManifest(packages));
    this.custody.set(id, new CustodyLedger());
    this.narrator.info(`contract ${id} · attestors: ${attestors.map((k) => this.party(k).label).join(', ')}`);
    this.narrator.info(`arbiter panel: ${quorum} of ${panel.length} must agree within ${arbitrationDays} days, else ${fallback}% to carrier`);
    return id;
  }

  // ── Contract actions ──────────────────────────────────────────────────

  fund(who, id, amount, opts = {}) {
    return this.#invoke({ who, id, entrypoint: 'fund', value: amount, verb: `fund the escrow with ${formatGaju(amount)}`, ...opts });
  }

  attest(who, id, location, evidenceHash, { kind = Kind.Milestone, ...opts } = {}) {
    const args = { location, kind, evidence: evidenceHash };
    const label = kind === Kind.Milestone ? 'checkpoint' : `${kind} checkpoint`;
    return this.#invoke({ who, id, entrypoint: 'add_checkpoint', args, verb: `sign ${label} "${location}" via GRIDS (evidence ${short(evidenceHash)})`, ...opts });
  }

  confirmDelivery(who, id, pod, opts = {}) {
    const evidence = this.#evidenceFor(pod);
    return this.#invoke({ who, id, entrypoint: 'confirm_delivery', args: { evidence }, verb: `confirm delivery via GRIDS (proof of delivery ${short(evidence)})`, ...opts });
  }

  dispute(who, id, reason, opts = {}) {
    return this.#invoke({ who, id, entrypoint: 'raise_dispute', verb: `raise a dispute: "${reason}"`, ...opts });
  }

  vote(who, id, payCarrierPct, opts = {}) {
    const args = { payCarrierPct: BigInt(payCarrierPct) };
    const receipt = this.#invoke({ who, id, entrypoint: 'vote', args, verb: `vote: ${payCarrierPct}% to carrier, ${100 - payCarrierPct}% to shipper`, ...opts });
    if (receipt) this.#reportPanel(id);
    return receipt;
  }

  fallback(who, id, opts = {}) {
    return this.#invoke({ who, id, entrypoint: 'resolve_by_fallback', verb: 'apply the fallback split agreed at booking', ...opts });
  }

  #reportPanel(id) {
    const state = this.chain.contractState(id);
    if (state.status === Status.Resolved) {
      this.narrator.ok('quorum reached: dispute settled and funds split');
      return;
    }
    const tally = Object.values(state.votes).map((v) => `${v}%`).join(', ');
    this.narrator.info(`votes so far: ${tally} (needs ${state.quorum} matching)`);
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

  // ── Package labels and scanning (ADR 0003) ────────────────────────────

  printLabels(id) {
    const { packages } = this.manifests.get(id);
    this.narrator.action(this.party('shipper').label, `prints ${packages.length} package label(s) for ${this.shipments.get(id)}`);
    packages.forEach((p, i) => this.narrator.info(`🏷  ${p.id} · ${i + 1} of ${packages.length} · ${p.description} · ${encodeLabel(id, p.id)}`));
  }

  label(id, packageId) {
    return encodeLabel(id, packageId);
  }

  // Scans every label at one location, then signs ONE checkpoint whose evidence lists them.
  // `labels` are raw scanned strings; `manual` are typed ids from damaged labels.
  scan(who, id, { location, kind, labels = [], manual = [], expect }) {
    const session = new ScanSession({
      contract: id,
      manifest: this.manifests.get(id),
      location,
      kind,
      ledger: this.custody.get(id),
      clock: () => this.chain.timestamp,
    });
    this.narrator.action(this.party(who).label, `${kind === Kind.ScanIn ? 'scans in' : 'scans out'} at ${location}`);
    for (const text of labels) this.#reportScan(session.scan(text));
    for (const packageId of manual) this.#reportScan(session.enterManually(packageId), ' (typed: damaged label)');

    const bundle = session.bundle();
    const total = bundle.scanned.length + bundle.missing.length;
    const summary = `${bundle.scanned.length} of ${total} present`;
    if (bundle.missing.length) this.narrator.warn(`${summary}; missing: ${bundle.missing.join(', ')} (recorded, not blocking)`);
    else this.narrator.ok(summary);

    const evidenceHash = this.feed.store(bundle);
    const receipt = this.attest(who, id, location, evidenceHash, { kind, expect });
    if (receipt) session.commit();
    return { receipt, bundle };
  }

  expectCustody(id, packageId, expected) {
    const actual = this.custody.get(id).where(packageId);
    if (actual?.state !== expected.state || actual?.location !== expected.location) {
      throw new DemoAssertionError(`${packageId}: expected ${expected.state} @ ${expected.location}, got ${actual ? `${actual.state} @ ${actual.location}` : 'never scanned'}`);
    }
    this.narrator.info(`${packageId} last seen: ${actual.state} @ ${actual.location}`);
  }

  showCustody(id) {
    const ledger = this.custody.get(id);
    const rows = this.manifests.get(id).packages.map((p) => {
      const path = ledger.path(p.id).map((h) => `${h.state} @ ${h.location}`);
      return [p.id, path.join(' → ') || 'not yet scanned'];
    });
    this.narrator.table(['Package', 'Custody'], rows);
  }

  #reportScan({ result, packageId, detail }, suffix = '') {
    const id = packageId ?? 'unreadable label';
    if (result === ScanResult.Expected) this.narrator.ok(`${id}${suffix}`);
    else if (result === ScanResult.Repeat) this.narrator.info(`${id} already scanned; ignored`);
    else this.narrator.warn(`${id}: ${result}${detail ? ` (${detail})` : ''}; kept out of the scan`);
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
