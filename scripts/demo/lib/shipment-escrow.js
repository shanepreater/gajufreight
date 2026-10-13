// JS model of ShipmentEscrow (docs/hld.md §5). Keep in lockstep with the Sophia
// contract: same entrypoints, same check order (role → status → args), same error codes.
// Differences from the sketch: events are emitted for the indexer (per the
// sophia-contracts skill), and checkpoints are appended in chronological order.
import { ContractError } from './errors.js';
import { QuoteRequest, jobHash } from './quote-request.js';
import { MAX_FEE_BPS } from './platform.js';

// No Created state: an escrow is funded as it is created (ADR 0005), then waits Unconfirmed until
// its payee confirms with the bond (ADR 0018).
export const Status = Object.freeze({
  Unconfirmed: 'Unconfirmed',
  Funded: 'Funded',
  InTransit: 'InTransit',
  Delivered: 'Delivered', // an attestor delivered without the consignee's code: held for the challenge window (ADR 0006)
  DisputeFlagged: 'DisputeFlagged', // an attestor flagged it for the consignee; awaiting the shipper's deposit (ADR 0022)
  Disputed: 'Disputed',
  Released: 'Released',
  Refunded: 'Refunded',
  Resolved: 'Resolved',
});

export const TERMINAL = new Set([Status.Released, Status.Refunded, Status.Resolved]);

// Checkpoint kinds (ADR 0003). Delivered is only written by confirm_delivery.
export const Kind = Object.freeze({ Milestone: 'Milestone', ScanIn: 'ScanIn', ScanOut: 'ScanOut', Delivered: 'Delivered' });
const SIGNABLE_KINDS = new Set([Kind.Milestone, Kind.ScanIn, Kind.ScanOut]);

// Extra charges after booking (ADR 0020): bounded per escrow so the record can't grow without
// limit, and paid straight through, never held.
export const MAX_CHARGES = 20;
export const CHARGE_KINDS = Object.freeze(['Demurrage', 'Detention', 'Waiting', 'Redelivery', 'Duty', 'Other']);

// A milestone labelled with a colon (CUSTOMS:NLRTM, ONBOARD:CNYTN) is an attested event, paid by
// an attestor's milestone checkpoint; any other label is a place, paid by an attestor's scan-in.
const isEventLabel = (location) => location.includes(':');
const paysMilestone = (kind, location) =>
  isEventLabel(location) ? kind === Kind.Milestone : kind === Kind.ScanIn;


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

// The bond above the fee, held from confirmation until the escrow ends (ADR 0018). Read it
// before the status changes; nothing runs after a terminal status, so it can't pay twice.
const heldBond = (s) => (s.status === Status.Unconfirmed ? 0n : s.bond - s.fee);

// When the escrow ends, the held bond splits like the outcome: pct% to the payee, the rest
// (and any rounding) to the payer.
function releaseHeldBond(ctx, held, payeePct) {
  const s = ctx.state;
  const toPayee = (held * payeePct) / 100n;
  if (held > 0n) ctx.emit({ type: 'BondReleased', toPayee, toPayer: held - toPayee });
  payBond(ctx, s.carrier, toPayee, 'bond returned');
  payBond(ctx, s.shipper, held - toPayee, 'bond forfeited');
}

const isTerminal = (s) => TERMINAL.has(s.status);

// Payouts to the payee carry no fee: it was taken from the bond at confirmation.
function payPayee(ctx, gross, reason) {
  ctx.state.toPayee += gross;
  pay(ctx, ctx.state.carrier, gross, reason);
}

// The arbiter fee on the unpaid remainder (ADR 0022): a percentage with a minimum, never more
// than the remainder. The raiser's deposit is the same amount.
export function arbiterFee({ arbiterFeeBps, minArbiterFee }, left) {
  const pct = (left * BigInt(arbiterFeeBps)) / 10_000n;
  const fee = pct > minArbiterFee ? pct : minArbiterFee;
  return fee < left ? fee : left;
}

