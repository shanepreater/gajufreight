// JS model of ShipmentEscrow (docs/hld.md §5). Keep in lockstep with the Sophia
// contract: same entrypoints, same check order (role → status → args), same error codes.
// Differences from the sketch: events are emitted for the indexer (per the
// sophia-contracts skill), and checkpoints are appended in chronological order.
import { ContractError } from './errors.js';
import { jobHash, termsHash } from './quote-request.js';
import { MAX_FEE_BPS } from './platform.js';

// No Created state: an escrow is funded as it is created (ADR 0005), then waits Unconfirmed until
// its payee confirms with the bond (ADR 0018).
export const Status = Object.freeze({
  Unconfirmed: 'Unconfirmed',
  Funded: 'Funded',
  InTransit: 'InTransit',
  Disputed: 'Disputed',
  Released: 'Released',
  Refunded: 'Refunded',
  Resolved: 'Resolved',
});

export const TERMINAL = new Set([Status.Released, Status.Refunded, Status.Resolved]);

// Checkpoint kinds (ADR 0003). Delivered is only written by confirm_delivery.
export const Kind = Object.freeze({ Milestone: 'Milestone', ScanIn: 'ScanIn', ScanOut: 'ScanOut', Delivered: 'Delivered' });
const SIGNABLE_KINDS = new Set([Kind.Milestone, Kind.ScanIn, Kind.ScanOut]);


const require = (ok, code) => {
  if (!ok) throw new ContractError(code);
};
const isOpen = (s) => s.status === Status.Funded || s.status === Status.InTransit;
const isAttestor = (s, a) => s.attestors.includes(a);
const isParty = (s, a) => a === s.shipper || a === s.carrier || a === s.consignee;
const isArbiter = (s, a) => s.arbiters.includes(a);
const isPct = (p) => typeof p === 'bigint' && p >= 0n && p <= 100n;

// Each milestone 1..100 %, unique locations, total at most 100 (the rest pays on delivery).
function validSchedule(schedule) {
  const isEntry = (e) => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && e[0] !== '';
  if (!Array.isArray(schedule) || !schedule.every(isEntry)) return false;
  const pcts = schedule.map(([, pct]) => pct);
  const locations = schedule.map(([location]) => location);
  return (
    pcts.every((p) => Number.isInteger(p) && p >= 1 && p <= 100) &&
    pcts.reduce((a, b) => a + b, 0) <= 100 &&
    new Set(locations).size === locations.length
  );
}

// Only an agreed quote, between these parties, on exactly these terms, for this job (ADR 0004).
function isAgreed(ctx, { quote, carrier, terms, manifest, consignee }) {
  const agreement = ctx.query(quote, 'agreement');
  return (
    Boolean(agreement) &&
    agreement.requester === ctx.caller &&
    agreement.counterparty === carrier &&
    agreement.terms === termsHash(terms) &&
    agreement.job === jobHash({ manifest, consignee })
  );
}

function setStatus(ctx, to) {
  const from = ctx.state.status;
  if (from === to) return;
  ctx.state.status = to;
  ctx.emit({ type: 'StatusChanged', from, to });
}

function pay(ctx, to, amount, reason) {
  if (amount === 0n) return;
  ctx.state.paidOut += amount;
  ctx.spend(to, amount);
  ctx.emit({ type: 'Paid', to, amount, reason });
}

function addCheckpoint(ctx, location, kind, evidence) {
  const cp = { location, kind, evidence, timestamp: ctx.timestamp, attestor: ctx.caller };
  ctx.state.checkpoints.push(cp);
  ctx.emit({ type: 'CheckpointAdded', ...cp });
}

const remaining = (s) => s.amount - s.paidOut;

// The platform fee on a price: a percentage with a minimum, never more than 10% of the price,
// a limit fixed in the contract (ADR 0018).
export function feeDue({ feeBps, minFee }, price) {
  const pct = (price * BigInt(feeBps)) / 10_000n;
  const fee = pct > minFee ? pct : minFee;
  const cap = (price * BigInt(MAX_FEE_BPS)) / 10_000n;
  return fee < cap ? fee : cap;
}

