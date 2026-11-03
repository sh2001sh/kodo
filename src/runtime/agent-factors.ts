/** Orthogonal experimental factors. Old sessions without flags retain baseline behavior. */
export interface AgentFactors { A?: boolean; B?: boolean; C?: boolean; D?: boolean; E?: boolean }
export function normalizeAgentFactors(flags?: AgentFactors): Required<AgentFactors> {
  return { A: flags?.A === true, B: flags?.B === true, C: flags?.C === true, D: flags?.D === true, E: flags?.E === true };
}

/** Fresh-child black-box review guidance shared by the factor and default prompts. */
export const reviewGuidance = 'For independent review, start a fresh child with the artifact paths, the change under review and the acceptance checks, not the implementer’s conclusions; inspect its original evidence before accepting.';

/** New sessions assemble independent policy paragraphs; legacy rendering below stays byte-stable. */
export function parallelMainGuidance(flags?: AgentFactors, taskProtocol: 1 | 2 | 3 = 2, toolProfile?: import('./types.js').Session['toolProfile']): string {
  const factors = normalizeAgentFactors(flags);
  return [
    'You are the main agent. Only you can spawn/cancel children and ask the user. Own delivery and acceptance.',
    'Read enough to establish the task boundaries, critical constraints and starting files, then execute or delegate; do not design the entire implementation first or restate a plan on every request. Keep small bounded tasks direct and coupled implementation with its checks under one owner.',
    'Delegate independent work when parallel execution, expertise or a separate context outweighs handoff and acceptance cost. Children receive the task packet, not your conversation. Pass known facts, entry points, unresolved questions and the evidence sufficient to stop. While children work, perform independent work allowed by task ownership; wait only when blocked. Do not wait for another owner through shell sleep or file polling.',
    factors.B ? 'For substantial work, keep a concise todo list with a current revision. Independent items may be in_progress together. Read the current revision before changing the plan, and inspect delivered evidence before marking a delegated item complete. Todo state is planning guidance, not a dispatch machine or an acceptance record.' : '',
    factors.C ? 'Delegate whole independent outcomes to children that inherit your card and permissions; they may only narrow them. Use a fresh child for independent black-box review. Keep the workspace contract and acceptance evidence explicit.' : '',
    reviewGuidance,
    taskProtocol === 3
      ? 'Use the bounded result and recorded check evidence in completion notifications first; inspect_run section="acceptance" expands missing details, with call_ids for several calls at once. Reuse checks only while their code, environment and inputs still apply. A single integration owner verifies the assembled result. Finish when the requested behavior and required checks are satisfied; further changes require a concrete unmet requirement, not a cleaner report.'
      : 'Inspect a delivered result with inspect_run section="acceptance" first. It bundles existing check evidence; expand missing details with call_ids for several calls at once. Reuse checks only while their code, environment and inputs still apply. A single integration owner verifies the assembled result. Finish after required evidence is accepted; do not recreate evidence or rerun unchanged checks solely to package a report.',
    factors.D ? 'For handoff, use context/inputs or a shared artifact to carry confirmed findings and their sources. Children cannot inspect sibling runs; copy the relevant findings. Keep one authoritative contract rather than rewriting it for each owner.' : '',
    toolProfile === 'compact-v2'
      ? 'Keep the complete local coding loop: execute ordinary commands, diffs, tests and version-control operations directly when authorized. Do not create a child solely to run a command. Delegate whole independent outcomes with their focused checks, and do not duplicate the owner’s implementation design. Long commands use managed background handles; collect their actual exit and output with process.read.'
      : factors.E ? 'Command and specialist tools are assigned to equipped children in this session. Include necessary execution and version-control operations in their bounded task. You retain native file work, coordination, user questions and any host-approved process.run checks.' : '',
  ].filter(Boolean).join(' ');
}

/** Transform main-role guidance at rendering time, preserving registered cards and disabled-factor bytes. */
export function applyAgentFactors(text: string, flags?: AgentFactors): string {
  const factors = normalizeAgentFactors(flags);
  const mainRules = text.includes('You are the main agent.');
  if (factors.B) text = text
    .replace('You are the main agent.', 'You are the team lead. Understand the user goal and project, plan the work, and coordinate teammates.')
    .replace('Own delivery and acceptance.', 'Own delivery and acceptance. Read only enough to establish project boundaries, constraints and acceptance criteria. Start each request with a brief plan of the steps and their dependencies. For substantial work, use todo.read/todo.write to record the plan before execution. Keep one main phase in_progress when a list has open work; todo state is planning guidance, not permission and not acceptance. Choose how many teammates to start and reuse when executing that phase.')
    .replace('Use explore for read-only investigation that needs three or more files or an unfamiliar directory, produces large read output, takes repeated searching to locate something, or splits into independent questions that can run in parallel. When the path is known and one or two reads answer the question, read it directly instead.', 'Choose delegation when parallel work, specialist expertise or a separate context outweighs handoff and acceptance costs. Execute small bounded tasks directly, including implementation and verification. Answer simple questions directly when the required facts are already available. Keep coupled implementation and its checks with one owner. Delegate substantial separable work; parallelize independent work and start dependent steps only after prerequisites are ready. You may dispatch within granted permissions and user instructions without waiting for the user to request each delegation.')
    .replace('Use spawn_agent only to change independent modules with disjoint write scopes;', 'Use spawn_agent for asynchronous read, review or implementation tasks; a fresh child has none of your history, while fork_of continues a settled child with its exact context. Parallel writes require disjoint scopes and agreed interfaces;')
    .replace('Keep working while spawned children run and wait only when blocked, without polling.', 'While teammates work, resolve dependencies and inspect delivered evidence. Pass already-established facts and relevant file locations in the handoff to avoid repeating orientation. Wait when no useful independent work is ready, without polling. Respect user restrictions on delegation. If delegation is blocked, explain the constraint and explicitly replan ownership.')
    .replace('Workers check modules; main owns latest integration; avoid duplicate global checks.', 'Have each owner deliver the implementation and actual check-call references together. Inspect results and failed attempts with inspect_run; use its call_id and pagination to read existing output before requesting new evidence. Rerun checks when code changed, evidence is missing or a concrete concern requires it. Do not rerun unchanged checks or create evidence copies, backup directories or cleanup follow-ups solely to package a report. After acceptance, finish. Small direct tasks need no task list. While a task list has open work, keep a todo in_progress before a native file mutation or process launch. Do not spend a step only to mark todos completed before the final answer. Reads and coordination remain available. Avoid duplicate global checks.')
;
  if (factors.C) text = text.replace('give each child objective, inputs, constraints and acceptance checks, because children share the workspace but not your history.', 'supply the task, necessary context and expected result. Children inherit your card and permissions and may only narrow them. Children share the workspace but not your history. For independent review, use a fresh child with the artifact paths and acceptance checks, not your conclusions.');
  if (factors.D && mainRules) text += ` ${reviewGuidance}`;
  if (factors.E) {
    text = text.replace('Use image.read for local visual evidence and configured LSP tools for code navigation. web.fetch requires explicit host network authorization; shell.exec requires exec and uses the host process policy. ', 'Delegate visual evidence, web access and LSP work to a suitably equipped child. ');
    if (mainRules) text += ' Execution and specialist tools are assigned to children in this session. Delegate command work together with implementation and verification to an implementation agent; include required git branch/commit operations in its acceptance. You retain native file tools, coordination, ask_user and host-declared process.run checks.';
  }
  return text;
}
