// Loaded with `--import` when TRACE_DIR is set (npm run test:traces): every SimChain a test or
// scenario creates is recorded, and on exit each test file's traces are written to
// TRACE_DIR/<test file>.jsonl, one trace per line (#70).
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { SimChain } from './sim-chain.js';
import { TraceRecorder } from './trace-recorder.js';

const dir = process.env.TRACE_DIR;
if (dir) {
  const recorders = [];
  SimChain.onCreate = (chain) => recorders.push(new TraceRecorder(chain));
  process.on('exit', () => {
    const traces = recorders.filter((r) => r.steps.length > 0);
    if (traces.length === 0) return;
    mkdirSync(dir, { recursive: true });
    const lines = traces.map((r) => JSON.stringify(r));
    writeFileSync(join(dir, `${basename(process.argv[1] ?? 'run')}.jsonl`), `${lines.join('\n')}\n`);
  });
}
