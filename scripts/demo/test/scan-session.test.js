import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ScanSession, CustodyLedger, ScanResult } from '../lib/scan-session.js';
import { buildManifest, encodeLabel } from '../lib/package-labels.js';

const CONTRACT = 'ct_demo_ShipmentEscrow_1';
const manifest = buildManifest(['P1', 'P2', 'P3'].map((id) => ({ id, description: `Pallet ${id}` })));
const label = (id, contract = CONTRACT) => encodeLabel(contract, id);

function session({ kind = 'ScanIn', location = 'Rotterdam', ledger = new CustodyLedger() } = {}) {
  let now = 1_000;
  return new ScanSession({ contract: CONTRACT, manifest, location, kind, ledger, clock: () => (now += 1_000) });
}

describe('scan session', () => {
  test('expected packages are scanned with the injected clock time', () => {
    const s = session();
    assert.deepEqual(s.scan(label('P1')), { result: ScanResult.Expected, packageId: 'P1' });
    assert.deepEqual(s.bundle().scanned, [{ id: 'P1', at: 2_000, manual: false }]);
  });

  test('scanning the same label twice in a session is a harmless repeat', () => {
    const s = session();
    s.scan(label('P1'));
    assert.equal(s.scan(label('P1')).result, ScanResult.Repeat);
    assert.equal(s.bundle().scanned.length, 1);
  });

  test('unknown, foreign and unreadable labels are exceptions, never scanned', () => {
    const s = session();
    assert.equal(s.scan(label('P9')).result, ScanResult.Unknown);
    assert.equal(s.scan(label('P1', 'ct_demo_ShipmentEscrow_99')).result, ScanResult.Foreign);
    assert.equal(s.scan('smudged ### label').result, ScanResult.BadLabel);
    const b = s.bundle();
    assert.deepEqual(b.scanned, []);
    assert.deepEqual(b.exceptions.map((e) => e.result), ['unknown', 'foreign', 'bad-label']);
  });

  test('missing lists every manifest package not scanned', () => {
    const s = session();
    s.scan(label('P3'));
    assert.deepEqual(s.bundle().missing, ['P1', 'P2']);
  });

  test('all present means nothing missing', () => {
    const s = session();
    for (const id of ['P1', 'P2', 'P3']) s.scan(label(id));
    assert.deepEqual(s.bundle().missing, []);
  });

  test('manual entry for a damaged label counts, and is marked manual', () => {
    const s = session();
    assert.equal(s.enterManually('P2').result, ScanResult.Expected);
    assert.deepEqual(s.bundle().scanned, [{ id: 'P2', at: 2_000, manual: true }]);
  });

  test('manual entry still rejects ids outside the manifest', () => {
    assert.equal(session().enterManually('P9').result, ScanResult.Unknown);
    assert.equal(session().enterManually('bad id').result, ScanResult.BadLabel);
  });

  test('the bundle names its location, kind and contract', () => {
    const b = session({ kind: 'ScanOut', location: 'Yantian' }).bundle();
    assert.equal(b.location, 'Yantian');
    assert.equal(b.kind, 'ScanOut');
    assert.equal(b.contract, CONTRACT);
  });
});

describe('custody ledger', () => {
  test('commit records custody only for scanned packages', () => {
    const ledger = new CustodyLedger();
    const s = session({ ledger });
    s.scan(label('P1'));
    s.commit();
    assert.deepEqual(ledger.where('P1'), { state: 'in', location: 'Rotterdam' });
    assert.equal(ledger.where('P2'), null);
  });

  test('nothing moves until the checkpoint is committed', () => {
    const ledger = new CustodyLedger();
    session({ ledger }).scan(label('P1')); // never committed: signing failed
    assert.equal(ledger.where('P1'), null);
  });

  test('scan out then scan in elsewhere is a normal handover', () => {
    const ledger = new CustodyLedger();
    const out = session({ ledger, kind: 'ScanOut', location: 'Yantian' });
    out.scan(label('P1'));
    out.commit();
    const inn = session({ ledger, kind: 'ScanIn', location: 'Rotterdam' });
    assert.equal(inn.scan(label('P1')).result, ScanResult.Expected);
    inn.commit();
    assert.deepEqual(ledger.path('P1').map((h) => `${h.state}@${h.location}`), ['out@Yantian', 'in@Rotterdam']);
  });

  test('scan in at a second place without a scan out is a conflict (possible cloned label)', () => {
    const ledger = new CustodyLedger();
    const first = session({ ledger, location: 'Rotterdam' });
    first.scan(label('P1'));
    first.commit();
    const second = session({ ledger, location: 'Antwerp' });
    const r = second.scan(label('P1'));
    assert.equal(r.result, ScanResult.Conflict);
    assert.match(r.detail, /Rotterdam/);
    assert.deepEqual(second.bundle().scanned, []);
  });

  test('scanning in again at the same place is not a conflict', () => {
    const ledger = new CustodyLedger();
    const first = session({ ledger });
    first.scan(label('P1'));
    first.commit();
    assert.equal(session({ ledger }).scan(label('P1')).result, ScanResult.Expected);
  });
});
