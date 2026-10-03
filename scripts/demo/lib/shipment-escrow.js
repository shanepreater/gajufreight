// JS model of ShipmentEscrow (docs/hld.md §5). Keep in lockstep with the Sophia
// contract: same entrypoints, same check order (role → status → args), same error codes.
// Differences from the sketch: events are emitted for the indexer (per the
// sophia-contracts skill), and checkpoints are appended in chronological order.
import { ContractError } from './errors.js';
import { jobHash, termsHash } from './quote-request.js';

// No Created state: an escrow is funded as it is created (ADR 0005).
export const Status = Object.freeze({
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
function isAgreed(ctx, { quote, carrier, terms, manifest, consignee, deadline }) {
  const agreement = ctx.query(quote, 'agreement');
  return (
    Boolean(agreement) &&
    agreement.requester === ctx.caller &&
    agreement.counterparty === carrier &&
    agreement.terms === termsHash(terms) &&
    agreement.job === jobHash({ manifest, consignee, deadline })
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

// Splits only what hasn't been paid; paid milestones are final. Rounding dust goes to the shipper.
function settle(ctx, payCarrierPct, reason) {
  const s = ctx.state;
  const left = remaining(s);
  const toCarrier = (left * payCarrierPct) / 100n;
  setStatus(ctx, Status.Resolved);
  pay(ctx, s.carrier, toCarrier, reason);
  pay(ctx, s.shipper, left - toCarrier, reason);
}

// Milestones pay in order: only the next unpaid one, and only at its own location.
// Each pays its cumulative share minus what's already paid, so rounding lands last.
function releaseMilestone(ctx, location) {
  const s = ctx.state;
  const next = s.schedule.find((m) => !m.paid);
  if (!next || next.location !== location) return;
  const reached = s.schedule.filter((m) => m.paid).reduce((sum, m) => sum + m.pct, 0) + next.pct;
  next.paid = true;
  pay(ctx, s.carrier, (s.amount * BigInt(reached)) / 100n - s.paidOut, `milestone: ${location}`);
}

const ShipmentEscrow = {
  name: 'ShipmentEscrow',
  payable: [], // value arrives with init, not through an entrypoint

  // Panel (ADR 0002): `quorum` of the `panel` must vote the same split. After `window`
  // blocks without a quorum, the `fallback` carrier % applies.
  // Created and funded in one call (ADR 0005), only from a quote the platform registered,
  // agreed on exactly these terms for this job. The price and schedule come from the terms.
  init(ctx, args) {
    const { platform, carrier, consignee, attestors, panel, quorum, window, fallback = 50n, manifest, quote, terms, deadline } = args;
    require(ctx.query(platform, 'is_quote', { address: quote }), 'UNKNOWN_QUOTE');
    require(isAgreed(ctx, args), 'NOT_AGREED');
    const amount = terms.price;
    require(typeof amount === 'bigint' && amount > 0n, 'BAD_AMOUNT');
    require(ctx.value === amount, 'WRONG_AMOUNT');
    require(validSchedule(terms.schedule), 'BAD_SCHEDULE');
    require(Number.isInteger(deadline) && deadline > ctx.blockHeight, 'BAD_DEADLINE');
    require(Number.isInteger(window) && window > 0, 'BAD_DEADLINE');
    const maxPanel = ctx.query(platform, 'setting', { key: 'max_panel' });
    require(panel.length <= maxPanel && new Set(panel).size === panel.length, 'BAD_QUORUM');
    require(Number.isInteger(quorum) && quorum >= 1 && quorum <= panel.length, 'BAD_QUORUM');
    require(panel.every((a) => a !== ctx.caller && a !== carrier && a !== consignee), 'CONFLICTED_ARBITER');
    require(isPct(fallback), 'BAD_SPLIT');
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
      attestors: [...attestors],
      amount,
      deadline,
      status: Status.Funded,
      checkpoints: [],
    };
  },

  entrypoints: {
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
      pay(ctx, s.carrier, remaining(s), 'delivery');
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
    },
  },
};

// One escrow definition per network, bound to its canonical Platform: the model of a
// template compiled with PLATFORM_ADDRESS (ADR 0005). A caller-supplied platform is ignored.
export function escrowFor(platform) {
  return { ...ShipmentEscrow, init: (ctx, args) => ShipmentEscrow.init(ctx, { ...args, platform }) };
}
