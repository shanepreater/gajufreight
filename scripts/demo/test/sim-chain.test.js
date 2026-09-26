import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimChain, FINALITY_KEYBLOCKS } from '../lib/sim-chain.js';
import { ContractError } from '../lib/errors.js';

// Minimal contract used only to exercise the chain mechanics.
const Counter = {
  name: 'Counter',
  payable: ['deposit'],
  init: () => ({ n: 0 }),
  entrypoints: {
    inc(ctx) {
      ctx.state.n += 1;
      ctx.emit({ type: 'Inc' });
    },
    deposit() {},
    incThenFail(ctx) {
      ctx.state.n += 1;
      ctx.emit({ type: 'Inc' });
      throw new ContractError('BOOM');
    },
    payOut(ctx, { to, amount }) {
      ctx.spend(to, amount);
    },
  },
};

function setup() {
  const chain = new SimChain();
  const alice = chain.createAccount('alice', 100n);
  const bob = chain.createAccount('bob', 0n);
  const { result: id } = chain.deploy(Counter, alice, {});
  return { chain, alice, bob, id };
}

test('successful call updates state and emits event', () => {
  const { chain, alice, id } = setup();
  chain.call(id, 'inc', {}, { caller: alice });
  assert.equal(chain.contractState(id).n, 1);
  assert.equal(chain.events(id).length, 1);
});

test('failed call reverts state, events and balances atomically', () => {
  const { chain, alice, id } = setup();
  assert.throws(() => chain.call(id, 'incThenFail', {}, { caller: alice, value: 0n }), { code: 'BOOM' });
  assert.equal(chain.contractState(id).n, 0);
  assert.equal(chain.events(id).length, 0);
  assert.equal(chain.balanceOf(alice), 100n);
});

test('value sent to a non-payable entrypoint is rejected and refunded', () => {
  const { chain, alice, id } = setup();
  assert.throws(() => chain.call(id, 'inc', {}, { caller: alice, value: 5n }), { code: 'NOT_PAYABLE' });
  assert.equal(chain.balanceOf(alice), 100n);
  assert.equal(chain.balanceOf(id), 0n);
});

test('payable entrypoint moves value into the contract', () => {
  const { chain, alice, id } = setup();
  chain.call(id, 'deposit', {}, { caller: alice, value: 40n });
  assert.equal(chain.balanceOf(alice), 60n);
  assert.equal(chain.balanceOf(id), 40n);
});

test('overspending caller is rejected with INSUFFICIENT_BALANCE', () => {
  const { chain, alice, id } = setup();
  assert.throws(() => chain.call(id, 'deposit', {}, { caller: alice, value: 101n }), { code: 'INSUFFICIENT_BALANCE' });
  assert.equal(chain.balanceOf(alice), 100n);
});

test('contract cannot spend more than it holds', () => {
  const { chain, alice, bob, id } = setup();
  chain.call(id, 'deposit', {}, { caller: alice, value: 10n });
  assert.throws(() => chain.call(id, 'payOut', { to: bob, amount: 11n }, { caller: alice }), { code: 'INSUFFICIENT_BALANCE' });
  assert.equal(chain.balanceOf(id), 10n);
});

test('unknown contract, entrypoint and account are rejected', () => {
  const { chain, alice, id } = setup();
  assert.throws(() => chain.call('ct_nope', 'inc', {}, { caller: alice }), { code: 'UNKNOWN_CONTRACT' });
  assert.throws(() => chain.call(id, 'nope', {}, { caller: alice }), { code: 'UNKNOWN_ENTRYPOINT' });
  assert.throws(() => chain.call(id, 'inc', {}, { caller: 'ak_ghost' }), { code: 'UNKNOWN_ACCOUNT' });
});

test('receipt is pending until exactly FINALITY_KEYBLOCKS keyblocks pass', () => {
  const { chain, alice, id } = setup();
  const { txHash } = chain.call(id, 'inc', {}, { caller: alice });
  assert.equal(chain.receiptStatus(txHash), 'pending');
  chain.advanceKeyblocks(FINALITY_KEYBLOCKS - 1);
  assert.equal(chain.receiptStatus(txHash), 'pending');
  chain.advanceKeyblocks(1);
  assert.equal(chain.receiptStatus(txHash), 'final');
});

test('dropping the last microblock undoes its effects and marks it dropped', () => {
  const { chain, alice, id } = setup();
  const { txHash } = chain.call(id, 'inc', {}, { caller: alice });
  assert.equal(chain.dropLastMicroblock(), txHash);
  assert.equal(chain.receiptStatus(txHash), 'dropped');
  assert.equal(chain.contractState(id).n, 0);
  assert.equal(chain.events(id).length, 0);
});

test('a final microblock cannot be dropped', () => {
  const { chain, alice, id } = setup();
  chain.call(id, 'inc', {}, { caller: alice });
  chain.advanceKeyblocks(FINALITY_KEYBLOCKS);
  assert.throws(() => chain.dropLastMicroblock(), /final/);
});

test('total supply is constant across transfers and reverts', () => {
  const { chain, alice, bob, id } = setup();
  const supply = chain.totalSupply();
  chain.call(id, 'deposit', {}, { caller: alice, value: 30n });
  chain.call(id, 'payOut', { to: bob, amount: 30n }, { caller: alice });
  assert.throws(() => chain.call(id, 'deposit', {}, { caller: bob, value: 31n }));
  assert.equal(chain.totalSupply(), supply);
});

test('advanceKeyblocks rejects negative and fractional counts', () => {
  const chain = new SimChain();
  assert.throws(() => chain.advanceKeyblocks(-1));
  assert.throws(() => chain.advanceKeyblocks(1.5));
});
