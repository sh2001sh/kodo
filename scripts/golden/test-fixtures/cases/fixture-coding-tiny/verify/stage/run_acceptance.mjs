// Held-out acceptance runner for fixture-coding-tiny. Staged into <workspace>/_verify
// after the model run; reports per-test results into _verify/result.json and always
// exits 0 so the rubric reads the JSON instead of the process status.
/* global console, process */
import { writeFileSync } from 'node:fs';
import { URL } from 'node:url';

const tests = { mul_ok: false, add_ok: false };
try {
  const calc = await import(new URL('../src/calc.js', import.meta.url));
  tests.add_ok = calc.add(2, 3) === 5;
  if (typeof calc.mul === 'function') tests.mul_ok = calc.mul(2, 3) === 6;
} catch (error) {
  tests.error = String(error?.message ?? error);
}
writeFileSync('_verify/result.json', `${JSON.stringify({ tests }, null, 2)}\n`, 'utf8');
console.log('acceptance:', JSON.stringify(tests));
process.exit(0);
