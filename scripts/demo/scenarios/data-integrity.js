import { Status } from '../lib/shipment-escrow.js';
import { gaju, routeEvents, podEvent } from '../lib/fixtures.js';

const REF = 'GF-2026-0006';
const AMOUNT = gaju(1_000);

export default {
  id: 'data-integrity',
  title: 'Data integrity: tampering, duplicates and chain forks',
  summary: 'Forged webhooks and edited documents are detected, replays are ignored, and a dropped microblock is recovered.',

  async run(d) {
    await d.step('Book and fund');
    const s = d.book({ ref: REF, amount: AMOUNT, deadlineInDays: 35 });
    d.fund('shipper', s, AMOUNT);
    const [gateIn, loaded] = routeEvents(REF);

    await d.step('A webhook edited in transit fails signature verification');
    d.ingest(d.webhook(gateIn, { tamper: true }), { expect: 'BAD_SIGNATURE' });
    d.expectCheckpoints(s, 0);

    await d.step('The genuine event is accepted and attested');
    const { evidenceHash } = d.ingest(d.webhook(gateIn));
    d.attest('carrier', s, gateIn.location, evidenceHash);

    await d.step('The carrier system retries the same webhook: it is ignored, not double-counted');
    d.ingest(d.webhook(gateIn), { expect: 'DUPLICATE' });
    d.expectCheckpoints(s, 1);

    await d.step('A micro-fork drops the next checkpoint before it is final');
    const { evidenceHash: loadedHash } = d.ingest(d.webhook(loaded));
    d.attest('carrier', s, loaded.location, loadedHash);
    d.expectCheckpoints(s, 2);
    d.dropLastMicroblock();
    d.expectCheckpoints(s, 1);

    await d.step('The attestor resubmits; this time it reaches finality');
    const receipt = d.attest('carrier', s, loaded.location, loadedHash);
    d.waitFinal(receipt);
    d.expectCheckpoints(s, 2);

    await d.step('Anyone can check documents against the on-chain hash');
    d.verifyEvidence(loadedHash);
    const ok = d.verifyEvidence(loadedHash, { tamper: true });
    if (ok) throw new Error('tampered evidence was not detected');

    await d.step('Delivery completes normally');
    d.confirmDelivery('consignee', s, podEvent(REF));
    d.expectStatus(s, Status.Released);
    d.showBalances();
  },
};
