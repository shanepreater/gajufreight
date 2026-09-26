// Runs scenarios in isolation (fresh chain each) and keeps going after a failure,
// so one broken scenario never stops the rest of a customer demo.
import { SimChain } from './sim-chain.js';
import { Demo } from './demo.js';

export async function runScenarios(scenarios, { narrator, audit, verbose = false }) {
  const results = [];
  for (const [i, scenario] of scenarios.entries()) {
    narrator.scenario(scenario, i + 1, scenarios.length);
    audit.record({ kind: 'scenario-start', id: scenario.id });
    const demo = new Demo({ chain: new SimChain(), narrator, audit });
    let result;
    try {
      await scenario.run(demo);
      demo.checkInvariants();
      result = { id: scenario.id, title: scenario.title, ok: true };
    } catch (error) {
      narrator.fail(`${error.name}: ${error.code ?? error.message}`);
      if (verbose && error.stack) narrator.info(error.stack);
      result = { id: scenario.id, title: scenario.title, ok: false, error };
    }
    audit.record({ kind: 'scenario-end', id: scenario.id, ok: result.ok, error: result.error?.message });
    narrator.scenarioResult(result);
    results.push(result);
  }
  narrator.summary(results);
  return results;
}