// What the payee stakes to confirm: the fee, or bond_bps of the price if larger. A leg's fee
// terms are 0 (Platform.new_quote), so its bond is bond_bps alone.
export function bondFor({ feeBps, minFee, bondBps }, price) {
  const fee = feeDue({ feeBps, minFee }, price);
  const performance = (price * BigInt(bondBps)) / 10_000n;
  return fee > performance ? fee : performance;
}

// The bond moves outside paidOut, which tracks the agreed price.
function payBond(ctx, to, amount, reason) {
  if (amount === 0n) return;
  ctx.state.bondOut += amount;
  ctx.spend(to, amount);
  ctx.emit({ type: 'Paid', to, amount, reason });
}

// The bond above the fee is held until the escrow ends, then split: pct% to the payee, the
// rest (and any rounding) to the payer (ADR 0018).
function releaseHeldBond(ctx, payeePct) {
  const s = ctx.state;
  const held = s.heldBond;
  const toPayee = (held * payeePct) / 100n;
  s.heldBond = 0n;
  payBond(ctx, s.carrier, toPayee, 'bond returned');
  payBond(ctx, s.shipper, held - toPayee, 'bond forfeited');
}

const isTerminal = (s) => TERMINAL.has(s.status);

// Payouts to the payee carry no fee: it was taken from the bond at confirmation.
function payPayee(ctx, gross, reason) {
  ctx.state.toPayee += gross;
  pay(ctx, ctx.state.carrier, gross, reason);
}

// Splits only what hasn't been paid; paid milestones are final. Rounding dust goes to the shipper.
function settle(ctx, payCarrierPct, reason) {
  const s = ctx.state;
  const left = remaining(s);
  const toCarrier = (left * payCarrierPct) / 100n;
  setStatus(ctx, Status.Resolved);
  payPayee(ctx, toCarrier, reason);
  pay(ctx, s.shipper, left - toCarrier, reason);
  releaseHeldBond(ctx, payCarrierPct);
}

// Milestones pay in order: only the next unpaid one, and only at its own location.
// Each pays its cumulative share minus what's already paid, so rounding lands last.
function releaseMilestone(ctx, location) {
  const s = ctx.state;
  const next = s.schedule.find((m) => !m.paid);
  if (!next || next.location !== location) return;
  const reached = s.schedule.filter((m) => m.paid).reduce((sum, m) => sum + m.pct, 0) + next.pct;
  next.paid = true;
  payPayee(ctx, (s.amount * BigInt(reached)) / 100n - s.paidOut, `milestone: ${location}`);
}

