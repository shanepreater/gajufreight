// Console presentation for the demo. Keeps all formatting in one place so the
// scenario code reads like a script, and can be silenced for tests.
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const ANSI = { bold: 1, dim: 2, red: 31, green: 32, yellow: 33, blue: 34, cyan: 36 };

export function createNarrator({ silent = false, color = false, pace = 0, interactive = false, out = process.stdout, input = process.stdin } = {}) {
  const paint = (style, text) => (color ? `\x1b[${ANSI[style]}m${text}\x1b[0m` : text);
  const write = (line = '') => {
    if (!silent) out.write(`${line}\n`);
  };
  let prompt = null;

  return {
    scenario(s, index, total) {
      write();
      write(paint('bold', `━━━ Scenario ${index}/${total}: ${s.title} ━━━`));
      write(paint('dim', s.summary));
    },
    step(n, text) {
      write();
      write(paint('cyan', `▸ Step ${n}: ${text}`));
    },
    action: (actor, text) => write(`  ${paint('bold', actor)} ${text}`),
    event: (text) => write(`  ${paint('blue', '⛴')}  ${text}`),
    info: (text) => write(`     ${paint('dim', text)}`),
    ok: (text) => write(`     ${paint('green', '✓')} ${text}`),
    rejected: (code, reason) => write(`     ${paint('green', '✓')} ${paint('yellow', `blocked: ${code}`)} ${paint('dim', `(${reason})`)}`),
    warn: (text) => write(`     ${paint('yellow', '!')} ${text}`),
    fail: (text) => write(`     ${paint('red', '✗')} ${text}`),

    table(headers, rows) {
      const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
      const line = (cells) => `     ${cells.map((c, i) => String(c).padEnd(widths[i])).join('  ')}`;
      write(paint('dim', line(headers)));
      rows.forEach((r) => write(line(r)));
    },

    scenarioResult(result) {
      write();
      if (result.ok) write(paint('green', `  ✔ ${result.title}: passed`));
      else write(paint('red', `  ✘ ${result.title}: FAILED (${result.error.code ?? result.error.name}: ${result.error.message})`));
    },

    summary(results) {
      const passed = results.filter((r) => r.ok).length;
      write();
      write(paint('bold', '━━━ Summary ━━━'));
      results.forEach((r) => write(`  ${r.ok ? paint('green', '✔') : paint('red', '✘')} ${r.id}`));
      write();
      write(paint(passed === results.length ? 'green' : 'red', `  ${passed}/${results.length} scenarios passed`));
    },

    async pause() {
      if (silent) return;
      if (interactive) {
        prompt ??= createInterface({ input, output: out });
        await prompt.question(paint('dim', '     ↵ press Enter to continue'));
      } else if (pace > 0) {
        await sleep(pace);
      }
    },

    close() {
      prompt?.close();
    },
  };
}
