import { parseCard, serializeCard } from './card.js';
import { hostToolNames } from '../tools/catalog.js';
import type { Card, CardReference, CardReportField } from '../runtime/types.js';

const readTools = ['file.read', 'file.list', 'file.search', 'artifact.read'];
const writeTools = [...readTools, 'file.patch', 'file.apply_patch', 'file.mkdir', 'file.rename', 'file.delete', 'process.exec'];
const changeReport: CardReportField[] = [
  { name: 'changed_files', kind: 'paths', required: true },
  { name: 'checks', kind: 'calls', required: true, description: 'Calls actually run; their exit states are reported independently of report completeness.' },
  { name: 'open_issues', kind: 'list', required: true },
  { name: 'contract_requests', kind: 'list', required: false },
];

/** Builtins are ordinary v2 cards: the same parser and runtime authorization apply. */
function preset(value: Omit<Card, 'schemaVersion' | 'version' | 'digest'>): Card {
  return parseCard(serializeCard({ ...value, schemaVersion: 2, version: '1.0.0', digest: '', model: value.model ?? { role: 'standard' }, derivation: { allowed: true }, members: [] }), { toolNames: hostToolNames });
}

// Keep the published 1.0.0 definitions unchanged: persisted card identities include their digest.
const builtinCardsV1: Card[] = [
  preset({
    id: 'kodo/explorer', name: 'Explorer', description: 'Locate relevant files and explain existing behavior with source evidence.',
    catalog: { path: 'engineering/exploration', aliases: ['探索', '定位', '阅读', 'investigation'] },
    routing: { use_when: ['Read across unfamiliar modules, locate behavior and identify integration points.'], not_for: ['Editing files or running commands.'], mode: 'read' },
    tools: readTools, constraints: { permissions: ['read'], scope: { write: [] } },
    inputs: [{ name: 'question', kind: 'text', required: true, description: 'The specific question to answer from the repository.' }, { name: 'entry_files', kind: 'paths', required: false }],
    report: [{ name: 'findings', kind: 'list', required: true }, { name: 'evidence', kind: 'paths', required: true }, { name: 'open_questions', kind: 'list', required: true }],
    model: { role: 'fast' },
    prompt: 'Read only the material needed to answer the supplied question. Trace callers and relevant tests when they clarify behavior. Report verified facts separately from hypotheses, cite file paths, and state what remains unknown. Do not edit files or execute commands.',
  }),
  preset({
    id: 'kodo/tester', name: 'Tester', description: 'Write regression tests for an already agreed behavior contract.',
    catalog: { path: 'engineering/testing', aliases: ['测试', '回归', 'regression'] },
    routing: { use_when: ['Implement regression coverage after the main agent has fixed the intended behavior and interfaces.'], not_for: ['Deciding an unresolved product contract or changing production behavior.'], mode: 'write' },
    tools: writeTools, constraints: { permissions: ['read', 'write', 'exec'], scope: { write: ['${project.tests}'] } },
    inputs: [{ name: 'behavior_contract', kind: 'artifact', required: true, description: 'The immutable interface and behavior contract shared with the implementer.' }, { name: 'entry_files', kind: 'paths', required: false }],
    report: changeReport,
    prompt: 'Read the behavior_contract artifact before designing tests. Cover observable behavior and meaningful ordinary boundary cases with the existing test tools. Stay within the assigned test roots. If the contract is incomplete, report a contract request rather than inventing behavior. Reference actual check calls and disclose failures or unrun checks.',
  }),
  preset({
    id: 'kodo/reviewer', name: 'Reviewer', description: 'Review implementation evidence and run only host-approved verification.',
    catalog: { path: 'engineering/review', aliases: ['评审', '审查', 'review'] },
    routing: { use_when: ['Inspect a completed change against its contract and report actionable correctness issues.'], not_for: ['Editing the implementation or executing arbitrary commands.'], mode: 'review' },
    tools: [...readTools, 'verify.run'], constraints: { permissions: ['read', 'exec'], scope: { write: [] } },
    inputs: [{ name: 'contract', kind: 'artifact', required: false }, { name: 'entry_files', kind: 'paths', required: false }],
    report: [{ name: 'findings', kind: 'list', required: true }, { name: 'checks', kind: 'calls', required: true }, { name: 'open_issues', kind: 'list', required: true }],
    model: { role: 'strong' },
    prompt: 'Read the assigned code and contract without the author’s conversational history. Review behavior and evidence, including meaningful failure conditions, and report concrete findings with paths. Use only verify.run for host-approved checks; no arbitrary process execution or workspace edits. An empty findings list does not establish acceptance: disclose inspection coverage and unrun checks.',
  }),
  preset({
    id: 'kodo/implementer', name: 'Implementer', description: 'Implement a bounded module against an agreed contract.',
    catalog: { path: 'engineering/implementation', aliases: ['实现', '开发', 'module'] },
    routing: { use_when: ['Implement a separable module with explicit file ownership and agreed interfaces.'], not_for: ['Unbounded repository-wide changes or unresolved shared interfaces.'], mode: 'write' },
    tools: writeTools, constraints: { permissions: ['read', 'write', 'exec'] },
    inputs: [{ name: 'requirement', kind: 'text', required: true }, { name: 'contract', kind: 'artifact', required: true }, { name: 'entry_files', kind: 'paths', required: false }],
    report: changeReport,
    prompt: 'Implement the supplied requirement and contract only within the explicit write roots assigned at spawn. Read before editing. Keep interfaces consistent with the agreed artifact, use existing project conventions, and run focused checks. Report requested contract changes instead of modifying shared boundaries implicitly. Include changed files, actual check calls and unresolved issues.',
  }),
  preset({
    id: 'kodo/frontend', name: 'Frontend engineer', description: 'Implement accessible pages, components, styling and interaction.',
    catalog: { path: 'engineering/frontend', aliases: ['前端', '界面', '页面', 'UI'] },
    routing: { use_when: ['Implement or modify web pages, components, visual hierarchy and interaction.'], not_for: ['Backend interfaces or database migrations.'], mode: 'write' },
    tools: [...writeTools, 'image.read'], constraints: { permissions: ['read', 'write', 'exec'], scope: { write: ['web'] } },
    inputs: [{ name: 'requirement', kind: 'text', required: true }, { name: 'contract', kind: 'artifact', required: true }, { name: 'entry_files', kind: 'paths', required: false }],
    report: changeReport,
    prompt: 'Follow the supplied design and interface contract and the project’s existing components. Keep layout responsive, labels clear and keyboard behavior accessible. Verify appearance using available visual evidence and state which visual checks were unavailable. Restrict edits to the assigned frontend roots and report any interface changes needed from another owner.',
  }),
  preset({
    id: 'kodo/backend', name: 'Backend engineer', description: 'Implement service behavior, interfaces and data handling in a bounded backend area.',
    catalog: { path: 'engineering/backend', aliases: ['后端', '接口', '服务', 'API'] },
    routing: { use_when: ['Implement service endpoints, application logic, data contracts and error handling.'], not_for: ['Frontend visual design or changes outside the assigned server roots.'], mode: 'write' },
    tools: writeTools, constraints: { permissions: ['read', 'write', 'exec'], scope: { write: ['server'] } },
    inputs: [{ name: 'requirement', kind: 'text', required: true }, { name: 'contract', kind: 'artifact', required: true }, { name: 'entry_files', kind: 'paths', required: false }],
    report: changeReport,
    prompt: 'Implement the agreed interface and behavior contract using existing server conventions. Make data validation and failure responses explicit, preserve transaction boundaries, and avoid unrelated schema or architectural changes. Verify observable behavior with focused checks and disclose unverified dependencies or requested contract changes.',
  }),
];

