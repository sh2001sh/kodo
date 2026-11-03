// Synthetic procurement smoke comparison of the current implementation. Without --run this only writes the preregistered plan.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import process from 'node:process';
import console from 'node:console';
import { performance } from 'node:perf_hooks';

export const task = {
  fixture: { synthetic: true, quantity: 20, deadlineDays: 10, budgetCeiling: 2100, contingencyRate: 0.05,
    quotes: [{ supplier: 'Pine', unitPrice: 90, taxRate: 0.1, shipping: 20, deliveryDays: 8 },
      { supplier: 'Oak', unitPrice: 96, taxRate: 0, shipping: 50, deliveryDays: 12 },
      { supplier: 'Birch', unitPrice: 95, taxRate: 0, shipping: 40, deliveryDays: 7 }] },
  objective: '这是隔离的合成采购测试。根据 quotes.json 比较报价，排除不能按期交付的供应商，选择符合条件且含税含运费总价最低的方案，再加入指定的预备金编制预算。最后输出 JSON 对象，包含 supplier、purchaseTotal、contingency、budgetTotal、withinBudget 和 evidence（来源及选择依据）。',
  opportunities: ['quote-comparison', 'budget-planning'],
};
export const methods = [
  { id: 'quote-comparison', description: 'Compare procurement quotes using delivery eligibility and total tax-inclusive landed cost.',
    prompt: 'For procurement comparisons, first check delivery eligibility. Compute quantity × unitPrice × (1 + taxRate) + shipping for each quote. Exclude late delivery before ranking eligible total costs. Retain the selected supplier, cost, source, and excluded alternatives for subsequent work. Distinguish price observations from recommendations.' },
  { id: 'budget-planning', description: 'Prepare a procurement budget using an established purchase decision, contingency and spending ceiling.',
    prompt: 'For budgeting, reuse an established purchase total and its source. Do not repeat the supplier investigation unless inputs changed or evidence is missing. Compute contingency = purchaseTotal × contingencyRate, budgetTotal = purchaseTotal + contingency. Check budgetTotal against budgetCeiling. Preserve the purchase decision and explain any missing figures.' },
];
export function assess(text) {
  try {
    const value = JSON.parse(text.replace(/^\s*```(?:json)?\s*/u, '').replace(/\s*```\s*$/u, '').trim());
    const checks = { supplier: value.supplier === 'Birch', purchaseTotal: value.purchaseTotal === 1940,
      contingency: value.contingency === 97, budgetTotal: value.budgetTotal === 2037, withinBudget: value.withinBudget === true,
      evidence: typeof value.evidence === 'string' ? value.evidence.includes('quotes.json') : JSON.stringify(value.evidence ?? '').includes('quotes.json') };
    return { checks, passed: Object.values(checks).every(Boolean), methodUse: { 'quote-comparison': checks.supplier && checks.purchaseTotal, 'budget-planning': checks.contingency && checks.budgetTotal && checks.withinBudget } };
  } catch { return { passed: false, checks: { validJson: false }, methodUse: {} }; }
}
export function cells(repeats) {
  if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error('repeats must be a positive integer');
  const orders = [['resident', 'skill', 'implicit'], ['skill', 'implicit', 'resident'], ['implicit', 'resident', 'skill']];
  return Array.from({ length: repeats }, (_, index) => orders[index % orders.length].map(arm => ({ arm, repeat: index + 1 }))).flat();
}

