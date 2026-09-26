#!/usr/bin/env node
// GajuFreight end-to-end demo. See README.md in this folder.
import { parseArgs } from 'node:util';
import { scenarios } from './scenarios/index.js';
import { runScenarios } from './lib/runner.js';
import { createNarrator } from './lib/narrator.js';
import { createAuditLog } from './lib/audit-log.js';

const USAGE = `Usage: node run-demo.js [options]

  -s, --scenario <id>   Run one scenario (repeatable). Default: all
  -l, --list            List scenarios and exit
  -i, --interactive     Pause for Enter at each step (live presenting)
  -f, --fast            No pacing delays
      --log <file>      Write a JSON Lines audit log
      --backend <name>  sim (default) | local-chain (not implemented yet)
      --no-color        Disable colours (also honours NO_COLOR)
  -v, --verbose         Show stack traces on failure
  -h, --help            Show this help

Exit codes: 0 all passed · 1 a scenario failed · 2 usage error · 130 interrupted`;

function parse() {
  try {
    return parseArgs({
      options: {
        scenario: { type: 'string', short: 's', multiple: true },
        list: { type: 'boolean', short: 'l' },
        interactive: { type: 'boolean', short: 'i' },
        fast: { type: 'boolean', short: 'f' },
        log: { type: 'string' },
        backend: { type: 'string', default: 'sim' },
        'no-color': { type: 'boolean' },
        verbose: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
      },
    }).values;
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
}

async function main() {
  const opts = parse();
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  if (opts.list) {
    for (const s of scenarios) console.log(`${s.id.padEnd(24)} ${s.title}`);
    return 0;
  }
  if (opts.backend !== 'sim') {
    console.error(`Backend "${opts.backend}" is not implemented yet (dev-approach phase 1). Use --backend sim.`);
    return 2;
  }

  let selected = scenarios;
  if (opts.scenario) {
    const unknown = opts.scenario.filter((id) => !scenarios.some((s) => s.id === id));
    if (unknown.length) {
      console.error(`Unknown scenario(s): ${unknown.join(', ')}. Use --list.`);
      return 2;
    }
    selected = scenarios.filter((s) => opts.scenario.includes(s.id));
  }

  const tty = Boolean(process.stdout.isTTY);
  const narrator = createNarrator({
    color: tty && !opts['no-color'] && !process.env.NO_COLOR,
    pace: tty && !opts.fast ? 350 : 0,
    interactive: Boolean(opts.interactive),
  });
  const audit = createAuditLog(opts.log);

  process.on('SIGINT', () => {
    narrator.close();
    console.error('\nDemo interrupted.');
    process.exit(130);
  });

  try {
    const results = await runScenarios(selected, { narrator, audit, verbose: opts.verbose });
    return results.every((r) => r.ok) ? 0 : 1;
  } finally {
    narrator.close();
  }
}

process.exitCode = await main();
