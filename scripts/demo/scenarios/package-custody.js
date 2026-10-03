import { Status, Kind } from '../lib/shipment-escrow.js';
import { gaju } from '../lib/fixtures.js';
import { encodeLabel } from '../lib/package-labels.js';

const REF = 'GF-2026-0008';
const AMOUNT = gaju(3_000);
const PALLETS = [
  { id: 'GF8-P1', description: 'Pallet 1: table lamps' },
  { id: 'GF8-P2', description: 'Pallet 2: kitchenware' },
  { id: 'GF8-P3', description: 'Pallet 3: textiles' },
];

export default {
  id: 'package-custody',
  title: 'Package labels: scan in and out at every location',
  summary: 'Three labelled pallets are scanned out at Yantian and in at Rotterdam. A missing pallet, a foreign label, a cloned label and a stranger are all caught.',

  async run(d) {
    await d.step('Shipper books three pallets; the manifest hash goes on-chain');
    const s = d.book({ ref: REF, amount: AMOUNT, deadlineInDays: 35, packages: PALLETS });

    await d.step('Shipper prints one QR label per pallet (labels identify; they do not authorise)');
    d.printLabels(s);
    const [p1, p2, p3] = PALLETS.map((p) => d.label(s, p.id));

    await d.step('Yantian: the carrier scans all three out, then signs ONE checkpoint');
    d.scan('carrier', s, { location: 'Yantian, Shenzhen', kind: Kind.ScanOut, labels: [p1, p2, p3] });

    await d.step('A stranger tries to record a scan: rejected, and custody does not move');
    d.scan('mallory', s, { location: 'Rotterdam', kind: Kind.ScanIn, labels: [p1], expect: 'UNAUTHORIZED' });

    await d.step('Rotterdam: the port agent scans in. One label is damaged, one pallet is missing, and a foreign label turns up');
    d.scan('portAgent', s, {
      location: 'Rotterdam, Maasvlakte II',
      kind: Kind.ScanIn,
      labels: [p1, p1, encodeLabel('ct_demo_ShipmentEscrow_99', 'XX-P1'), 'water-damaged ###'],
      manual: ['GF8-P3'],
    });

    await d.step('Antwerp: a copy of pallet 1’s label is scanned while pallet 1 is still in Rotterdam');
    d.scan('customs', s, { location: 'Antwerp', kind: Kind.ScanIn, labels: [p1] });

    await d.step('Delivery cannot be faked through a checkpoint');
    d.attest('carrier', s, 'Tilburg', 'e'.repeat(64), { kind: Kind.Delivered, expect: 'BAD_KIND' });

    await d.step('Custody per pallet');
    d.showCustody(s);
    d.expectCustody(s, 'GF8-P2', { state: 'out', location: 'Yantian, Shenzhen' });

    await d.step('The consignee disputes the missing pallet; 2 of 3 arbiters pay the carrier for 2 of 3 pallets');
    d.dispute('consignee', s, 'pallet GF8-P2 never arrived (see Rotterdam scan-in)');
    d.vote('arbiter1', s, 67);
    const receipt = d.vote('arbiter3', s, 67);
    d.expectStatus(s, Status.Resolved);
    d.waitFinal(receipt);
    d.showBalances();
  },
};