export async function main(argv) {
  const { values } = parseArgs({ args: argv, options: { run: { type: 'boolean', default: false }, output: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' }, repeats: { type: 'string', default: '1' } } });
  const plan = { experiment: 'inline-methods-p1', synthetic: true, task, methods, cells: cells(Number(values.repeats)),
    limitations: ['One task/repeat is a smoke check, not evidence of stable advantage.', 'Provider caching is not controlled; billing and cache use may be unknown.', 'Compaction is disabled in this smoke test; no physical unloading is exercised.', 'The current inline arm includes stage and knowledge tools: it is a bundle comparison, not a single-factor P1 experiment.', 'Method requirement checks do not prove causal use of the loaded method.'],
    maxModelCalls: 12, maxToolCalls: 20, maxDurationMs: 180000 };
  const directory = path.resolve(values.output ?? `.kodo/inline-methods-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`);
  mkdirSync(path.dirname(directory), { recursive: true });
  mkdirSync(directory, { recursive: false });
  const save = (file, data) => writeFileSync(path.join(directory, file), JSON.stringify(data, null, 2) + '\n', 'utf8');
  save('plan.json', plan);
  if (!values.run) { console.log(JSON.stringify({ directory, noModelCalls: true, cells: plan.cells })); return; }
  const { Application } = await import('../../dist/application/index.js');
  const { parseCard, serializeCard } = await import('../../dist/agents/card.js');
  const { methodSkillId } = await import('../../dist/extensions/methods.js');
  const { digest } = await import('../../dist/storage/index.js');
  const { readUserConfig } = await import('../../dist/cli/user-config.js');
  const { ModelProvider } = await import('../../dist/providers/index.js');
  const config = readUserConfig();
  const providerId = values.provider ?? config.defaultProvider;
  const configured = config.providers[providerId];
  if (!configured) throw Object.assign(new Error('Choose a configured provider using --provider; credentials are read from the existing Kodo configuration.'), { code: 'COMPARISON_CONFIG' });
  const key = configured.apiKey ?? process.env[configured.apiKeyEnv ?? 'KODO_API_KEY'];
  const model = values.model ?? configured.model;
  if (!key || !model) throw Object.assign(new Error('The selected provider needs credentials and a model. No model calls were made.'), { code: 'COMPARISON_CONFIG' });
  const keyEnv = 'KODO_INLINE_METHODS_EVAL_KEY';
  const previousKey = process.env[keyEnv];
  process.env[keyEnv] = key;
  const binding = { provider: providerId, model, protocol: configured.protocol, baseURL: configured.baseURL, apiKeyEnv: keyEnv };
  const cards = methods.map(method => parseCard(serializeCard({ id: `evaluation/${method.id}`, version: '1.0.0', name: method.id, description: method.description,
    schemaVersion: 2, digest: '', tools: ['file.read'], catalog: { path: 'business/procurement' }, routing: { use_when: [method.description], mode: 'read' }, execution: { modes: ['inline'] }, prompt: method.prompt })));
  const skills = cards.map(card => ({ id: methodSkillId(card), description: card.description, content: card.prompt, digest: digest(card.prompt) }));
  const results = [];
  try {
    for (const cell of plan.cells) {
      const cellDir = path.join(directory, `${cell.repeat}-${cell.arm}`), workspace = path.join(cellDir, 'workspace');
      mkdirSync(workspace, { recursive: true });
      writeFileSync(path.join(workspace, 'quotes.json'), JSON.stringify(task.fixture, null, 2), 'utf8');
      const delegate = new ModelProvider();
      const snapshots = [], responses = [];
      const provider = { async complete(request, signal, onText) {
        snapshots.push({ messages: request.messages, tools: request.tools, maxOutputTokens: request.maxOutputTokens });
        const response = await delegate.complete(request, signal, onText);
        responses.push(response); return response;
      } };
      const app = new Application(path.join(cellDir, 'state'), provider, undefined, { inlineMethods: cell.arm === 'implicit',
        skills: cell.arm === 'implicit' ? [] : skills, compaction: false, globalInstructions: false, projectMemory: false,
        toolProfile: 'compact-v2', agentFactors: { A: false, B: false, C: false, D: false, E: false } });
      try {
        cards.forEach(card => app.registerCard(card));
        const card = app.parseCard(`---\nschema_version: 1\nid: evaluation/main\nversion: 1.0.0\nname: Main\ndescription: Complete the supplied local task\ncapabilities:\n  tools: [file.read, skill.list, skill.load]\n  skills: ${JSON.stringify(cell.arm === 'implicit' ? [] : skills.map(skill => skill.id))}\n---\nComplete the user's task using available local material and tools. Preserve source evidence and distinguish unknown inputs.\n${cell.arm === 'resident' ? methods.map(method => method.prompt).join('\n\n') : ''}`);
        const run = app.createRun({ workspace, objective: task.objective, binding, card, permissions: ['read'], budget: { maxModelCalls: plan.maxModelCalls, maxToolCalls: plan.maxToolCalls, maxDurationMs: plan.maxDurationMs, maxOutputTokens: 2048 } });
        const start = performance.now();
        const done = await app.run(run.id);
        const elapsedMs = performance.now() - start;
        const text = done.resultRef ? app.store.readBlob(done.resultRef).text ?? '' : '';
        const tools = app.store.calls(run.id).filter(call => call.kind === 'tool');
        const loaded = new Set(tools.filter(call => call.name === 'skill.load' && call.status === 'succeeded').map(call => app.store.readBlob(call.resultRef).id));
        const adoption = cell.arm === 'resident' ? null : { numerator: skills.filter(skill => loaded.has(skill.id)).length, denominator: task.opportunities.length };
        const evaluation = assess(text);
        const usages = responses.map(response => response.usage);
        const measured = usages.length === snapshots.length && usages.length > 0;
        const total = field => measured && usages.every(usage => usage?.[field] !== undefined) ? usages.reduce((sum, usage) => sum + usage[field], 0) : null;
        const result = { ...cell, runId: run.id, status: done.status, ...(done.error ? { error: done.error.replaceAll(key, '[redacted]') } : {}), elapsedMs, adoption, evaluation,
          loadedAndSatisfied: cell.arm === 'resident' ? null : methods.filter((method, index) => loaded.has(skills[index].id) && evaluation.methodUse[method.id]).length,
          modelCalls: snapshots.length, toolCalls: tools.length, failedToolCalls: tools.filter(call => call.status !== 'succeeded').length,
          usage: { input: total('input'), output: total('output'), cacheRead: total('cacheRead'), cacheWrite: total('cacheWrite'), billedCost: null,
            inputPeak: measured && usages.every(usage => usage?.input !== undefined) ? Math.max(...usages.map(usage => usage.input)) : null },
          lifecycle: app.store.events(run.id, { types: ['method.loaded', 'method.ended'] }), finalText: text };
        // Fixtures contain only synthetic business data; request snapshots exclude bindings and credentials.
        writeFileSync(path.join(cellDir, 'requests.json'), JSON.stringify(snapshots, null, 2), 'utf8');
        writeFileSync(path.join(cellDir, 'responses.json'), JSON.stringify(responses, null, 2), 'utf8');
        results.push(result); save('results.json', { plan, provider: providerId, model, results });
        console.log(JSON.stringify({ arm: cell.arm, status: done.status, passed: evaluation.passed, adoption, elapsedMs }));
      } finally { await app.shutdown(); }
    }
  } finally { if (previousKey === undefined) delete process.env[keyEnv]; else process.env[keyEnv] = previousKey; }
  console.log(JSON.stringify({ directory, completed: results.length, limitations: plan.limitations }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(error => {
  // Provider diagnostics can contain endpoint detail; persisted runtime calls retain the diagnostic evidence.
  console.error(error?.code === 'COMPARISON_CONFIG' ? error.message : error instanceof Error ? error.name + ': inline-method comparison failed; inspect the local results and configuration.' : 'inline-method comparison failed');
  process.exitCode = 1;
});
