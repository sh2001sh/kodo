/** This source runs only in a separately sandboxed Node process, never in the host. */
export const packageWorkerSource = String.raw`
import { pathToFileURL } from 'node:url';
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 1048576) throw new Error('request exceeds worker input limit');
}
const request = JSON.parse(input);
const write = process.stdout.write.bind(process.stdout);
// Conventional module diagnostics cannot corrupt the JSON response channel.
console.log = console.info = console.debug = (...args) => console.error(...args);
try {
  const module = await import(pathToFileURL(process.argv[1]).href);
  const execute = module.execute ?? module.default;
  if (typeof execute !== 'function') throw new Error('tool module must export execute or a default function');
  const result = await execute(request.arguments, Object.freeze(request.context));
  const json = JSON.stringify({ protocol: 'kodo-tool-result/v1', result });
  if (result === undefined || Buffer.byteLength(json) > 1048576) throw new Error('tool result must be bounded JSON');
  write(json);
} catch {
  write(JSON.stringify({ protocol: 'kodo-tool-result/v1', error: 'sandboxed tool execution failed' }));
  process.exitCode = 1;
}
`;