function startDispute(ctx, raiser, deposit) {
  const s = ctx.state;
  s.deposit = deposit;
  s.raiser = raiser;
  s.disputedAt = ctx.blockHeight;
  setStatus(ctx, Status.Disputed);
  ctx.emit({ type: 'DisputeRaised', raiser, deposit });
}

// The deposit moves outside paidOut, like the bond.
function payDeposit(ctx, to, type) {
  const s = ctx.state;
  if (s.deposit === 0n) return;
  s.depositOut += s.deposit;
  ctx.spend(to, s.deposit);
  ctx.emit({ type, to, amount: s.deposit });
}

// Splits only what hasn't been paid; paid milestones are final. Voting arbiters share the fee
// whichever way they ruled; it comes off the remainder before the split, with rounding left in
// the split. The deposit goes back to a raiser who won at least half, otherwise to the other
// side, never to the arbiters (ADR 0022).
function settle(ctx, payCarrierPct, reason) {
  const s = ctx.state;
  const voters = Object.keys(s.votes);
  const share = voters.length === 0 ? 0n : s.deposit / BigInt(voters.length);
  const pool = remaining(s) - share * BigInt(voters.length);
  const toCarrier = (pool * payCarrierPct) / 100n;
  const held = heldBond(s);
  setStatus(ctx, Status.Resolved);
  for (const arbiter of voters) {
    pay(ctx, arbiter, share, 'arbiter fee');
    if (share > 0n) ctx.emit({ type: 'ArbiterPaid', arbiter, amount: share });
  }
  payPayee(ctx, toCarrier, reason);
  pay(ctx, s.shipper, pool - toCarrier, reason);
  const raiserWon = s.raiser === s.carrier ? payCarrierPct >= 50n : 100n - payCarrierPct >= 50n;
  const otherSide = s.raiser === s.carrier ? s.shipper : s.carrier;
  payDeposit(ctx, raiserWon ? s.raiser : otherSide, raiserWon ? 'DepositReturned' : 'DepositForfeited');
  releaseHeldBond(ctx, held, payCarrierPct);
}

// Pays the payee the unpaid remainder and returns its held bond (delivery, or a lapsed window).
function releaseRemainder(ctx) {
  const held = heldBond(ctx.state);
  setStatus(ctx, Status.Released);
  payPayee(ctx, remaining(ctx.state), 'delivery');
  releaseHeldBond(ctx, held, 100n);
}

