import { parseArgs } from 'node:util';
import process from 'node:process';
import console from 'node:console';
import { URL } from 'node:url';
import { matrix, runComparison } from './comparison/exploration.mjs';

const { values } = parseArgs({ options: { scripted: { type: 'boolean' }, live: { type: 'boolean' }, repeats: { type: 'string', default: '3' }, model: { type: 'string' }, endpoint: { type: 'string' }, 'key-env': { type: 'string' }, protocol: { type: 'string', default: 'chat-completions' }, 'timeout-ms': { type: 'string', default: '120000' } } });
if (values.live && values.scripted) throw new Error('Choose --scripted or --live');
const repeats = Number(values.repeats);
const experiments = matrix(repeats);
if (!values.scripted && !values.live) {
  console.log(JSON.stringify({ mode: 'dry-run', providerRequests: 0, experiments, note: 'No provider calls. --scripted verifies the deterministic protocol only. --live requires explicit --model, --endpoint and --key-env; minimum 3 repeats. Each reuse row first runs a charged positive-control prelude; its costs are separately retained.' }, null, 2));
} else {
  const timeoutMs = Number(values['timeout-ms']);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000) throw new Error('--timeout-ms must be an integer >= 1000');
  let binding;
  if (values.live) {
    if (!values.model || !values.endpoint || !values['key-env'] || !process.env[values['key-env']]) throw new Error('--live requires explicit --model, --endpoint and --key-env naming a populated environment variable');
    if (!['chat-completions', 'responses', 'anthropic'].includes(values.protocol)) throw new Error('Unsupported --protocol');
    const url = new URL(values.endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Endpoint must be an HTTP(S) URL without credentials, query or fragment');
    binding = { model: values.model, baseURL: url.href, apiKeyEnv: values['key-env'], protocol: values.protocol };
  }
  const report = await runComparison({ mode: values.scripted ? 'scripted' : 'live', repeats, binding, timeoutMs, onResult: result => console.log(JSON.stringify(result)) });
  console.log(JSON.stringify({ report: `${report.root}/report.json`, summary: report.summary, caveats: report.caveats }, null, 2));
  if (report.rows.some(row => !row.passed)) process.exitCode = 1;
}