/** Previous implementation cards remain registered for frozen rosters and explicit version references. */
export const legacyBuiltinCards: Card[] = builtinCardsV1.filter(card => card.routing?.mode === 'write');

/** Current rosters use the shell-capable implementation presets without replacing published cards. */
export const builtinAgentCards: Card[] = builtinCardsV1.map(card => card.routing?.mode === 'write'
  ? parseCard(serializeCard({ ...card, version: '1.1.0', tools: [...card.tools, 'shell.exec'] }), { toolNames: hostToolNames })
  : card);

/** Factor A adds these references to a copy of the main card; the original v1 default remains unchanged. */
export const defaultMemberReferences: CardReference[] = builtinAgentCards.slice(0, 4).map(({ id, version, digest }) => ({ id, version, digest }));

const compactWriteTools = [...readTools, 'file.patch', 'file.apply_patch', 'shell.exec', 'workspace.commit'];
const compactMethods: Record<string, string> = {
  'kodo/explorer': 'Answer only the supplied question, starting at the given files and symbols. Read a supplied contract artifact with artifact.read. Return confirmed findings, their source paths, and unresolved questions. Stop when the question is answered; broaden the search only for a concrete missing dependency or contradiction. Do not edit files or run commands.',
  'kodo/reviewer': 'Review the supplied change against the authoritative contract and specified risk questions. Read contract artifacts with artifact.read. Start from provided diff, changed files and existing check evidence; request a missing diff instead of pretending source reads establish the change. Use verify.run only for approved checks. Do not turn a bounded review into a repository-wide audit. Return concrete findings, inspected scope, check references and unverified items; a short output is not a claim of exhaustive coverage.',
  'kodo/tester': 'Use the supplied observable behavior as the single contract; read behavior_contract with artifact.read when provided. Write meaningful independent tests within assigned roots, map results to the supplied scenarios, and disclose uncovered cases. Missing behavior is a question, not permission to invent a second specification. Run relevant checks and report actual check references, changed files and remaining gaps.',
  'kodo/implementer': 'Own the assigned implementation and its focused checks. Start from supplied entry points; read a supplied contract with artifact.read. Keep implementation design local to this task, read current files before editing and preserve agreed interfaces. Expand exploration only for a concrete missing dependency or contradiction. Use managed command handles; wait for other tasks through coordination rather than shell polling. Report changed files, actual check references, requested contract changes and remaining gaps. Stop when the requested behavior and required evidence are delivered.',
  'kodo/frontend': 'Implement the assigned UI with the existing components and supplied design constraints. Read a supplied contract artifact with artifact.read. Keep accessible interactions and responsive layout, use available visual evidence, and report unavailable checks. Own implementation and focused verification; return changed files, actual check references and unresolved interface requests.',
  'kodo/backend': 'Implement the assigned service behavior using existing conventions and transaction boundaries. Read a supplied contract artifact with artifact.read. Preserve agreed interfaces, test relevant ordinary failure paths, and disclose unverified dependencies. Own implementation and focused checks; return changed files, check references and unresolved contract requests.',
};