// Returns the unpaid remainder to the payer, with the held bond as compensation. An unconfirmed
// booking holds no bond, so a cancellation returns only the price (ADR 0018).
function refundRemainder(ctx, reason) {
  const held = heldBond(ctx.state);
  setStatus(ctx, Status.Refunded);
  pay(ctx, ctx.state.shipper, remaining(ctx.state), reason);
  releaseHeldBond(ctx, held, 0n);
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

// The platform is the caller, so the payer comes as `shipper`, and the platform's limits come
// as arguments: calling back into it during its own call would be re-entrant. Every term comes
// from the agreed quote, never from the booking (ADR 0011). Panel (ADR 0002): `quorum` of the
// `panel` must vote the same split; after `window` blocks without one, `fallback` applies.
function initBooking(ctx, { shipper, quote, manifest, consignee = null, maxPanel, maxAttestors, maxPrice }) {
  const agreement = ctx.query(quote, 'agreement');
  require(agreement !== null, 'NOT_AGREED');
  // Agreed by this payer, for this shipment: a quote can't be reused for another one.
  require(agreement.requester === shipper && agreement.job === jobHash({ manifest, consignee }), 'NOT_AGREED');
  const payee = agreement.counterparty;
  const t = agreement.terms;
  const { attestors, panel, quorum, window, deadline, challenge } = t;
  const amount = t.price;
  require(typeof amount === 'bigint' && amount > 0n, 'BAD_AMOUNT');
  require(maxPrice === 0n || amount <= maxPrice, 'OVER_LIMIT'); // pilot cap (ADR 0011)
  require(validSchedule(t.schedule), 'BAD_SCHEDULE');
  require(deadline > ctx.blockHeight && window > 0 && challenge > 0, 'BAD_DEADLINE');
  require(panel.length <= maxPanel && new Set(panel).size === panel.length && quorum >= 1 && quorum <= panel.length, 'BAD_QUORUM');
  require(panel.every((a) => a !== shipper && a !== payee && a !== consignee), 'CONFLICTED_ARBITER');
  require(attestors.length <= maxAttestors, 'BAD_ATTESTORS');
  require(!attestors.includes(payee), 'CONFLICTED_ATTESTOR'); // no payee pays itself (ADR 0006)
  const fallback = BigInt(t.fallback);
  require(isPct(fallback), 'BAD_SPLIT');
  // A payout to a non-payable contract fails and burns the gas (spike E6b); voting arbiters
  // are paid at settlement, so a non-payable one would block it (ADR 0022).
  require(ctx.isPayable(shipper) && ctx.isPayable(payee), 'NOT_PAYABLE_PARTY');
  require(panel.every((a) => ctx.isPayable(a)), 'NOT_PAYABLE_PARTY');
  // The fee and bond terms were fixed when the quote was requested (ADR 0018).
  const fees = ctx.query(quote, 'fees');
  require(ctx.isPayable(fees.treasury), 'BAD_TREASURY');
  // The payer funds exactly the price; the payee's bond comes with confirm. In init the
  // attached amount shows in Contract.balance, not Call.value (spike E2b).
  require(ctx.balance() === amount, 'WRONG_AMOUNT');
  const parent = ctx.query(quote, 'parent');
  ctx.emit({ type: 'Booked', quote, payee, job: agreement.job });
  return {
    shipper,
    carrier: payee,
    consignee,
    arbiters: [...panel],
    quorum,
    window,
    fallback,
    disputedAt: 0,
    challenge, // blocks to dispute a delivery made without a code (ADR 0006)
    deliveredAt: 0,
    maxAttestors, // the platform limit at booking, for add_attestor
    removals: {}, // attestor -> who approved removing it first
    votes: {},
    manifest, // hash of the package list, kept off-chain (ADR 0003)
    quote,
    schedule: t.schedule.map(([location, pct]) => ({ location, pct, paid: false })),
    paidOut: 0n,
    toPayee: 0n,
    fee: feeDue(fees, amount), // 0 on a leg: its quote's fee terms are 0
    bond: bondFor(fees, amount), // what the payee stakes to confirm
    bondOut: 0n, // fee and bond paid out so far
    confirmed: false, // the payee confirmed; a cancelled booking never was
    arbiterFeeBps: fees.arbiterFeeBps, // fixed when the quote was requested (ADR 0022)
    minArbiterFee: fees.minArbiterFee,
    depositWindow: fees.depositWindow,
    deposit: 0n, // the raiser's deposit, equal to the arbiter fee
    depositOut: 0n,
    raiser: shipper, // who staked the deposit (the shipper until a dispute)
    prior: null, // the status a flagged dispute returns to if it lapses
    flaggedAt: 0,
    charges: [], // extra charges by id (ADR 0020)
    confirmBy: ctx.blockHeight + fees.confirmWindow,
    treasury: fees.treasury,
    parent,
    attestors: [...new Set(attestors)], // a map in the contract: duplicates collapse
    amount,
    deadline,
    status: Status.Unconfirmed,
    checkpoints: [],
  };
}

// Unfunded, terminal and empty, so every entrypoint rejects it. Nothing comes from the
// arguments: a look-alike can't name a real party, so every address is its deployer's.
function initTemplate(ctx) {
  const deployer = ctx.caller;
  require(ctx.balance() === 0n, 'WRONG_AMOUNT');
  return {
    shipper: deployer, carrier: deployer, consignee: null, arbiters: [], quorum: 0, window: 0, fallback: 0n,
    disputedAt: 0, challenge: 0, deliveredAt: 0, maxAttestors: 0, removals: {}, votes: {},
    manifest: '0'.repeat(64), quote: null, schedule: [], paidOut: 0n, toPayee: 0n, fee: 0n, bond: 0n,
    bondOut: 0n, confirmed: false, arbiterFeeBps: 0, minArbiterFee: 0n, depositWindow: 0, deposit: 0n,
    depositOut: 0n, raiser: deployer, prior: Status.Refunded, flaggedAt: 0, charges: [], confirmBy: 0,
    treasury: deployer, parent: null, attestors: [], amount: 0n, deadline: 0, status: Status.Refunded,
    checkpoints: [],
  };
}

const ShipmentEscrow = {
  name: 'ShipmentEscrow',
  payableInit: true, // created and funded in one call (ADR 0005)
  payableContract: true, // `payable contract`: it receives spends, so it can be a payee
  // The payee's bond (ADR 0018); an extra charge (ADR 0020); a dispute deposit (ADR 0022).
  payable: ['confirm', 'accept_charge', 'raise_dispute'],

  // Cloned and funded by Platform.book in one call (ADR 0005, 0011). Anyone else creating it
  // gets an inert template: that is how the template is deployed (decision log #34).
  init(ctx, args) {
    return ctx.caller === args.platform ? initBooking(ctx, args) : initTemplate(ctx);
  },

  // Read by Platform (new_quote, book, release_leg).
  views: {
    payee: (s) => s.carrier,
    is_open: (s) => isOpen(s),
    is_leg: (s) => s.parent !== null,
    is_terminal: (s) => isTerminal(s),
    price: (s) => s.amount,
    paid_to_payee: (s) => s.toPayee,
    get_status: (s) => s.status,
    deposit_due: (s) => arbiterFee(s, remaining(s)), // what raising a dispute costs now (ADR 0022)
    charge: (s, { id }) => s.charges[id] ?? null, // ADR 0020
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
      ctx.emit({ type: 'Cancelled', by: ctx.caller });
      refundRemainder(ctx, 'booking cancelled');
    },

    // The payee proposes a charge after booking, with evidence; allowed once confirmed, even
    // after the escrow ends, because port storage is often billed after delivery (ADR 0020).
    propose_charge(ctx, { kind, amount, evidence }) {
      const s = ctx.state;
      require(ctx.caller === s.carrier, 'ONLY_PAYEE');
      require(s.confirmed, 'BAD_STATE');
      require(CHARGE_KINDS.includes(kind), 'BAD_KIND');
      require(typeof amount === 'bigint' && amount > 0n, 'BAD_AMOUNT');
      require(s.charges.length < MAX_CHARGES, 'TOO_MANY_CHARGES');
      const id = s.charges.length;
      s.charges.push({ kind, amount, evidence, status: 'Proposed' });
      ctx.emit({ type: 'ChargeProposed', id, kind, amount });
      return id;
    },

    // The payer accepts and pays the charge in one call; it passes straight to the payee, with
    // no platform fee, so the escrow's own funds are untouched.
    accept_charge(ctx, { id }) {
      const s = ctx.state;
      require(ctx.caller === s.shipper, 'ONLY_SHIPPER');
      const c = s.charges[id];
      require(c !== undefined, 'NO_CHARGE');
      require(c.status === 'Proposed', 'CHARGE_CLOSED');
      require(ctx.value === c.amount, 'WRONG_AMOUNT');
      c.status = 'Accepted';
      ctx.emit({ type: 'ChargeAccepted', id, amount: c.amount });
      ctx.spend(s.carrier, c.amount);
    },

    // A declined charge stays on record and is settled off-chain (ADR 0020).
    decline_charge(ctx, { id }) {
      const s = ctx.state;
      require(ctx.caller === s.shipper, 'ONLY_SHIPPER');
      const c = s.charges[id];
      require(c !== undefined, 'NO_CHARGE');
      require(c.status === 'Proposed', 'CHARGE_CLOSED');
      c.status = 'Declined';
      ctx.emit({ type: 'ChargeDeclined', id });
    },

    // One call per location: for scans, the evidence bundle lists every package scanned.
    add_checkpoint(ctx, { location, kind, evidence }) {
      const s = ctx.state;
      require(isAttestor(s, ctx.caller) || ctx.caller === s.carrier, 'UNAUTHORIZED');
      require(isOpen(s), 'BAD_STATE');
      require(SIGNABLE_KINDS.has(kind), 'BAD_KIND');
      addCheckpoint(ctx, location, kind, evidence);
      setStatus(ctx, Status.InTransit);
      // Only an attestor fires a milestone (the payee can't pay itself): a scan-in for a place,
      // a milestone checkpoint for an event label (ADR 0020).
      if (isAttestor(s, ctx.caller) && paysMilestone(kind, location)) releaseMilestone(ctx, location);
    },

    // The consignee, or an attestor whose delivery code matched with every package delivered,
    // releases at once. Any other attestor delivery holds the remainder for the challenge window,
    // so the shipper, or an attestor's flag for the consignee, can dispute it (ADR 0006, 0022).
    confirm_delivery(ctx, { evidence, codeChecked = false }) {
      const s = ctx.state;
      const byConsignee = s.consignee !== null && ctx.caller === s.consignee;
      require(byConsignee || isAttestor(s, ctx.caller), 'UNAUTHORIZED');
      require(isOpen(s), 'BAD_STATE');
      addCheckpoint(ctx, 'DELIVERED', Kind.Delivered, evidence);
      if (byConsignee || codeChecked) {
        releaseRemainder(ctx);
      } else {
        s.deliveredAt = ctx.blockHeight;
        setStatus(ctx, Status.Delivered);
      }
    },

    // After an unchallenged window, anyone can release the held remainder: it can't freeze.
    release_after_window(ctx) {
      const s = ctx.state;
      require(s.status === Status.Delivered, 'BAD_STATE');
      require(ctx.blockHeight > s.deliveredAt + s.challenge, 'CHALLENGE_OPEN');
      releaseRemainder(ctx);
    },

    // The payer or payee raises a dispute, staking a deposit equal to the arbiter fee; a flagged
    // dispute can be raised by either within the deposit window. The consignee never pays or
    // signs: its problem comes through the final-mile agent's flag (ADR 0022).
    raise_dispute(ctx) {
      const s = ctx.state;
      require(ctx.caller === s.shipper || ctx.caller === s.carrier, 'UNAUTHORIZED');
      const flagged = s.status === Status.DisputeFlagged;
      const at = flagged ? s.prior : s.status; // where the goods are
      require(isOpen(s) || s.status === Status.Delivered || flagged, 'BAD_STATE');
      // Once a delivery is held, only the payer can dispute it (ADR 0006).
      require(at !== Status.Delivered || ctx.caller !== s.carrier, 'UNAUTHORIZED');
      require(!flagged || ctx.blockHeight <= s.flaggedAt + s.depositWindow, 'DEPOSIT_EXPIRED');
      require(remaining(s) > 0n, 'NOTHING_DISPUTED');
      const deposit = arbiterFee(s, remaining(s));
      require(ctx.value === deposit, 'WRONG_AMOUNT');
      startDispute(ctx, ctx.caller, deposit);
    },

    // An attestor (the final-mile agent) flags a consignee's problem; nothing moves until the
    // shipper (or the forwarder) raises it with the deposit, or the flag lapses (ADR 0022).
    flag_dispute(ctx, { evidence }) {
      const s = ctx.state;
      require(isAttestor(s, ctx.caller), 'UNAUTHORIZED');
      require(isOpen(s) || s.status === Status.Delivered, 'BAD_STATE');
      require(s.flaggedAt === 0, 'ALREADY_FLAGGED'); // once only, so flags can't freeze funds
      require(remaining(s) > 0n, 'NOTHING_DISPUTED');
      s.prior = s.status;
      s.flaggedAt = ctx.blockHeight;
      setStatus(ctx, Status.DisputeFlagged);
      ctx.emit({ type: 'Flagged', attestor: ctx.caller, evidence });
    },

    // An unfunded flag lapses and the shipment carries on where it was; a held delivery's
    // challenge clock is not reset.
    lapse_dispute(ctx) {
      const s = ctx.state;
      require(s.status === Status.DisputeFlagged, 'BAD_STATE');
      require(ctx.blockHeight > s.flaggedAt + s.depositWindow, 'DEPOSIT_WINDOW_OPEN');
      setStatus(ctx, s.prior);
      ctx.emit({ type: 'DisputeLapsed' });
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
      refundRemainder(ctx, 'refund');
    },

    // The payee gives up its claim to the unpaid remainder (ADR 0011): it can only give away
    // its own money, so it needs no one else's consent.
    release_to_payer(ctx) {
      const s = ctx.state;
      require(ctx.caller === s.carrier, 'ONLY_PAYEE');
      require(isOpen(s) || s.status === Status.Delivered, 'BAD_STATE');
      refundRemainder(ctx, 'released to payer');
    },

    // Adding an attestor can only release the payer's own money, so the payer alone can do it;
    // never the payee (ADR 0006).
    add_attestor(ctx, { attestor }) {
      const s = ctx.state;
      require(ctx.caller === s.shipper, 'ONLY_SHIPPER');
      require(isOpen(s), 'BAD_STATE');
      require(attestor !== s.carrier, 'CONFLICTED_ATTESTOR');
      require(!isAttestor(s, attestor) && s.attestors.length < s.maxAttestors, 'BAD_ATTESTORS');
      s.attestors.push(attestor);
      ctx.emit({ type: 'AttestorAdded', attestor });
    },

    // Removal needs both payer and payee, in either order (ADR 0006, decision log #3).
    remove_attestor(ctx, { attestor }) {
      const s = ctx.state;
      require(ctx.caller === s.shipper || ctx.caller === s.carrier, 'UNAUTHORIZED');
      require(isOpen(s), 'BAD_STATE');
      require(isAttestor(s, attestor), 'NOT_ATTESTOR');
      const first = s.removals[attestor];
      if (first === undefined) {
        s.removals[attestor] = ctx.caller;
        ctx.emit({ type: 'AttestorRemovalApproved', attestor, by: ctx.caller });
        return;
      }
      require(first !== ctx.caller, 'ALREADY_APPROVED');
      s.attestors = s.attestors.filter((a) => a !== attestor);
      delete s.removals[attestor];
      ctx.emit({ type: 'AttestorRemoved', attestor });
    },
  },
};

