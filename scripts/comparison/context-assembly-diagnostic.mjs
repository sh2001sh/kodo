import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import console from 'node:console';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Application } from '../../dist/application/index.js';
import { buildContext } from '../../dist/runtime/context.js';

const { values } = parseArgs({ options: { root: { type: 'string' }, 'work-tokens': { type: 'string', default: '65536' }, 'evidence-tokens': { type: 'string', default: '1600' } } });
const workInputTokens = Number(values['work-tokens']);
const evidenceInputTokens = Number(values['evidence-tokens']);
if (!Number.isSafeInteger(workInputTokens) || workInputTokens < 1024) throw new Error('--work-tokens must be an integer of at least 1024');
if (!Number.isSafeInteger(evidenceInputTokens) || evidenceInputTokens < 256 || evidenceInputTokens > workInputTokens) throw new Error('--evidence-tokens must be an integer from 256 through --work-tokens');

const root = path.resolve(values.root ?? path.join('.kodo', `context-assembly-diagnostic-${Date.now()}`));
if (existsSync(root)) throw new Error('Use a fresh --root directory; diagnostic evidence is never overwritten');
await mkdir(root, { recursive: true });

const body = label => `${label} evidence `.repeat(100);
const round = (id, file) => [
  { role: 'assistant', content: `Inspect ${file}`, tool_calls: [{ id, name: 'file.read', arguments: JSON.stringify({ path: file }) }] },
  { role: 'tool', tool_call_id: id, content: JSON.stringify({ path: file, hash: id.padEnd(64, 'a').slice(0, 64), content: body(file) }) },
];
const append = (app, runId, messages) => {
  const run = app.store.run(runId);
  app.store.updateRun(runId, { contextRef: app.store.blob([...app.store.readBlob(run.contextRef), ...messages]) });
};
const options = assembly => ({ maxContextTokens: 131_072, maxOutputTokens: 8_192, ...(assembly ? { assembly: { strategy: 'deterministic', workInputTokens, evidenceInputTokens } } : {}) });

const app = new Application(path.join(root, 'state'), undefined, undefined, { exploration: false });
try {
  const run = app.createRun({
    objective: 'Inspect src/alpha-empty-list.ts and preserve evidence.',
    workspace: root,
    binding: { model: 'diagnostic', baseURL: 'http://127.0.0.1:1/v1', apiKeyEnv: 'KODO_UNUSED_DIAGNOSTIC_KEY', limits: { context: 131_072, output: 8_192 } },
    permissions: ['read'],
  });
  append(app, run.id, [
    ...round('alpha', 'src/alpha-empty-list.ts'),
    ...round('beta', 'src/beta-pagination.ts'),
    ...round('gamma', 'src/gamma-report.ts'),
    ...round('recent-one', 'src/recent-one.ts'),
    ...round('recent-two', 'src/recent-two.ts'),
    { role: 'user', content: 'Focus on src/alpha-empty-list.ts and the empty list failure.' },
  ]);

  const source = app.store.run(run.id);
  const off = buildContext(app.store, source, null, [], options(false));
  const assembled = buildContext(app.store, source, null, [], options(true));
  if (!assembled.assembly) throw new Error('deterministic assembly did not produce a changed projection');
  const tool = (messages, id) => messages.find(message => message.role === 'tool' && message.tool_call_id === id)?.content ?? '';
  const checks = {
    defaultUnchanged: off.assembly === undefined && off.messages.every((message, index) => JSON.stringify(message) === JSON.stringify(app.store.readBlob(source.contextRef)[index])),
    relevantRetained: tool(assembled.messages, 'alpha').includes('alpha-empty-list.ts evidence'),
    unrelatedHidden: tool(assembled.messages, 'beta').includes('"contextHidden":true'),
    recentRetained: tool(assembled.messages, 'recent-one').includes('src/recent-one.ts evidence') && tool(assembled.messages, 'recent-two').includes('src/recent-two.ts evidence'),
    evidenceBudgetEnforced: assembled.assembly.usedEvidenceTokens <= assembled.assembly.evidenceInputTokens,
    stableSourcesRecorded: assembled.assembly.selectedSourceIds.length === assembled.assembly.selectedGroups && assembled.assembly.selectedSourceIds.every(id => id.startsWith('history:')),
    noModelCall: app.store.calls(run.id).every(call => call.kind !== 'model'),
  };

  app.store.transaction(() => {
    app.store.updateRun(run.id, { contextRef: app.store.blob(assembled.messages) });
    app.store.event(run.id, 'context.assembled', { ...assembled.assembly });
  });
  append(app, run.id, [{ role: 'user', content: 'The goal changed: inspect src/beta-pagination.ts now.' }]);
  const changed = buildContext(app.store, app.store.run(run.id), null, [], options(true));
  checks.focusChangeRestored = Boolean(changed.assembly?.restoredOffsets.length) && tool(changed.messages, 'beta').includes('beta-pagination.ts evidence');
  checks.pointerIndexed = app.store.events(run.id).some(event => event.type === 'context.assembled' && event.data.archivedRef === assembled.assembly.archivedRef);
  if (Object.values(checks).some(value => !value)) throw new Error(`diagnostic failed: ${JSON.stringify(checks)}`);

  const result = {
    schemaVersion: 1,
    kind: 'fixed-snapshot-mechanism-diagnostic',
    createdAt: new Date().toISOString(),
    policy: { strategy: 'deterministic', workInputTokens, evidenceInputTokens },
    off: { estimatedInputTokens: off.estimatedInputTokens, messageCount: off.messages.length },
    assembly: {
      beforeTokens: assembled.assembly.beforeTokens,
      afterTokens: assembled.assembly.afterTokens,
      tokenReduction: assembled.assembly.beforeTokens - assembled.assembly.afterTokens,
      tokenReductionRatio: (assembled.assembly.beforeTokens - assembled.assembly.afterTokens) / assembled.assembly.beforeTokens,
      candidateGroups: assembled.assembly.candidateGroups,
      selectedGroups: assembled.assembly.selectedGroups,
      evidenceInputTokens: assembled.assembly.evidenceInputTokens,
      usedEvidenceTokens: assembled.assembly.usedEvidenceTokens,
      selectedSourceIds: assembled.assembly.selectedSourceIds,
      hiddenMessages: assembled.assembly.hiddenOffsets.length,
      restoredMessagesAfterFocusChange: changed.assembly?.restoredOffsets.length ?? 0,
      auxiliaryModelCalls: 0,
    },
    checks,
    limitation: 'Synthetic fixed history verifies mechanism and accounting only; it does not estimate real-task quality, cost, or latency.',
  };
  await writeFile(path.join(root, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ root, ...result }));
} finally {
  await app.shutdown();
}
