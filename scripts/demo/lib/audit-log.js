// Structured audit trail (JSON Lines) of every demo action and outcome, for
// observability and for replaying what a customer saw. No-op unless a path is given.
import { appendFileSync, writeFileSync } from 'node:fs';

export function createAuditLog(path) {
  if (!path) return { record() {} };
  writeFileSync(path, '');
  return {
    record(entry) {
      const line = JSON.stringify({ at: new Date().toISOString(), ...entry }, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
      appendFileSync(path, `${line}\n`);
    },
  };
}

// In-memory variant for tests.
export function createMemoryLog() {
  const entries = [];
  return { entries, record: (entry) => entries.push(entry) };
}
