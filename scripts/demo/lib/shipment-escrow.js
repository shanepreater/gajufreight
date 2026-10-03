// JS model of ShipmentEscrow (docs/hld.md §5). Keep in lockstep with the Sophia
// contract: same entrypoints, same check order (role → status → args), same error codes.
// Differences from the sketch: events are emitted for the indexer (per the
// sophia-contracts skill), and checkpoints are appended in chronological order.
import { ContractError } from './errors.js';

export const Status = Object.freeze({
  Created: 'Created',
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

function setStatus(ctx, to) {
  const from = ctx.state.status;
  if (from === to) return;
  ctx.state.status = to;
  ctx.emit({ type: 'StatusChanged', from, to });
}

function pay(ctx, to, amount, reason) {
  if (amount === 0n) return;
  ctx.spend(to, amount);
  ctx.emit({ type: 'Paid', to, amount, reason });
}

function addCheckpoint(ctx, location, kind, evidence) {
  const cp = { location, kind, evidence, timestamp: ctx.timestamp, attestor: ctx.caller };
  ctx.state.checkpoints.push(cp);
  ctx.emit({ type: 'CheckpointAdded', ...cp });
}

// Splits the escrow; the remainder, including rounding dust, goes to the shipper.
function settle(ctx, payCarrierPct, reason) {
  const s = ctx.state;
  const toCarrier = (s.amount * payCarrierPct) / 100n;
  setStatus(ctx, Status.Resolved);
  pay(ctx, s.carrier, toCarrier, reason);
  pay(ctx, s.shipper, s.amount - toCarrier, reason);
}

export const ShipmentEscrow = {
  name: 'ShipmentEscrow',
  payable: ['fund'],

  // Panel (ADR 0002): `quorum` of the `panel` must vote the same split. After `window`
  // blocks without a quorum, the `fallback` carrier % applies.
  init(ctx, { carrier, consignee, attestors, panel, quorum, window, fallback = 50n, manifest, amount, deadline }) {
    require(typeof amount === 'bigint' && amount > 0n, 'BAD_AMOUNT');
    require(Number.isInteger(deadline) && deadline > ctx.blockHeight, 'BAD_DEADLINE');
    require(Number.isInteger(window) && window > 0, 'BAD_DEADLINE');
    require(new Set(panel).size === panel.length, 'BAD_QUORUM');
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
      attestors: [...attestors],
      amount,
      deadline,
      status: Status.Created,
      checkpoints: [],
    };
  },

  entrypoints: {
    fund(ctx) {
      const s = ctx.state;
      require(ctx.caller === s.shipper, 'ONLY_SHIPPER');
      require(s.status === Status.Created, 'BAD_STATE');
      require(ctx.value === s.amount, 'WRONG_AMOUNT');
      setStatus(ctx, Status.Funded);
    },

    // One call per location: for scans, the evidence bundle lists every package scanned.
    add_checkpoint(ctx, { location, kind, evidence }) {
      const s = ctx.state;
      require(isAttestor(s, ctx.caller) || ctx.caller === s.carrier, 'UNAUTHORIZED');
      require(isOpen(s), 'BAD_STATE');
      require(SIGNABLE_KINDS.has(kind), 'BAD_KIND');
      addCheckpoint(ctx, location, kind, evidence);
      setStatus(ctx, Status.InTransit);
    },

    confirm_delivery(ctx, { evidence }) {
      const s = ctx.state;
      require(ctx.caller === s.consignee || isAttestor(s, ctx.caller), 'UNAUTHORIZED');
      require(isOpen(s), 'BAD_STATE');
      addCheckpoint(ctx, 'DELIVERED', Kind.Delivered, evidence);
      setStatus(ctx, Status.Released);
      pay(ctx, s.carrier, s.amount, 'delivery');
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
      pay(ctx, s.shipper, s.amount, 'refund');
    },
  },
};