/** Compact rosters are opt-in per persisted session; published 1.0/1.1 cards remain available. */
export const compactBuiltinAgentCards: Card[] = builtinAgentCards.map(card => parseCard(serializeCard({
  ...card, version: '1.2.0', prompt: compactMethods[card.id]!,
  tools: card.routing?.mode === 'write' ? [...compactWriteTools, ...(card.id === 'kodo/frontend' ? ['image.read'] : [])] : card.tools,
  // The required objective already carries a bounded task. Artifacts are useful for
  // shared contracts, but forcing one for every small task creates needless handoffs.
  inputs: card.inputs?.map(input => ({ ...input, required: card.id === 'kodo/explorer' && input.name === 'question' })),
}), { toolNames: hostToolNames }));

/** New sessions use ordinary task results and recorded calls, without a mandatory report ceremony. */
export const simpleBuiltinAgentCards: Card[] = compactBuiltinAgentCards.map(card => {
  return parseCard(serializeCard({
    ...card, version: '1.3.0', report: undefined,
    tools: card.routing?.mode === 'write'
      ? [...readTools, 'file.patch', 'file.apply_patch', 'file.mkdir', 'file.rename', 'file.delete', 'shell.exec', 'workspace.commit', ...(card.id === 'kodo/frontend' ? ['image.read'] : [])]
      : card.tools,
    prompt: `${card.prompt} Return a concise final result with changed or inspected paths, actual check-call references and unresolved gaps. Reuse existing output when its code, inputs and environment still apply; do not rerun checks just to obtain a summary.`,
  }), { toolNames: hostToolNames });
});