const ShipmentEscrow = {
  name: 'ShipmentEscrow',
  payableInit: true, // created and funded in one call (ADR 0005)
  payable: ['confirm'], // the payee's bond (ADR 0018)

  // Panel (ADR 0002): `quorum` of the `panel` must vote the same split. After `window`
  // blocks without a quorum, the `fallback` carrier % applies.
  // Created and funded in one call (ADR 0005), only from a quote the platform registered,
  // agreed on exactly these terms for this job. Every term comes from the agreed terms,
  // never from the booking (ADR 0011): price, schedule, deadline, attestors and panel.
  init(ctx, args) {
    const { platform, carrier, consignee, manifest, quote, terms } = args;
    require(ctx.query(platform, 'is_quote', { address: quote }), 'UNKNOWN_QUOTE');
    require(isAgreed(ctx, args), 'NOT_AGREED');
    const { attestors, panel, quorum, window, deadline } = terms;
    const fallback = Number.isInteger(terms.fallback) ? BigInt(terms.fallback) : null;
    const amount = terms.price;
    require(typeof amount === 'bigint' && amount > 0n, 'BAD_AMOUNT');
    // The fee and bond terms were fixed when the quote was requested (ADR 0018). The payer
    // funds exactly the price; the payee's bond comes with confirm.
    const fees = ctx.query(quote, 'fees');
    const parent = ctx.query(quote, 'parent');
    // In init the attached amount shows in Contract.balance, not Call.value (spike E2b).
    require(ctx.balance() === amount, 'WRONG_AMOUNT');
    require(validSchedule(terms.schedule), 'BAD_SCHEDULE');
    require(Number.isInteger(deadline) && deadline > ctx.blockHeight, 'BAD_DEADLINE');
    require(Number.isInteger(window) && window > 0, 'BAD_DEADLINE');
    const maxPanel = ctx.query(platform, 'setting', { key: 'max_panel' });
    require(panel.length <= maxPanel && new Set(panel).size === panel.length, 'BAD_QUORUM');
    require(Number.isInteger(quorum) && quorum >= 1 && quorum <= panel.length, 'BAD_QUORUM');
    require(panel.every((a) => a !== ctx.caller && a !== carrier && a !== consignee), 'CONFLICTED_ARBITER');
    require(isPct(fallback), 'BAD_SPLIT');
    // Last, once every check has passed: Platform caps the parent's total leg value.
    if (parent !== null) ctx.call(platform, 'add_leg', { parent, price: amount });
    return {
      shipper: ctx.caller,
      carrier,
      consignee,
      arbiters: [...panel],
      quorum,
      window,
      fallback,
      disputedAt: 0,
      votes: {},
      manifest, // hash of the package list, kept off-chain (ADR 0003)
      quote,
      schedule: terms.schedule.map(([location, pct]) => ({ location, pct, paid: false })),
      paidOut: 0n,
      toPayee: 0n,
      fee: feeDue(fees, amount), // 0 on a leg: its quote's fee terms are 0
      bond: bondFor(fees, amount), // what the payee stakes to confirm
      heldBond: 0n, // the bond above the fee, held once confirmed
      bondOut: 0n, // fee and bond paid out so far
      confirmed: false,
      confirmBy: ctx.blockHeight + fees.confirmWindow,
      treasury: fees.treasury,
      parent,
      attestors: [...attestors],
      amount,
      deadline,
      status: Status.Unconfirmed,
      checkpoints: [],
    };
  },

  // Read by Platform (new_quote, add_leg).
  views: {
    payee: (s) => s.carrier,
    is_open: (s) => isOpen(s),
    is_leg: (s) => s.parent !== null,
    is_terminal: (s) => isTerminal(s),
    price: (s) => s.amount,
    paid_to_payee: (s) => s.toPayee,
  },

  entrypoints: {
    // The payee commits to the booking by staking the bond. The fee goes to the treasury now,
    // so it is paid however the shipment ends; the rest is held (ADR 0018).
    confirm(ctx) {
      const s = ctx.state;
      require(ctx.caller === s.carrier, 'ONLY_PAYEE');
      require(s.status === Status.Unconfirmed, 'BAD_STATE');
      require(ctx.blockHeight <= s.confirmBy, 'CONFIRM_EXPIRED');
      require(ctx.value === s.bond, 'WRONG_AMOUNT');
      s.confirmed = true;
      s.heldBond = s.bond - s.fee;
      setStatus(ctx, Status.Funded);
      ctx.emit({ type: 'Confirmed', bond: s.bond, fee: s.fee });
      if (s.fee > 0n) {
        payBond(ctx, s.treasury, s.fee, 'platform fee');
        ctx.emit({ type: 'FeePaid', treasury: s.treasury, amount: s.fee });
      }
    },

    // Before confirmation either side can walk away: the payer gets the whole price back and
    // nobody pays a fee, because the payee never committed (ADR 0018).
    cancel_booking(ctx) {
      const s = ctx.state;
      require(ctx.caller === s.shipper || ctx.caller === s.carrier, 'UNAUTHORIZED');
      require(s.status === Status.Unconfirmed, 'BAD_STATE');
      setStatus(ctx, Status.Refunded);
      ctx.emit({ type: 'Cancelled', by: ctx.caller });
      pay(ctx, s.shipper, remaining(s), 'booking cancelled');
    },

    // One call per location: for scans, the evidence bundle lists every package scanned.
    add_checkpoint(ctx, { location, kind, evidence }) {
      const s = ctx.state;
      require(isAttestor(s, ctx.caller) || ctx.caller === s.carrier, 'UNAUTHORIZED');
      require(isOpen(s), 'BAD_STATE');
      require(SIGNABLE_KINDS.has(kind), 'BAD_KIND');
      addCheckpoint(ctx, location, kind, evidence);
      setStatus(ctx, Status.InTransit);
      // Only an attestor's scan-in fires a milestone: the payee can't pay themselves.
      if (kind === Kind.ScanIn && isAttestor(s, ctx.caller)) releaseMilestone(ctx, location);
    },

    confirm_delivery(ctx, { evidence }) {
      const s = ctx.state;
      require(ctx.caller === s.consignee || isAttestor(s, ctx.caller), 'UNAUTHORIZED');
      require(isOpen(s), 'BAD_STATE');
      addCheckpoint(ctx, 'DELIVERED', Kind.Delivered, evidence);
      setStatus(ctx, Status.Released);
      payPayee(ctx, remaining(s), 'delivery');
      releaseHeldBond(ctx, 100n);
    },

    raise_dispute(ctx) {
      const s = ctx.state;
      require(isParty(s, ctx.caller), 'UNAUTHORIZED');
      require(isOpen(s), 'BAD_STATE');
      s.disputedAt = ctx.blockHeight;
      setStatus(ctx, Status.Disputed);
    },

    // payCarrierPct: 0..100 (bigint). A later vote replaces the arbiter's earlier one;
    // the dispute settles as soon as `quorum` arbiters hold the same split.
    vote(ctx, { payCarrierPct }) {
      const s = ctx.state;
      require(isArbiter(s, ctx.caller), 'ONLY_ARBITER');
      require(s.status === Status.Disputed, 'BAD_STATE');
      require(isPct(payCarrierPct), 'BAD_SPLIT');
      s.votes[ctx.caller] = payCarrierPct;
      ctx.emit({ type: 'Voted', arbiter: ctx.caller, payCarrierPct });
      const matching = Object.values(s.votes).filter((v) => v === payCarrierPct).length;
      if (matching >= s.quorum) settle(ctx, payCarrierPct, 'panel');
    },

    // Deadlocked or absent panel: after the window, anyone involved applies the fallback.
    resolve_by_fallback(ctx) {
      const s = ctx.state;
      require(isParty(s, ctx.caller) || isArbiter(s, ctx.caller), 'UNAUTHORIZED');
      require(s.status === Status.Disputed, 'BAD_STATE');
      require(ctx.blockHeight > s.disputedAt + s.window, 'ARBITRATION_OPEN');
      settle(ctx, s.fallback, 'fallback');
    },

    refund_after_deadline(ctx) {
      const s = ctx.state;
      require(ctx.caller === s.shipper, 'ONLY_SHIPPER');
      require(isOpen(s), 'BAD_STATE');
      require(ctx.blockHeight > s.deadline, 'NOT_EXPIRED');
      setStatus(ctx, Status.Refunded);
      pay(ctx, s.shipper, remaining(s), 'refund');
      releaseHeldBond(ctx, 0n);
    },
  },
};

// One escrow definition per network, bound to its canonical Platform: the model of a
// template compiled with PLATFORM_ADDRESS (ADR 0005). A caller-supplied platform is ignored.
// `code` models that constant: each platform's template has its own bytecode hash.
export function escrowFor(platform) {
  return { ...ShipmentEscrow, code: platform, init: (ctx, args) => ShipmentEscrow.init(ctx, { ...args, platform }) };
}
