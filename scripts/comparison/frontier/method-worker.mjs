// Container-local SDK adapter. No task solution, hidden tests or old outputs are supplied.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import process from 'node:process';
import console from 'node:console';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export const arms = ['resident', 'skill', 'marking', 'checkpoint', 'active'];
export const methods = [
  { id: 'engineering/understand', description: 'Understand an unfamiliar project and trace requirements before implementation.', content: 'Identify the requested behavior, relevant entry points, existing conventions and dependencies. Read the smallest relevant source and tests first. Preserve concrete file references and unresolved questions for the implementation phase. Distinguish observed behavior from assumptions. Reuse facts already established in this conversation; reread only when a source changed or a specific fact is missing.' },
  { id: 'engineering/implement', description: 'Implement a compatible change using existing project abstractions.', content: 'Use established project facts and preserve existing public behavior unless the task explicitly changes it. Trace each requirement to a code change. Keep changes focused and handle edge cases that follow from the requirements. Do not repeatedly explore already established structure. Save working changes before expanding validation. Treat failed checks as evidence to diagnose, never as successful completion.' },
  { id: 'engineering/verify', description: 'Validate and deliver a completed implementation with evidence.', content: 'Run focused checks for changed behavior, then the relevant regression suite. Inspect failures before changing code. Tie verification results to the current revision; rerun after relevant edits, not merely to recover output. Preserve check output and report limitations honestly. Finish when the requested behavior and appropriate checks are satisfied; do not add unrelated polishing or speculative benchmarks.' },
];
export function validateArm(arm) { if (!arms.includes(arm)) throw new Error('Unknown method experiment arm'); return arm; }

export function configureMethods(app, arm, { serializeCard, methodSkillId, roleAllows }) {
  const inline = ['marking', 'checkpoint', 'active'].includes(arm);
  const hash = value => createHash('sha256').update(value).digest('hex');
    const sharedTools = [...new Set([...app.defaultCard.tools, 'skill.list', 'skill.load', 'artifact.write'])].filter(name => roleAllows({ card: app.defaultCard }, { inlineMethods: true, toolProfile: 'compact-v2', permissions: ['read', 'write', 'exec'], agentFactors: { A: true, B: true, C: true, D: true, E: true } }, name));
    const cards = methods.map(method => app.parseCard(serializeCard({
      id: method.id, version: '1.0.0', name: method.id.split('/')[1], description: method.description,
      schemaVersion: 2, catalog: { path: 'engineering/change' }, routing: { use_when: [method.description], mode: 'write' },
      execution: { modes: ['inline'] }, tools: sharedTools, prompt: method.content, digest: '',
    })));
    if (inline) cards.forEach(card => app.registerCard(card));
    else app.registerSkills(methods.map((method, index) => ({ ...method, id: methodSkillId(cards[index]), digest: hash(method.content) })));
    const defaultCard = app.defaultCard;
    const base = { ...defaultCard, tools: sharedTools,
      ...(!inline ? { skills: cards.map(methodSkillId) } : {}),
      prompt: defaultCard.prompt + (arm === 'resident' ? '\n\n' + methods.map(method => `${method.description}\n${method.content}`).join('\n\n') : ''),
    };
    const card = app.parseCard(serializeCard(base));
  return { cards, card };
}

export async function main() {
  const config = JSON.parse(await readFile('/fh-config/trial.json', 'utf8'));
  const arm = validateArm(config.kodoMethodArm);
  const [{ Application }, { serializeCard }, { methodSkillId }, { roleAllows }] = await Promise.all([
    import('/opt/fh/kodo/dist/application/index.js'), import('/opt/fh/kodo/dist/agents/card.js'), import('/opt/fh/kodo/dist/extensions/methods.js'), import('/opt/fh/kodo/dist/runtime/role-view.js'),
  ]);
  const inline = ['marking', 'checkpoint', 'active'].includes(arm);
  const app = new Application('/fh-state/kodo', undefined, undefined, {
    toolProfile: 'compact-v2', taskProtocol: 3, shellProgram: '/bin/bash',
    agentFactors: { A: true, B: true, C: true, D: true, E: true },
    ...(config.kodoSandbox ? { sandbox: { network: 'none' } } : {}),
    skills: [],
    ...(inline ? { inlineMethods: true, methodUnloading: arm !== 'marking', methodToolView: arm === 'active' ? 'active' : 'stable' } : {}),
  });
  let run;
  const stop = () => { if (run) app.coordinator.cancel(run.id); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  try {
    const { cards, card } = configureMethods(app, arm, { serializeCard, methodSkillId, roleAllows });
    run = app.createRun({ workspace: '/app', objective: await readFile('/fh-config/instruction.md', 'utf8'), card,
      permissions: ['read', 'write', 'exec'],
      binding: { model: config.model, protocol: 'chat-completions', baseURL: 'http://127.0.0.1:4011/v1', apiKeyEnv: 'FH_RELAY_KEY', limits: { context: config.contextTokens, output: config.outputTokens } },
      budget: { maxContextTokens: config.contextTokens, maxOutputTokens: config.outputTokens, maxDurationMs: config.timeoutSec * 1000, toolTimeoutMs: 120000 },
    });
    const result = await app.run(run.id);
    const allRuns = app.store.listRuns(run.sessionId);
    const calls = allRuns.flatMap(owner => app.store.calls(owner.id));
    const ids = cards.map(methodSkillId);
    const loads = calls.filter(call => call.name === 'skill.load' && call.status === 'succeeded').map(call => app.store.readBlob(call.resultRef).id);
    const stageLoads = allRuns.flatMap(owner => app.store.events(owner.id, { types: ['method.loaded'] })).map(event => event.data.id);
    const loaded = ids.filter(id => loads.includes(id) || stageLoads.includes(id));
    const report = { arm, runId: run.id, status: result.status, error: result.error ?? null,
      methodDefinitions: methods, loadedMethods: loaded, opportunities: ids.length,
      adoption: arm === 'resident' ? null : { numerator: loaded.length, denominator: ids.length },
      events: allRuns.flatMap(owner => app.store.events(owner.id, { types: ['method.loaded', 'method.ended', 'context.methods.unloaded', 'task.node.updated', 'agent.roster.revised', 'knowledge.saved'] })),
      session: { toolProfile: app.store.session(run.sessionId).toolProfile, inlineMethods: app.store.session(run.sessionId).inlineMethods ?? false, methodUnloading: app.store.session(run.sessionId).methodUnloading ?? false, methodToolView: app.store.session(run.sessionId).methodToolView ?? null },
      note: 'Loaded methods measure autonomous selection only. skill/resident versus inline arms compare the full feature bundle, including task and knowledge tool exposure; marking/checkpoint isolate unloading and checkpoint/active isolate tool visibility. Hot installation is covered by host integration tests, not forced during these tasks. The independent verifier measures delivery, not causal method use.',
    };
    await writeFile('/fh-state/method-results.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ type: 'run.finished', runId: run.id, status: result.status }));
    if (result.status !== 'completed') process.exitCode = 1;
  } finally { process.off('SIGTERM', stop); process.off('SIGINT', stop); await app.shutdown(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
