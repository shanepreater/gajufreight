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

const require = (ok, code) => {
  if (!ok) throw new ContractError(code);
};
const isOpen = (s) => s.status === Status.Funded || s.status === Status.InTransit;
const isAttestor = (s, a) => s.attestors.includes(a);
const isParty = (s, a) => a === s.shipper || a === s.carrier || a === s.consignee;

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

function addCheckpoint(ctx, location, evidence) {
  const cp = { location, evidence, timestamp: ctx.timestamp, attestor: ctx.caller };
  ctx.state.checkpoints.push(cp);
  ctx.emit({ type: 'CheckpointAdded', ...cp });
}

export const ShipmentEscrow = {
  name: 'ShipmentEscrow',
  payable: ['fund'],

  init(ctx, { carrier, consignee, arbiter, attestors, amount, deadline }) {
    require(typeof amount === 'bigint' && amount > 0n, 'BAD_AMOUNT');
    require(Number.isInteger(deadline) && deadline > ctx.blockHeight, 'BAD_DEADLINE');
    return {
      shipper: ctx.caller,
      carrier,
      consignee,
      arbiter,
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

    add_checkpoint(ctx, { location, evidence }) {
      const s = ctx.state;
      require(isAttestor(s, ctx.caller) || ctx.caller === s.carrier, 'UNAUTHORIZED');
      require(isOpen(s), 'BAD_STATE');
      addCheckpoint(ctx, location, evidence);
      setStatus(ctx, Status.InTransit);
    },

    confirm_delivery(ctx, { evidence }) {
      const s = ctx.state;
      require(ctx.caller === s.consignee || isAttestor(s, ctx.caller), 'UNAUTHORIZED');
      require(isOpen(s), 'BAD_STATE');
      addCheckpoint(ctx, 'DELIVERED', evidence);
      setStatus(ctx, Status.Released);
      pay(ctx, s.carrier, s.amount, 'delivery');
    },

    raise_dispute(ctx) {
      const s = ctx.state;
      require(isParty(s, ctx.caller), 'UNAUTHORIZED');
      require(isOpen(s), 'BAD_STATE');
      setStatus(ctx, Status.Disputed);
    },

    // payCarrierPct: 0..100 (bigint); remainder, including rounding dust, goes to the shipper.
    resolve(ctx, { payCarrierPct }) {
      const s = ctx.state;
      require(ctx.caller === s.arbiter, 'ONLY_ARBITER');
      require(s.status === Status.Disputed, 'BAD_STATE');
      require(typeof payCarrierPct === 'bigint' && payCarrierPct >= 0n && payCarrierPct <= 100n, 'BAD_SPLIT');
      const toCarrier = (s.amount * payCarrierPct) / 100n;
      setStatus(ctx, Status.Resolved);
      pay(ctx, s.carrier, toCarrier, 'resolution');
      pay(ctx, s.shipper, s.amount - toCarrier, 'resolution');
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
