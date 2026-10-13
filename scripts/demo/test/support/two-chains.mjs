// Run by trace-recorder.test.js under the trace hook: two chains with steps, one without.
import { SimChain } from '../../lib/sim-chain.js';

new SimChain().createAccount('a');
new SimChain().createAccount('b');
new SimChain();
