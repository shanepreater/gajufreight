// Off-chain scanning (ADR 0003): a scan session collects the labels scanned at one
// location, then becomes ONE signed checkpoint whose evidence bundle lists them.
// The custody ledger is the read-model view of where each package last was.
import { ContractError } from './errors.js';
import { encodeLabel, parseLabel } from './package-labels.js';

export const ScanResult = Object.freeze({
  Expected: 'expected',
  Repeat: 'repeat',
  Unknown: 'unknown',
  Foreign: 'foreign',
  BadLabel: 'bad-label',
  Conflict: 'conflict',
});

export class CustodyLedger {
  #history = new Map(); // packageId -> [{ state, location }]

  where(packageId) {
    const last = this.#history.get(packageId)?.at(-1);
    return last ? { state: last.state, location: last.location } : null;
  }

  path(packageId) {
    return (this.#history.get(packageId) ?? []).map(({ state, location }) => ({ state, location }));
  }

  // `txHash` ties each entry to its checkpoint, so a dropped checkpoint can be undone.
  record(packageId, location, kind, txHash) {
    const entry = { state: kind === 'ScanIn' ? 'in' : 'out', location, txHash };
    this.#history.set(packageId, [...(this.#history.get(packageId) ?? []), entry]);
  }

  rollback(txHash) {
    for (const [id, entries] of this.#history) {
      const kept = entries.filter((e) => e.txHash !== txHash);
      if (kept.length) this.#history.set(id, kept);
      else this.#history.delete(id);
    }
  }
}

export class ScanSession {
  #scanned = new Map(); // packageId -> { id, at, manual }
  #exceptions = [];

  constructor({ contract, manifest, location, kind, ledger, clock }) {
    // Only scans move custody; a Milestone checkpoint is not a scan.
    if (kind !== 'ScanIn' && kind !== 'ScanOut') throw new ContractError('BAD_KIND');
    this.contract = contract;
    this.location = location;
    this.kind = kind;
    this.ledger = ledger;
    this.clock = clock;
    this.expectedIds = manifest.packages.map((p) => p.id);
  }

  scan(text, { manual = false } = {}) {
    let label;
    try {
      label = parseLabel(text);
    } catch (error) {
      if (!(error instanceof ContractError)) throw error;
      return this.#exception({ result: ScanResult.BadLabel, text });
    }
    const { contract, packageId } = label;
    if (contract !== this.contract) return this.#exception({ result: ScanResult.Foreign, packageId, detail: contract });
    if (!this.expectedIds.includes(packageId)) return this.#exception({ result: ScanResult.Unknown, packageId });
    if (this.#scanned.has(packageId)) return { result: ScanResult.Repeat, packageId };

    const conflictAt = this.#conflictingLocation(packageId);
    if (conflictAt) return this.#exception({ result: ScanResult.Conflict, packageId, detail: `already scanned in at ${conflictAt}` });

    this.#scanned.set(packageId, { id: packageId, at: this.clock(), manual });
    return { result: ScanResult.Expected, packageId };
  }

  // Damaged label: type the printed id. Validated exactly like a scan.
  enterManually(packageId) {
    let text;
    try {
      text = encodeLabel(this.contract, packageId);
    } catch (error) {
      if (!(error instanceof ContractError)) throw error;
      return this.#exception({ result: ScanResult.BadLabel, text: packageId });
    }
    return this.scan(text, { manual: true });
  }

  // The evidence bundle that the signed checkpoint's hash commits to.
  bundle() {
    return {
      contract: this.contract,
      location: this.location,
      kind: this.kind,
      scanned: [...this.#scanned.values()],
      missing: this.expectedIds.filter((id) => !this.#scanned.has(id)),
      exceptions: [...this.#exceptions],
    };
  }

  // Call only after the checkpoint is accepted. If its microblock is later dropped,
  // `ledger.rollback(txHash)` undoes it, so custody never runs ahead of the chain.
  commit(txHash) {
    for (const id of this.#scanned.keys()) this.ledger.record(id, this.location, this.kind, txHash);
  }

  // A package still "in" somewhere else cannot also be scanned in here.
  #conflictingLocation(packageId) {
    if (this.kind !== 'ScanIn') return null;
    const last = this.ledger.where(packageId);
    return last?.state === 'in' && last.location !== this.location ? last.location : null;
  }

  #exception(entry) {
    this.#exceptions.push(entry);
    return entry;
  }
}
