// Demo data. All companies and people are fictional; ports and places are real.
import { KEYBLOCK_MS } from './sim-chain.js';

// PLACEHOLDER: smallest Gaju denomination is an open question (docs/hld.md §7 Q3).
export const UNITS_PER_GAJU = 10n ** 18n;
export const KEYBLOCKS_PER_DAY = (24 * 60 * 60 * 1000) / KEYBLOCK_MS; // 720

export const gaju = (n) => BigInt(n) * UNITS_PER_GAJU;

export function formatGaju(units) {
  const sign = units < 0n ? '-' : '';
  const abs = units < 0n ? -units : units;
  const whole = (abs / UNITS_PER_GAJU).toLocaleString('en-US');
  const frac = (abs % UNITS_PER_GAJU).toString().padStart(18, '0').slice(0, 4).replace(/0+$/, '');
  return `${sign}${whole}${frac ? `.${frac}` : ''} 木`;
}

export const PARTIES = [
  { key: 'shipper', label: 'Aroha Home Goods', role: 'Shipper', balance: gaju(10_000) },
  { key: 'forwarderA', label: 'Tasman Freight Forwarding', role: 'Forwarder', balance: gaju(2_000) },
  { key: 'forwarderB', label: 'Nordhaven Logistics', role: 'Forwarder', balance: gaju(2_000) },
  { key: 'carrier', label: 'Kōwhai Ocean Lines', role: 'Carrier', balance: gaju(50) },
  { key: 'consignee', label: 'Lindqvist Retail BV', role: 'Consignee', balance: gaju(50) },
  { key: 'trucker', label: 'Brabant Road Haulage', role: 'Carrier (road)', balance: gaju(50) },
  { key: 'originAgent', label: 'Yantian Terminal Services', role: 'Attestor (origin)', balance: gaju(10) },
  { key: 'portAgent', label: 'Maasvlakte Port Services', role: 'Attestor (port)', balance: gaju(10) },
  { key: 'customs', label: 'Delta Customs Brokers', role: 'Attestor (customs)', balance: gaju(10) },
  { key: 'arbiter1', label: 'Freight Arbitration Desk', role: 'Arbiter', balance: gaju(10) },
  { key: 'arbiter2', label: 'Marine Surveyors Guild', role: 'Arbiter', balance: gaju(10) },
  { key: 'arbiter3', label: 'Independent Cargo Assessor', role: 'Arbiter', balance: gaju(10) },
  { key: 'mallory', label: 'Unknown account', role: 'Not a party', balance: gaju(5_000) },
];

export const CONTAINER = 'GJFU 123456 7';

const day = (d, hh = 9) => new Date(Date.UTC(2026, 9, 1 + d, hh)).toISOString();

// Ocean route Shenzhen (Yantian) → Singapore → Rotterdam → Tilburg.
// `source` is the party whose system reports the event and whose attestor signs it.
export function routeEvents(ref) {
  const e = (n, type, location, unlocode, occurredAt, source, details = {}) => ({
    id: `${ref}-evt-${String(n).padStart(2, '0')}`,
    reference: ref,
    container: CONTAINER,
    type,
    location,
    unlocode,
    occurredAt,
    source,
    details,
  });
  return [
    e(1, 'GATE_IN', 'Yantian International Container Terminal, Shenzhen', 'CNYTN', day(0), 'carrier', { seal: 'SL-448120' }),
    e(2, 'LOADED_ON_VESSEL', 'Yantian, Shenzhen', 'CNYTN', day(1), 'carrier', { vessel: 'MV Kauri Star', voyage: '042W' }),
    e(3, 'TRANSSHIPMENT', 'Port of Singapore', 'SGSIN', day(6), 'carrier', { vessel: 'MV Tōtara Bay', voyage: '117W' }),
    e(4, 'DISCHARGED', 'Port of Rotterdam, Maasvlakte II', 'NLRTM', day(27), 'portAgent', { terminal: 'MV2-East' }),
    e(5, 'CUSTOMS_CLEARED', 'Port of Rotterdam', 'NLRTM', day(28), 'customs', { declaration: 'MRN 26NL0000DEMO0042' }),
    e(6, 'OUT_FOR_DELIVERY', 'Rotterdam → Tilburg', 'NLRTM', day(29), 'carrier', { truck: 'NL-DEMO-12' }),
  ];
}

export function podEvent(ref, { signedBy = 'consignee' } = {}) {
  return {
    id: `${ref}-evt-pod`,
    reference: ref,
    container: CONTAINER,
    type: 'PROOF_OF_DELIVERY',
    location: 'Lindqvist DC, Tilburg',
    unlocode: 'NLTLB',
    occurredAt: day(30, 14),
    source: signedBy,
    details: { signedBy, seal: 'SL-448120 intact', photos: 2 },
  };
}

export function temperatureExcursion(ref) {
  return {
    id: `${ref}-evt-temp`,
    reference: ref,
    container: CONTAINER,
    type: 'TEMPERATURE_EXCURSION',
    location: 'Indian Ocean, en route to Rotterdam',
    unlocode: null,
    occurredAt: day(14, 3),
    source: 'carrier',
    details: { setpointC: 4, observedMaxC: 11.5, durationMinutes: 190, sensor: 'reefer-probe-2' },
  };
}