// One escrow definition per network, bound to its canonical Platform: the model of a
// template compiled with PLATFORM_ADDRESS (ADR 0005). A caller-supplied platform is ignored.
export function escrowFor(platform) {
  return { ...ShipmentEscrow, init: (ctx, args) => ShipmentEscrow.init(ctx, { ...args, platform }) };
}

// Deploys a platform's templates and has its admins vote them in (ADR 0011 order). Each is
// created by `deployer` with no value: the escrow template becomes inert, and the quote
// template is a valid request nobody is invited to, never registered with the platform.
export function installTemplates(chain, platform, deployer, vote) {
  const { result: escrow } = chain.deploy(escrowFor(platform), deployer, {});
  const dispute = { panel: [deployer + '_arbiter'], quorum: 1, window: 1, fallback: 50, challenge: 1 };
  const consignment = { units: [{ count: 1, lengthMm: 1, widthMm: 1, heightMm: 1, weightG: 1 }], origin: 'ZZZZZ', destination: 'ZZZZZ', incoterm: 'EXW', deliverBy: null };
  const { result: quote } = chain.deploy(QuoteRequest, deployer, { requester: deployer, invited: [deployer + '_invitee'], job: '0'.repeat(64), consignment, dispute, maxRounds: 1, parent: null, fees: null });
  vote({ type: 'SetEscrowTemplate', template: escrow });
  vote({ type: 'SetQuoteTemplate', template: quote });
  return { escrow, quote };
}
