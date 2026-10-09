// Facade the scenarios are written against. Each method performs one business
// action (book, fund, attest, dispute, ...), narrates it, and records it in the
// audit log. Pass `{ expect: 'CODE' }` to any action that should be blocked:
// the demo then asserts the exact rejection instead of failing.
import { escrowFor, feeDue, Status, TERMINAL, Kind } from './shipment-escrow.js';
import { FeedIngest, signWebhook, hashEvidence, verifyEvidence } from './shipping-feed.js';
import { ContractError, DemoAssertionError, explain } from './errors.js';
import { CONSIGNMENT, CONTAINER, PARTIES, KEYBLOCKS_PER_DAY, formatGaju } from './fixtures.js';
import { FINALITY_KEYBLOCKS, codeHash } from './sim-chain.js';
import { buildManifest, encodeLabel, manifestHash } from './package-labels.js';
import { CustodyLedger, ScanResult, ScanSession } from './scan-session.js';
import { jobHash, termsHash } from './quote-request.js';
import { Platform } from './platform.js';

const short = (hash) => `${hash.slice(0, 10)}…`;

// "3,000 木 · 20% at Yantian, rest on delivery"
function describeTerms({ price, schedule }) {
  const parts = schedule.map(([location, pct]) => `${pct}% at ${location}`);
  return `${formatGaju(price)} · ${parts.length ? `${parts.join(', ')}, rest on delivery` : 'all on delivery'}`;
}

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
    this.quotes = new Map(); // quote contract id -> reference
    this.quoteJobs = new Map(); // quote contract id -> { packages, consignee, deadline } it was requested for
    this.parties = {};
    for (const p of PARTIES) {
      this.parties[p.key] = { ...p, address: chain.createAccount(p.key, p.balance) };
    }
    // One platform per demo: 2 of 3 admins change settings; it registers every quote (ADR 0005)
    // and receives the fee from each main escrow's payee payouts (ADR 0010).
    this.platform = chain.deploy(Platform, this.parties.admin1.address, {
      admins: ['admin1', 'admin2', 'admin3'].map((k) => this.parties[k].address),
      quorum: 2,
      treasury: this.parties.treasury.address,
    }).result;
    this.escrowDef = escrowFor(this.platform); // escrows trust only this platform
    // The admins vote in the escrow template's hash, so leg quotes can name a genuine parent.
    const vote = { change: { type: 'SetEscrowCode', hash: codeHash(this.escrowDef) } };
    const { result: id } = chain.call(this.platform, 'propose', vote, { caller: this.parties.admin1.address });
    chain.call(this.platform, 'approve', { id }, { caller: this.parties.admin2.address });
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
    payee = 'carrier',
    consignee = 'consignee',
    schedule = [],
    quote,
    terms = { price: amount, schedule },
    value, // sent with the booking: the price, plus a leg's fee bond (ADR 0010)
    expect,
  }) {
    // A quote fixes the job (packages, consignee, deadline) it was requested for.
    // A quote the demo didn't see (e.g. a look-alike) falls back to the caller's job,
    // so the contract itself gets to reject it (UNKNOWN_QUOTE).
    const job = this.quoteJobs.get(quote) ?? { packages, consignee, deadline: this.#deadlineIn(deadlineInDays) };
    ({ packages, consignee } = job);
    const { deadline } = job;
    const shipper = this.party(by);
    // Escrows are only created from a registered, agreed quote (ADR 0004, ADR 0005).
    // Scenarios about something else get a quick, silent agreement on the same terms.
    const agreedQuote = quote ?? this.#quickAgreement(by, payee, terms, this.#jobHashFor(job));
    value ??= this.#fundingFor(agreedQuote, terms.price);
    this.narrator.action(shipper.label, `${expect ? 'tries to book' : 'books and funds'} ${ref}: ${describeTerms(terms)} to ${this.party(payee).label}, sending ${formatGaju(value)}, deliver by block #${deadline.toLocaleString('en-US')}`);
    const args = {
      carrier: this.party(payee).address,
      consignee: this.party(consignee).address,
      attestors: attestors.map((k) => this.party(k).address),
      panel: panel.map((k) => this.party(k).address),
      quorum,
      window: Math.round(arbitrationDays * KEYBLOCKS_PER_DAY),
      fallback: BigInt(fallback),
      manifest: manifestHash(buildManifest(packages)),
      quote: agreedQuote,
      terms,
      deadline,
    };
    const receipt = this.#attempt({ action: 'book', ref, expect }, () => this.chain.deploy(this.escrowDef, shipper.address, args, { value }));
    if (!receipt) return null;
    const id = receipt.result;
    this.shipments.set(id, ref);
    this.manifests.set(id, buildManifest(packages));
    this.custody.set(id, new CustodyLedger());
    this.narrator.ok(`created and funded in one call: ${formatGaju(value)} locked · tx ${short(receipt.txHash)}`);
    this.narrator.info(`contract ${id} · attestors: ${attestors.map((k) => this.party(k).label).join(', ') || 'none'}`);
    this.narrator.info(`arbiter panel: ${quorum} of ${panel.length} must agree within ${arbitrationDays} days, else ${fallback}% to the payee`);
    return id;
  }

  // The price, plus the fee bond if the quote is a leg of a main shipment (ADR 0010).
  #fundingFor(quote, price) {
    if (typeof price !== 'bigint' || price <= 0n) return 0n;
    if (!this.quotes.has(quote) || this.chain.view(quote, 'parent') === null) return price;
    return price + feeDue(this.chain.view(quote, 'fee_terms'), price);
  }

  #deadlineIn(days) {
    return this.chain.keyHeight + Math.round(days * KEYBLOCKS_PER_DAY);
  }

  #jobHashFor({ packages, consignee, deadline }) {
    return jobHash({ manifest: manifestHash(buildManifest(packages)), consignee: this.party(consignee).address, deadline });
  }

  #quickAgreement(requester, payee, terms, job) {
    const from = this.party(requester).address;
    const to = this.party(payee).address;
    const { result: quote } = this.chain.call(this.platform, 'new_quote', { invited: [to], job, consignment: CONSIGNMENT }, { caller: from });
    this.chain.call(quote, 'quote', { terms: termsHash(terms), validUntil: this.chain.keyHeight + KEYBLOCKS_PER_DAY }, { caller: to });
    this.chain.call(quote, 'accept', { invitee: to, terms: termsHash(terms) }, { caller: from });
    this.quotes.set(quote, `quote for ${describeTerms(terms)}`);
    this.narrator.info(`price agreed with ${this.party(payee).label} via a quote request (see quote-negotiation)`);
    return quote;
  }

  // ── Contract actions ──────────────────────────────────────────────────

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

  // ── Negotiation (QuoteRequest, ADR 0004) ──────────────────────────────

  // The job (packages, consignee, deadline) is fixed here; the escrow must be booked for exactly it.
  requestQuotes({
    ref,
    by = 'shipper',
    invite = ['forwarderA', 'forwarderB'],
    packages = [{ id: 'C1', description: `Container ${CONTAINER}` }],
    consignee = 'consignee',
    deadlineInDays = 35,
    consignment = CONSIGNMENT, // what the forwarders price: public on-chain (ADR 0015)
    parent = null, // the main escrow a leg is subcontracted from: legs pay no fee (ADR 0010)
    expect,
  }) {
    const requester = this.party(by);
    const names = invite.map((k) => this.party(k).label).join(', ');
    this.narrator.action(requester.label, `${expect ? 'tries to request' : 'requests'} quotes for ${ref} from ${names}`);
    const job = { packages, consignee, deadline: this.#deadlineIn(deadlineInDays) };
    const args = { invited: invite.map((k) => this.party(k).address), job: this.#jobHashFor(job), consignment, parent };
    const receipt = this.#attempt({ action: 'request', ref, expect }, () => this.chain.call(this.platform, 'new_quote', args, { caller: requester.address }));
    if (!receipt) return null;
    this.quotes.set(receipt.result, ref);
    this.quoteJobs.set(receipt.result, job);
    this.narrator.info(`quote request ${receipt.result} · created by the platform · holds no money`);
    return receipt.result;
  }

  // An invited forwarder (or carrier, for a leg) quotes full terms on its own thread:
  // first, or in answer to the requester's counter (ADR 0015).
  quote(who, quoteId, { terms, validForDays = 2, expect }) {
    const validUntil = this.chain.keyHeight + Math.round(validForDays * KEYBLOCKS_PER_DAY);
    const args = { terms: termsHash(terms), validUntil };
    const verb = `quote ${describeTerms(terms)}, valid ${validForDays} day(s)`;
    return this.#invoke({ who, id: quoteId, entrypoint: 'quote', args, verb, expect });
  }

  // The requester names a target price; the note (e.g. "can you do 30% at Rotterdam?")
  // stays off-chain and only its hash is recorded.
  counter(who, quoteId, { invitee, price, note = null, expect }) {
    const args = { invitee: this.party(invitee).address, price, note: note && hashEvidence(note) };
    const verb = `counter ${this.party(invitee).label} at ${formatGaju(price)}${note ? ` ("${note}")` : ''}`;
    return this.#invoke({ who, id: quoteId, entrypoint: 'counter', args, verb, expect });
  }

  declineQuote(who, quoteId, { reason = null, expect } = {}) {
    const args = { note: reason && hashEvidence(reason) };
    const verb = `decline the request${reason ? `: "${reason}"` : ''}`;
    return this.#invoke({ who, id: quoteId, entrypoint: 'decline', args, verb, expect });
  }

  acceptQuote(who, quoteId, { invitee, terms, expect }) {
    const args = { invitee: this.party(invitee).address, terms: termsHash(terms) };
    const verb = `accept ${this.party(invitee).label}'s quote: ${describeTerms(terms)}`;
    const receipt = this.#invoke({ who, id: quoteId, entrypoint: 'accept', args, verb, expect });
    if (receipt) this.narrator.ok('agreed: the price and payment schedule are now fixed; other offers are closed');
    return receipt;
  }

  withdrawQuote(who, quoteId, opts = {}) {
    return this.#invoke({ who, id: quoteId, entrypoint: 'withdraw', verb: 'withdraw the request for quotes', ...opts });
  }

  expectAgreement(quoteId, invitee, terms) {
    const agreement = this.chain.view(quoteId, 'agreement');
    if (agreement?.counterparty !== this.party(invitee).address || agreement?.terms !== termsHash(terms)) {
      throw new DemoAssertionError(`${this.#refOf(quoteId)}: expected agreement with ${invitee} on ${describeTerms(terms)}`);
    }
    this.narrator.info(`on-chain agreement: ${this.party(invitee).label} · ${describeTerms(terms)}`);
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
    // Fail closed: never scan against a local manifest that differs from the booked one.
    if (manifestHash(this.manifests.get(id)) !== this.chain.contractState(id).manifest) throw new ContractError('MANIFEST_MISMATCH');
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
    if (receipt) session.commit(receipt.txHash);
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
    for (const ledger of this.custody.values()) ledger.rollback(txHash);
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

  // A leg's payer recovers its fee bond once the main shipment ends (ADR 0010).
  settleBond(who, id, { expect } = {}) {
    return this.#invoke({ who, id, entrypoint: 'settle_bond', verb: `settle the fee bond on ${this.#refOf(id)}`, expect });
  }

  // Fund conservation (AGENTS.md contract invariants) + constant total supply.
  checkInvariants() {
    if (this.chain.totalSupply() !== this.#startSupply) throw new DemoAssertionError('total supply changed');
    for (const [id, ref] of this.shipments) {
      const state = this.chain.contractState(id);
      const held = this.chain.balanceOf(id);
      const paid = this.chain.events(id).filter((e) => e.type === 'Paid').reduce((sum, e) => sum + e.amount, 0n);
      // A leg also holds its fee bond until it is settled (ADR 0010).
      const settledBond = state.bondSettled ? state.bond : 0n;
      const unsettledBond = state.bond - settledBond;
      if (TERMINAL.has(state.status) && (held !== unsettledBond || paid !== state.amount + settledBond)) {
        throw new DemoAssertionError(`${ref}: terminal escrow not fully paid out`);
      }
      if (held !== state.amount - state.paidOut + unsettledBond) {
        throw new DemoAssertionError(`${ref}: escrow holds ${held}, expected ${state.amount - state.paidOut + unsettledBond} (funded minus paid, plus any unsettled bond)`);
      }
    }
    for (const [id, ref] of this.quotes) {
      if (this.chain.balanceOf(id) !== 0n) throw new DemoAssertionError(`${ref}: a quote request holds funds`);
    }
    this.narrator.ok('invariants hold: every escrow balanced, quotes hold nothing, total Gaju supply unchanged');
  }

  // ── Internals ─────────────────────────────────────────────────────────

  #invoke({ who, id, entrypoint, args = {}, value = 0n, verb, expect }) {
    const p = this.party(who);
    this.narrator.action(p.label, expect ? `→ tries to ${verb}` : `→ ${verb}`);
    const receipt = this.#attempt({ action: entrypoint, ref: this.#refOf(id), who, expect }, () =>
      this.chain.call(id, entrypoint, args, { caller: p.address, value }),
    );
    if (receipt) {
      this.narrator.ok(`accepted · tx ${short(receipt.txHash)} · pending (in microblock, ≈3 s)`);
      this.#reportPayouts(id, receipt.txHash);
    }
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

  #reportPayouts(id, txHash) {
    for (const e of this.chain.events(id).filter((ev) => ev.txHash === txHash && ev.type === 'Paid')) {
      const to = Object.values(this.parties).find((p) => p.address === e.to)?.label ?? e.to;
      this.narrator.ok(`💰 ${formatGaju(e.amount)} paid to ${to} (${e.reason})`);
    }
  }

  #refOf(id) {
    return this.shipments.get(id) ?? this.quotes.get(id);
  }

  #evidenceFor(event) {
    if (this.feed.hasEvent(event.id)) return hashEvidence(event);
    return this.ingest(this.webhook(event)).evidenceHash;
  }
}
