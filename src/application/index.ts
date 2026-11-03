import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { compactDefaultCard, leanDefaultCard, simpleDefaultCard, defaultCard, parseCard, validateCard } from '../agents/card.js';
import { RunCoordinator } from '../runtime/coordinator.js';
import { defaultBudget, KodoError, terminal } from '../runtime/types.js';
import { resolveModelLimits, validateModelBinding } from '../providers/model-limits.js';
import { discoverModelLimits } from '../providers/model-discovery.js';
import { defaultCompactionPolicy, followUpContext, initialContext, updateTaskProgress, validateAssemblyPolicy, validateCompactionPolicy } from '../runtime/context.js';
import { inspectContextReport } from '../runtime/context-inspection.js';
import { normalizeFileScope, resolveScopeVariables } from '../runtime/scope.js';
import { validateDeliverables } from '../runtime/deliverables.js';
import { initialInstructions, instructionMessage, recordInstructions, runInstructionCapacity } from '../runtime/instruction-layer.js';
import { defaultGlobalInstructions } from '../runtime/project-instructions.js';
import type { Budget, Card, CompletionValidator, Deliverable, Envelope, FileScope, Message, ModelBinding, ModelResponse, Permission, Provider, ResolvedModelLimits, Run, RuntimeEvent, Session, ToolRecoveryVerifier, ToolRequest, Wait } from '../runtime/types.js';
import type { ReadOnlyCommand } from '../tools/index.js';
import { builtinToolNames, runProcess } from '../tools/index.js';
import { prepareRunOutput } from '../runtime/run-output.js';
import { ToolRegistry } from '../tools/registry.js';
import { hostToolNames } from '../tools/catalog.js';
import type { ToolRegistration } from '../tools/registry.js';
import type { RecoveryOutcome, RecoveryPlan } from '../runtime/recovery.js';
import { Store, digest } from '../storage/index.js';
import type { Page, PageOptions, SubscriberError } from '../storage/index.js';
import { ModelProvider } from '../providers/index.js';
import { connectMcp, skillTools } from '../extensions/index.js';
import { methodCatalogDigest, withCardMethods } from '../extensions/methods.js';
import { roleAllows } from '../runtime/role-view.js';
import type { McpConfig, McpConnection, Skill } from '../extensions/index.js';
import { carryRecoveryTodo, todoTools } from '../tools/todo.js';
import { lspTools } from '../tools/lsp.js';
import type { LspOptions } from '../tools/lsp.js';
import { createWebFetchTool } from '../tools/webfetch.js';
import type { WebFetchPolicy } from '../tools/webfetch.js';
import type { SandboxPolicy } from '../sandbox/index.js';
import { activatePackage as activatePackageResources } from '../packages/runtime.js';
import type { PackageActivationOptions, PackageHost } from '../packages/runtime.js';
import type { InstalledPackage } from '../packages/schema.js';
import { ProjectKnowledge } from '../knowledge/index.js';
import { knowledgeTools } from '../knowledge/tools.js';
import { memoryTools } from '../tools/memory.js';
import { createVerificationTool } from '../tools/verify.js';
import type { VerificationPolicy } from '../tools/verify.js';
import type { HookRegistration } from '../runtime/hooks.js';
import { rewindRun } from '../runtime/rewind.js';
import { validateAgentModelPolicy } from '../messaging/spawn-spec.js';
import type { SpawnAgentRequest } from '../messaging/spawn-spec.js';
import { prepareInstructionContext } from '../runtime/instruction-layer.js';
import { attachment } from '../runtime/attachments.js';
import type { AgentFactors } from '../runtime/agent-factors.js';
import { runWorkspace } from '../runtime/execution-workspace.js';
import { isLeanProfile } from '../runtime/tool-view.js';
import { assertSessionCompatible } from '../runtime/session-compat.js';

export interface CreateRunOptions { objective: string; workspace: string; binding: ModelBinding; permissions?: Permission[]; scope?: FileScope; budget?: Partial<Budget>; card?: Card; finalResponse?: 'required' | 'optional'; toolChoice?: 'none'; deliverables?: Deliverable[]; team?: SpawnAgentRequest[] | ((main: Run) => SpawnAgentRequest[]) }
export interface ApplicationOptions {
  agentFactors?: AgentFactors;
  /** Frozen for new sessions; absent in saved sessions preserves legacy task association. */
  taskProtocol?: 1 | 2 | 3;
  /** Default programming tool view; custom cards retain their declared capabilities. */
  toolProfile?: Session['toolProfile'];
  projectRoots?: Record<string, string[]>;
  modelRoles?: Partial<Record<'fast' | 'standard' | 'strong', string>>;
  /** Conditional capacity protection enabled by default; false explicitly disables model-generated summaries. */
  compaction?: import('../runtime/context.js').CompactionPolicy | false;
  /** Experimental deterministic evidence selection; never adds a model call. */
  assembly?: import('../runtime/context.js').AssemblyPolicy;
  readOnlyCommands?: ReadOnlyCommand[];
  tools?: ToolRegistration[];
  skills?: readonly Skill[];
  /** Experimental card methods through skill.load, using only existing run capabilities. */
  inlineMethods?: boolean;
  /** Disable only for the marking-only ablation; enabled by default with inline methods. */
  methodUnloading?: boolean;
  methodToolView?: 'stable' | 'active';
  modelBindings?: Record<string, ModelBinding>;
  modelBindingDescriptions?: Record<string, string>;
  onSubscriberError?: (failure: SubscriberError) => void;
  sandbox?: SandboxPolicy;
  shellProgram?: string;
  webFetch?: WebFetchPolicy;
  lsp?: LspOptions;
  /** Enabled by default; false disables exploration and knowledge. Private knowledge is bound to this owner and workspace. */
  exploration?: boolean | { ownerId?: string };
  /** Opt into the exploration workflow and its structured exploration.plan tool. Default false; requires exploration not to be disabled. */
  structuredExploration?: boolean;
  /** Opt into the exploration workflow and suggest explore after this many successful main-run reads (evaluated value: 8). Default false. */
  exploreNudge?: number | false;
  /** Project instruction discovery. `global` defaults to `$KODO_HOME/AGENTS.md` or `~/.kodo/AGENTS.md`; false disables it. */
  instructions?: { global?: string | false };
  /** Cross-process write lock directory; defaults to `$KODO_HOME/locks` or `~/.kodo/locks`; false keeps write locks in-process. */
  lockDirectory?: string | false;
  /** Opt-in project memory; loaded instructions still cannot grant capabilities. */
  memory?: boolean;
  /** Opt-in schema discovery when tool descriptions exceed 5% of input capacity. */
  lazyTools?: boolean;
  hooks?: readonly HookRegistration[];
  verification?: VerificationPolicy;
}
export interface RunSnapshot {
  run: Run; session: Session; runs: (Run & { stale: boolean })[];
  calls: import('../runtime/types.js').Call[]; events: RuntimeEvent[]; messages: Envelope[];
  waits: Wait[]; questions: Envelope[]; decisions: { version: number; content: string }[];
}

export class Application {
  readonly store: Store;
  readonly coordinator: RunCoordinator;
  private readonly agentFactors: Required<AgentFactors>;
  private readonly taskProtocol: 1 | 2 | 3;
  private readonly toolProfile: NonNullable<Session['toolProfile']>;
  private readonly projectRoots: Record<string, string[]>;
  private readonly modelRoles: Partial<Record<'fast' | 'standard' | 'strong', string>>;
  private readonly modelBindings?: Record<string, ModelBinding>;
  private readonly modelBindingDescriptions?: Record<string, string>;
  private registeredToolNames = new Set<string>();
  private registeredSkillIds = new Set<string>();
  private readonly skills = new Map<string, Skill>();
  private readonly inlineMethods: boolean;
  private readonly methodUnloading: boolean;
  private readonly methodToolView: 'stable' | 'active';
  private skillDefinitions: ToolRegistration[] = [];
  private mcpConnections = new Set<McpConnection>();
  private readonly packageActivations = new Map<string, { workspace: string; workspaceBound: boolean; context: string; names: string[]; skills: string[]; bindings: Record<string, string> }>();
  private readonly sandboxPolicy?: SandboxPolicy;
  private readonly structuredExploration: boolean;
  private readonly globalInstructions: string | false;
  private readonly projectMemory: boolean;
  private readonly lockDirectory?: string | false;
  private readonly optionalTools: string[];
  get defaultCard(): Card {
    // Builtin cards are gone with the roster; profile selection over the five
    // immutable default variants remains until 1e converges them.
    return this.legacyDefaultCard;
  }
  private get legacyDefaultCard(): Card {
    // Explicit exploration workflows keep their complete capability set. Ordinary
    // compact sessions do not acquire the knowledge catalog just because storage exists.
    const explorationWorkflow = this.structuredExploration || this.coordinator.exploreNudge !== false;
    const base = isLeanProfile(this.toolProfile) ? leanDefaultCard : !explorationWorkflow && this.toolProfile !== 'full' ? (this.toolProfile === 'compact-v2' ? simpleDefaultCard : compactDefaultCard) : this.coordinator.knowledge ? explorationMainCard(this.structuredExploration) : defaultCard;
    if (!this.optionalTools.length) return base;
    const tools = [...new Set([...base.tools, ...this.optionalTools])];
    return parseCard(`---\nschema_version: 1\nid: ${base.id}-${this.optionalTools.map(name => name.split('.')[0]).join('-')}\nversion: ${base.version}\nname: ${base.name}\ndescription: Host-configured local agent with optional capabilities.\n${base.nudges === undefined ? '' : `nudges: ${base.nudges}\n`}capabilities:\n  tools: ${JSON.stringify(tools)}\n---\n${base.prompt}\nUse verify.run for the host-approved verification command when available. Project memory stores concise reusable decisions, never credentials.`, { toolNames: tools });
  }
  get packageResources(): SandboxPolicy['resources'] { return this.sandboxPolicy?.resources ? structuredClone(this.sandboxPolicy.resources) : undefined; }
  constructor(directory: string, provider: Provider = new ModelProvider(), onText?: (id: string, text: string) => void, options: ApplicationOptions = {}) {
    const compaction = options.compaction === false ? undefined : options.compaction ?? { ...defaultCompactionPolicy };
    validateCompactionPolicy(compaction);
    validateAssemblyPolicy(options.assembly);
    if (options.taskProtocol !== undefined && ![1, 2, 3].includes(options.taskProtocol)) throw new KodoError('TASK_PROTOCOL', 'taskProtocol must be 1, 2 or 3');
    if (options.toolProfile !== undefined && !['compact-v1', 'compact-v2', 'full', 'lean-solo'].includes(options.toolProfile)) throw new KodoError('TOOL_PROFILE', 'toolProfile must be compact-v1, compact-v2, full or lean-solo');
    if (isLeanProfile(options.toolProfile) && options.taskProtocol !== undefined && options.taskProtocol !== 3) throw new KodoError('TASK_PROTOCOL', 'lean profiles require taskProtocol 3');
    this.taskProtocol = options.taskProtocol ?? 3;
    this.toolProfile = options.toolProfile ?? 'compact-v2';
    this.inlineMethods = options.inlineMethods ?? false;
    this.methodUnloading = options.methodUnloading ?? true;
    this.methodToolView = options.methodToolView ?? 'stable';
    if (!['stable', 'active'].includes(this.methodToolView) || options.methodToolView !== undefined && !this.inlineMethods) throw new KodoError('METHOD_CONFIG', 'methodToolView requires inlineMethods and stable or active');
    if (options.methodUnloading !== undefined && (typeof options.methodUnloading !== 'boolean' || !this.inlineMethods)) throw new KodoError('METHOD_CONFIG', 'methodUnloading requires inlineMethods and a boolean');
    if (options.inlineMethods !== undefined && typeof options.inlineMethods !== 'boolean' || this.inlineMethods && isLeanProfile(this.toolProfile)) throw new KodoError('METHOD_CONFIG', 'inlineMethods requires a boolean and a Skill-capable full/compact tool profile');
    if (options.agentFactors !== undefined && (!options.agentFactors || typeof options.agentFactors !== 'object' || Array.isArray(options.agentFactors) || Object.entries(options.agentFactors).some(([key, value]) => !['A', 'B', 'C', 'D', 'E'].includes(key) || typeof value !== 'boolean'))) throw new KodoError('AGENT_FACTORS', 'agentFactors accepts boolean A, B, C, D and E flags');
    if (options.exploreNudge !== undefined && options.exploreNudge !== false && (!Number.isSafeInteger(options.exploreNudge) || options.exploreNudge < 1)) throw new KodoError('DELEGATION_POLICY', 'exploreNudge must be a positive integer or false');
    if (compaction?.workInputTokens !== undefined && options.assembly?.workInputTokens !== undefined && compaction.workInputTokens !== options.assembly.workInputTokens) throw new KodoError('CONTEXT_POLICY', 'assembly and compaction must use the same explicit workInputTokens');
    validateAgentModelPolicy(options.modelBindings, options.modelBindingDescriptions, options.modelRoles);
    if (options.verification?.backend === 'native' && options.verification.enabled && options.verification.approved && !options.sandbox) throw new KodoError('VERIFY_SANDBOX', 'native verification requires an explicitly configured host OS sandbox');
    this.store = new Store(directory, { onSubscriberError: options.onSubscriberError });
    this.sandboxPolicy = options.sandbox ? structuredClone(options.sandbox) : undefined;
    this.structuredExploration = options.structuredExploration === true;
    this.globalInstructions = options.instructions?.global ?? defaultGlobalInstructions();
    this.projectMemory = options.memory === true;
    this.lockDirectory = options.lockDirectory;
    this.optionalTools = [...(this.projectMemory ? ['memory.write'] : []), ...(options.verification?.enabled && options.verification.approved ? ['verify.run'] : []),
      ...(this.toolProfile !== 'full' && options.webFetch?.enabled ? ['web.fetch'] : []),
      ...(this.toolProfile !== 'full' && options.lsp?.servers.length ? ['lsp.hover', 'lsp.definition', 'lsp.references', 'lsp.symbols', 'lsp.diagnostics'] : [])];
    this.agentFactors = { A: options.agentFactors?.A ?? true, B: options.agentFactors?.B ?? true, C: options.agentFactors?.C ?? true, D: options.agentFactors?.D ?? true, E: options.agentFactors?.E ?? true };
    this.projectRoots = structuredClone(options.projectRoots ?? {});
    try { for (const roots of Object.values(this.projectRoots)) normalizeFileScope({ write: roots }); }
    catch (error) { this.store.close(); throw error; }
    this.modelRoles = structuredClone(options.modelRoles ?? {});
    this.modelBindings = options.modelBindings === undefined ? undefined : structuredClone(options.modelBindings);
    this.modelBindingDescriptions = options.modelBindingDescriptions === undefined ? undefined : structuredClone(options.modelBindingDescriptions);
    try {
      const knowledge = options.exploration !== false || this.inlineMethods ? new ProjectKnowledge(this.store, typeof options.exploration === 'object' ? options.exploration : {}) : undefined;
      this.coordinator = new RunCoordinator(this.store, provider, onText, options.readOnlyCommands, { modelBindings: structuredClone(options.modelBindings ?? {}), ...(options.sandbox ? { sandbox: structuredClone(options.sandbox) } : {}), shellProgram: options.shellProgram, knowledge, structuredExploration: this.structuredExploration, compaction, assembly: options.assembly, exploreNudge: options.exploreNudge, globalInstructions: this.globalInstructions, hooks: options.hooks, lazyTools: options.lazyTools, ...(options.lockDirectory === undefined ? {} : { lockDirectory: options.lockDirectory }) });
      for (const definition of todoTools(this.store, { cancelQueued: (runId, parentId) => this.coordinator.cancel(runId, { initiator: 'agent', by: parentId }) })) this.registerTool(definition);
      if (knowledge) for (const definition of knowledgeTools(knowledge, this.inlineMethods)) this.registerTool(definition);
      for (const definition of memoryTools(this.store, { enabled: this.projectMemory })) this.registerTool(definition);
      if (options.verification) this.registerTool(createVerificationTool(options.verification, options.verification.backend === 'native' && this.sandboxPolicy ? async (context, invocation, signal) => {
        const workspace = runWorkspace(this.store, context.run);
        const privatePath = path.relative(workspace, this.store.directory);
        if (!privatePath) throw new KodoError('SANDBOX_CONFIG', 'verification workspace cannot be the private runtime data directory');
        const privateInside = privatePath !== '..' && !privatePath.startsWith(`..${path.sep}`) && !path.isAbsolute(privatePath);
        const output = await prepareRunOutput(this.store, context.run.id);
        return await runProcess(invocation.program, invocation.args, workspace, context.run.binding.apiKeyEnv, signal, {
          env: output.env,
          sandbox: { ...this.sandboxPolicy!, workspace, scope: context.run.scope,
            write: context.session.permissions.includes('write') && (context.run.permissions ?? context.session.permissions).includes('write'),
            deny: privateInside ? [privatePath] : [],
            outputDirectory: output.directory,
          },
        });
      } : undefined));
      this.registerTool(createWebFetchTool(options.webFetch ?? { enabled: false }));
      for (const definition of lspTools({ servers: [], sandbox: options.sandbox, ...options.lsp, runtimeDirectory: this.store.directory })) this.registerTool(definition);
      for (const definition of options.tools ?? []) this.registerTool(definition);
      if (options.skills || this.inlineMethods) this.registerSkills(options.skills ?? []);
    }
    catch (error) { this.store.close(); throw error; }
  }
  /** Host registration grants no model access until the run's immutable card allows the tool. */
  registerTool(definition: ToolRegistration): void {
    if (definition.recover) this.coordinator.recovery.assertCanRegisterVerifier(definition.name, definition.recover);
    this.coordinator.tools.register(definition);
    if (definition.recover) this.coordinator.recovery.registerVerifier(definition.name, definition.recover);
    this.registeredToolNames.add(definition.name);
  }
  registerRecoveryVerifier(name: string, verifier: ToolRecoveryVerifier): void { this.coordinator.recovery.registerVerifier(name, verifier); }
  parseCard(content: string): Card { return parseCard(content, { toolNames: [...builtinToolNames, ...hostToolNames, ...this.registeredToolNames], skillIds: [...this.registeredSkillIds] }); }
  registerCard(card: Card): void {
    this.validateCardRegistration(card);
    this.store.registerCard(card);
  }
  /** Explicit host publication; registering a global card alone does not change a session. */
  updateSessionMethods(runId: string, change: { expectedDigest: string; install?: Card[]; disable?: string[] }): { digest: string } {
    const run = this.store.run(runId), session = this.store.session(run.sessionId);
    if (!session.inlineMethods || run.parentId) throw new KodoError('METHOD_CONFIG', 'session method installation requires an enabled main run');
    if (this.store.listRuns(session.id).filter(owner => !owner.parentId).some(owner => this.store.calls(owner.id).some(call => call.status === 'running'))) throw new KodoError('METHOD_BUSY', 'publish methods at a model/tool boundary; interrupt the main run before installing');
    const before = session.methodCards ?? [];
    const beforeDigest = methodCatalogDigest(before);
    if (beforeDigest !== change.expectedDigest) throw new KodoError('ROSTER_CHANGED', 'read the current method catalog digest before publication');
    const cards = change.install ?? [];
    if (!cards.length && !change.disable?.length) return { digest: beforeDigest };
    if (new Set(cards.map(card => card.id)).size !== cards.length) throw new KodoError('METHOD_CONFIG', 'install each card ID at most once');
    if (change.disable?.some(id => !before.some(ref => ref.id === id) && !cards.some(card => card.id === id))) throw new KodoError('METHOD_CONFIG', 'cannot disable an unknown session method');
    for (const card of cards) this.validateCardRegistration(card);
    const tools = [...new Set([...(session.methodTools ?? run.card.tools), ...cards.flatMap(card => [...card.tools, ...(card.mcp ?? []).flatMap(server => server.tools.map(tool => `mcp.${server.server}.${tool}`))])])];
    const skills = [...new Set([...(session.methodSkills ?? run.card.skills ?? []), ...cards.flatMap(card => card.skills ?? [])])];
    const bindings = this.coordinator.tools.bindingSnapshot(tools, skills);
    for (const [name, version] of Object.entries(run.toolBindings ?? {})) if (bindings[name] !== undefined && bindings[name] !== version) throw new KodoError('CAPABILITY_CHANGED', 'existing resource bindings must remain pinned during method installation');
    const next = before.filter(ref => !cards.some(card => card.id === ref.id) && !change.disable?.includes(ref.id));
    for (const card of cards) {
      if (!card.execution?.modes.includes('inline')) throw new KodoError('METHOD_CONFIG', 'session method installation requires inline compatibility');
      if (!change.disable?.includes(card.id)) next.push({ id: card.id, version: card.version, digest: card.digest });
    }
    const nextDigest = methodCatalogDigest(next);
    this.store.transaction(() => {
      const current = this.store.session(session.id);
      if (methodCatalogDigest(current.methodCards) !== change.expectedDigest) throw new KodoError('ROSTER_CHANGED', 'method catalog changed during preparation');
      for (const card of cards) this.store.registerCard(card);
      this.store.putSession({ ...current, methodCards: next, methodTools: tools, methodSkills: skills });
      for (const owner of this.store.listRuns(session.id).filter(owner => !owner.parentId)) this.store.updateRun(owner.id, { toolBindings: { ...owner.toolBindings, ...bindings } });
      this.store.putMessage({ id: `methods:${session.id}:${nextDigest}`, sessionId: session.id, from: 'runtime', to: run.id, kind: 'notice', content: `Session method catalog revised to ${nextDigest}. Use skill.list to discover the current versions. The active stage remains pinned to its original version.` });
      this.store.event(run.id, 'agent.methods.revised', { previous: before, digest: nextDigest, installed: cards.map(card => ({ id: card.id, version: card.version, digest: card.digest })), disabled: change.disable ?? [] });
    });
    return { digest: nextDigest };
  }
  private validateCardRegistration(card: Card): void {
    if (card.schemaVersion === 2 || card.execution) {
      const known = new Set<string>([...builtinToolNames, ...hostToolNames, ...this.registeredToolNames]);
      if (card.tools.some(name => !known.has(name))) throw new KodoError('CARD_SCHEMA', 'card references an unknown tool');
      validateCard(card, { toolNames: [...known], skillIds: [...this.registeredSkillIds] });
    } else {
      this.coordinator.tools.bindingSnapshot(card.tools, card.skills ?? []);
      if (card.skills?.some(id => !this.registeredSkillIds.has(id))) throw new KodoError('SKILL_UNAVAILABLE', 'register the required skills before registering this card');
    }
  }
  /** Skill IDs are immutable; adding unrelated skills does not change existing run contracts. */
  registerSkills(skills: readonly Skill[]): void {
    const prepared = this.prepareSkills(skills);
    this.preflightTools(prepared.tools);
    for (const definition of prepared.tools) this.registerTool(definition);
    this.commitSkills(prepared.skills);
  }
  private prepareSkills(skills: readonly Skill[]): { skills: Skill[]; tools: ToolRegistration[] } {
    const snapshots = skills.map(skill => Object.freeze({ ...skill }));
    skillTools(snapshots); // Validate detached values before changing the append-only catalog.
    for (const skill of snapshots) if (this.skills.has(skill.id)) throw new KodoError('SKILL_REGISTERED', 'register each immutable skill ID only once per application');
    if (this.skills.size || this.skillDefinitions.length) return { skills: snapshots, tools: [] };
    const definitions = skillTools([]).map((definition, index): ToolRegistration => ({ ...definition,
      version: digest(this.inlineMethods ? 'kodo-append-only-skill-catalog/inline-v2' : 'kodo-append-only-skill-catalog/v1'),
      execute: (context, args) => this.skillDefinitions[index]!.execute(context, args),
    }));
    return { skills: snapshots, tools: definitions };
  }
  private commitSkills(skills: readonly Skill[]): void {
    this.coordinator.tools.registerSkillIdentities(skills);
    for (const skill of skills) { this.skills.set(skill.id, skill); this.registeredSkillIds.add(skill.id); }
    const definitions = skillTools([...this.skills.values()]);
    this.skillDefinitions = this.inlineMethods ? withCardMethods(this.store, definitions, (run, session) => this.coordinator.tools.specs([...new Set([...run.card.tools, ...(session.methodTools ?? [])])], { ...session, permissions: run.permissions ?? session.permissions }).filter(tool => roleAllows(run, session, tool.name)).map(tool => tool.name)) : definitions;
  }
  /** Stage all resources, then commit the complete package after every connection and collision check passes. */
  async activatePackage(installed: InstalledPackage, options: PackageActivationOptions): Promise<Card> {
    installed = structuredClone(installed);
    const { signal, verifyExamples, ...declarations } = options;
    options = { ...structuredClone(declarations), ...(signal ? { signal } : {}), ...(verifyExamples ? { verifyExamples } : {}) };
    const ceilings = this.sandboxPolicy?.resources;
    if (ceilings) options = { ...options, resources: {
      ...options.resources,
      ...(ceilings.memoryBytes === undefined ? {} : { memoryBytes: Math.min(ceilings.memoryBytes, options.resources?.memoryBytes ?? Infinity) }),
      ...(ceilings.maxProcesses === undefined ? {} : { maxProcesses: Math.min(ceilings.maxProcesses, options.resources?.maxProcesses ?? Infinity) }),
    } };
    const workspace = realpathSync(options.workspace);
    const privateRelative = path.relative(workspace, this.store.directory);
    const privateInside = privateRelative !== '..' && !privateRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(privateRelative);
    if (privateInside && !privateRelative) throw new KodoError('SANDBOX_CONFIG', 'package workspace cannot be the runtime data directory');
    options = { ...options, workspace, privatePaths: [...(options.privatePaths ?? []), this.store.directory] };
    const environment = [...new Set(Object.values(options.bindings?.mcp ?? {}).flatMap(binding => [...Object.values(binding.headers ?? {}), ...Object.values(binding.env ?? {})].map(reference => reference.env)))].sort().map(name => [name, digest(process.env[name] ?? '')]);
    const context = digest(JSON.stringify({ bindings: options.bindings ?? null, scope: options.scope ?? null, deny: [...(options.deny ?? [])].sort(), privatePaths: [...options.privatePaths!].sort(), stdio: options.stdio ?? null, resources: options.resources ?? null, preparedRoot: options.preparedRoot ?? null, preparedDigest: options.preparedDigest ?? null, environment }));
    const previous = this.packageActivations.get(installed.digest);
    if (previous) {
      if (previous.workspaceBound && previous.workspace !== workspace) throw new KodoError('PACKAGE_WORKSPACE', '此能力包的 stdio MCP 已绑定原工作区，不能在同一 Application 中复用于另一个案例目录；现有会话绑定保持不变。');
      if (previous.context !== context) throw new KodoError('PACKAGE_BINDING_CONFLICT', '此能力包已按另一组宿主配置激活；不能替换当前 Application 中固定的工具、Skill 或 MCP 绑定。');
      const bindings = this.coordinator.tools.bindingSnapshot(previous.names, previous.skills);
      if (JSON.stringify(bindings) !== JSON.stringify(previous.bindings)) throw new KodoError('CAPABILITY_CHANGED', 'previously activated package contracts no longer match');
      // Recheck source files, prepared dependencies and explicit examples. Registration
      // remains append-only: identical resources keep their original callbacks/connection.
      return await activatePackageResources({
        registerTool: () => {}, registerSkills: () => {}, registerCard: card => this.store.registerCard(card),
        connectMcp: async config => Object.keys(config.tools).map(name => `mcp.${config.id}.${name}`),
      }, installed, options);
    }
    const tools: ToolRegistration[] = [];
    const skills: Skill[] = [];
    const cards: Card[] = [];
    const connections: McpConnection[] = [];
    let workspaceBound = false;
    const host: PackageHost = {
      registerTool: tool => { tools.push(tool); },
      registerSkills: batch => { skills.push(...batch); },
      registerCard: card => { cards.push(card); },
      preflightPackage: resources => {
        workspaceBound = resources.mcp.some(server => server.transport === 'stdio');
        const prepared = resources.skills.length ? this.prepareSkills(resources.skills) : { skills: [], tools: [] };
        const mcp = resources.mcp.flatMap(server => Object.entries(server.tools).map(([name, policy]): ToolRegistration => ({
          name: `mcp.${server.id}.${name}`, description: policy.description ?? 'Package MCP capability',
          permission: policy.permission, effect: policy.effect, parameters: { type: 'object' }, execute: () => null,
        })));
        this.preflightTools([...resources.tools, ...prepared.tools, ...mcp]);
        try {
          const existing = this.store.card(resources.card.id, resources.card.version);
          if (existing.digest !== resources.card.digest) throw new KodoError('CARD_CONFLICT', 'same card ID and version has different content');
        } catch (error) {
          if (!(error instanceof KodoError) || error.code !== 'CARD_NOT_FOUND') throw error;
        }
      },
      connectMcp: async (config, signal) => {
        const connection = await connectMcp(this.protectMcpStore(config), { signal });
        connections.push(connection); tools.push(...connection.tools);
        return connection.tools.map(tool => tool.name);
      },
    };
    try {
      const card = await activatePackageResources(host, installed, options);
      options.signal?.throwIfAborted();
      const prepared = skills.length ? this.prepareSkills(skills) : { skills: [], tools: [] };
      const definitions = this.preflightTools([...tools, ...prepared.tools]);
      const available = new Set([...builtinToolNames, ...this.registeredToolNames, ...definitions.map(tool => tool.name)]);
      const availableSkills = new Set([...this.registeredSkillIds, ...prepared.skills.map(skill => skill.id)]);
      for (const staged of cards) {
        if (staged.tools.some(name => !available.has(name))) throw new KodoError('CAPABILITY_CHANGED', 'package card references an unavailable tool');
        if (staged.skills?.some(id => !availableSkills.has(id))) throw new KodoError('SKILL_UNAVAILABLE', 'package card references an unavailable skill');
      }
      // Persisted identity conflicts must fail before any in-memory registration is made.
      this.store.transaction(() => { for (const staged of cards) this.store.registerCard(staged); });
      for (const definition of definitions) this.registerTool(definition);
      if (skills.length) this.commitSkills(prepared.skills);
      for (const connection of connections) this.mcpConnections.add(connection);
      const names = definitions.map(tool => tool.name), skillIds = skills.map(skill => skill.id);
      if (names.length || skillIds.length || connections.length) this.packageActivations.set(installed.digest, { workspace, workspaceBound, context, names, skills: skillIds, bindings: this.coordinator.tools.bindingSnapshot(names, skillIds) });
      return card;
    } catch (error) {
      const closed = await Promise.allSettled(connections.map(connection => connection.close()));
      const failures = closed.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length) throw new AggregateError([error, ...failures.map(result => result.reason)], 'package activation failed and MCP cleanup failed', { cause: error });
      throw error;
    }
  }
  /** Endpoints, processes and tool policies come only from trusted host configuration. */
  async connectMcp(config: McpConfig, signal?: AbortSignal): Promise<string[]> {
    const connection = await connectMcp(this.protectMcpStore(config), { signal });
    try {
      // Preflight the complete set so a collision cannot leave half a server registered.
      this.preflightTools(connection.tools);
      for (const tool of connection.tools) this.registerTool(tool);
      this.mcpConnections.add(connection);
      return connection.tools.map(tool => tool.name);
    } catch (error) { await connection.close(); throw error; }
  }
  private protectMcpStore(config: McpConfig): McpConfig {
    if (config.transport !== 'stdio' || !config.sandbox) return config;
    const workspace = realpathSync(config.sandbox.workspace);
    const relative = path.relative(workspace, this.store.directory);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return config;
    if (!relative) throw new KodoError('SANDBOX_CONFIG', 'MCP workspace cannot be the runtime data directory');
    return { ...config, sandbox: { ...config.sandbox, deny: [...(config.sandbox.deny ?? []), relative] } };
  }
  private preflightTools(definitions: readonly ToolRegistration[]): ToolRegistration[] {
    const registry = new ToolRegistry([...builtinToolNames, ...this.registeredToolNames]);
    for (const definition of definitions) {
      registry.register(definition);
      if (definition.recover) this.coordinator.recovery.assertCanRegisterVerifier(definition.name, definition.recover);
    }
    return registry.definitions();
  }
  updateProgress(runId: string, progress: Parameters<typeof updateTaskProgress>[2]): ReturnType<typeof updateTaskProgress> {
    return this.store.transaction(() => {
      const snapshot = updateTaskProgress(this.store, runId, progress);
      if (snapshot.knowledge_uses?.length) {
        if (!this.coordinator.knowledge) throw new KodoError('KNOWLEDGE_DISABLED', 'project knowledge is not enabled by this host');
        this.coordinator.knowledge.adopt(runId, snapshot.knowledge_uses);
      }
      return snapshot;
    });
  }
  /** Synchronous creation uses declared/catalog limits or clearly marked provisional limits. */
  createRun(options: CreateRunOptions): Run { return this.createResolvedRun(options); }
  /** Host and model delegates share the same transaction, scope checks and child budget. */
  spawnAgent(sessionId: string, request: SpawnAgentRequest): Run {
    assertSessionCompatible(this.store, this.store.session(sessionId));
    const active = this.store.listRuns(sessionId).filter(run => !run.parentId && !terminal(run.status) && !run.cancelRequested);
    if (active.length !== 1) throw new KodoError('SPAWN_PARENT', active.length ? 'session has multiple active main runs; resolve the continuation before spawning' : 'session has no active main run; start a follow-up before spawning');
    const parent = active[0]!;
    if (parent.status === 'interrupted') throw new KodoError('SPAWN_PARENT', 'resume the interrupted main run before spawning');
    const result = this.coordinator.mailbox.spawnHost(parent.id, request);
    return this.store.run(String(result.id));
  }
  /** CLI and hosts can discover endpoint-specific metadata before persisting a session. */
  async createRunWithDiscovery(options: CreateRunOptions, signal?: AbortSignal): Promise<Run> {
    return this.createResolvedRun(options, await discoverModelLimits(options.binding, options.budget, signal));
  }
  private createResolvedRun(options: CreateRunOptions, discovered?: ResolvedModelLimits): Run {
    if (!options.objective.trim() || options.objective.length > 32_000) throw new KodoError('OBJECTIVE', 'provide a nonempty task of at most 32000 characters');
    if (options.finalResponse !== undefined && !['required', 'optional'].includes(options.finalResponse)) throw new KodoError('DELIVERY_CONTRACT', 'finalResponse must be required or optional');
    const deliverables = options.deliverables === undefined ? undefined : validateDeliverables(options.deliverables);
    const workspace = realpathSync(options.workspace);
    if (!statSync(workspace).isDirectory()) throw new KodoError('WORKSPACE', 'workspace must be a directory');
    const nullable = new Set(['maxTokens', 'maxModelCalls', 'maxToolCalls', 'maxDurationMs', 'maxContextChars', 'maxChildren']);
    const cachePercent = options.budget?.cacheReadCostPercent;
    if (cachePercent !== undefined && (!Number.isSafeInteger(cachePercent) || cachePercent < 0 || cachePercent > 100)) throw new KodoError('BUDGET', 'cacheReadCostPercent must be an integer from 0 to 100');
    for (const [field, value] of Object.entries(options.budget ?? {})) if (field !== 'cacheReadCostPercent' && !(value === null && nullable.has(field)) && (!Number.isSafeInteger(value) || value! <= 0)) throw new KodoError('BUDGET', 'limits must be positive safe integers; optional session limits may be null');
    if (options.toolChoice !== undefined && options.toolChoice !== 'none') throw new KodoError('TOOL_CHOICE', 'host toolChoice must be none when specified');
    validateModelBinding(options.binding);
    const modelLimits = discovered ?? resolveModelLimits(options.binding, options.budget);
    const context = options.budget?.maxContextTokens ?? modelLimits.context;
    const budget: Budget = { ...defaultBudget, maxContextTokens: context, maxOutputTokens: Math.min(modelLimits.output, context - 1), ...options.budget };
    if (budget.maxContextTokens < 2 || budget.maxOutputTokens < 1 || budget.maxOutputTokens >= budget.maxContextTokens) throw new KodoError('BUDGET', 'context must be at least 2 tokens and output at least 1; output reservation must leave room for input in the model token window');
    if (budget.maxContextTokens > modelLimits.context || budget.maxOutputTokens > modelLimits.output) throw new KodoError('BUDGET', 'requested context/output exceeds known model limits; declare endpoint-specific binding.limits instead');
    let permissions = options.permissions ?? ['read'];
    if (permissions.some(x => !['read', 'write', 'exec'].includes(x))) throw new KodoError('PERMISSIONS', 'unknown permission');
    const card = options.card ?? this.defaultCard;
    const projectRoots = structuredClone(this.projectRoots);
    if (card.constraints?.permissions) permissions = permissions.filter(permission => card.constraints!.permissions!.includes(permission));
    if (card.routing?.mode === 'read') permissions = permissions.filter(permission => permission === 'read');
    if (card.routing?.mode === 'review') permissions = permissions.filter(permission => permission !== 'write');
    const sessionId = randomUUID();
    const createdAt = new Date().toISOString();
    const runId = randomUUID();
    const cardScope = card.constraints?.scope ? resolveScopeVariables(card.constraints.scope, projectRoots) : undefined;
    const modeScope = card.routing?.mode === 'read' || card.routing?.mode === 'review' ? { ...cardScope, write: [] } : cardScope;
    const scope = options.scope || modeScope ? normalizeFileScope(options.scope ?? {}, modeScope) : undefined;
    if (card.skills?.some(id => !this.registeredSkillIds.has(id))) throw new KodoError('SKILL_UNAVAILABLE', 'register the required skills before creating this run');
    const materializedTools = [...new Set([...card.tools, ...(card.mcp ?? []).flatMap(server => server.tools.map(name => `mcp.${server.server}.${name}`)), ...(card.skills?.length || this.inlineMethods ? ['skill.list', 'skill.load'] : []), ...(this.inlineMethods ? ['artifact.write', 'knowledge.browse', 'knowledge.search', 'knowledge.read', 'knowledge.publish'] : [])])];
    const executableCard = card.schemaVersion === 2 || this.inlineMethods ? { ...card, tools: materializedTools.filter(name => card.routing?.mode === 'read' || card.routing?.mode === 'review' ? this.coordinator.tools.permission(name) === 'read' || (card.routing.mode === 'review' && name === 'verify.run') : true) } : card;
    const toolBindings = this.coordinator.tools.bindingSnapshot(executableCard.tools, executableCard.skills ?? []);
    const run: Run = { id: runId, sessionId, objective: options.objective, status: 'queued', card: executableCard, binding: options.binding, modelLimits, scope, toolBindings, contextRef: this.store.blob([]), step: 0, cancelRequested: false, decisionVersion: 0, finalResponse: options.finalResponse, ...(options.toolChoice ? { toolChoice: options.toolChoice } : {}), ...(deliverables ? { deliverables } : {}), createdAt };
    this.store.transaction(() => {
      this.validateCardRegistration(card);
      this.store.registerCard(card);
      const session: Session = { id: sessionId, workspace, permissions, budget, modelLimits, agentFactors: this.agentFactors, taskProtocol: this.taskProtocol, toolProfile: this.toolProfile, projectRoots, modelRoles: structuredClone(this.modelRoles), ...(this.modelBindings === undefined ? {} : { modelBindings: structuredClone(this.modelBindings) }), ...(this.modelBindingDescriptions === undefined ? {} : { modelBindingDescriptions: structuredClone(this.modelBindingDescriptions) }), modelBudgetCeilings: { ...(options.budget?.maxContextTokens !== undefined ? { maxContextTokens: options.budget.maxContextTokens } : {}), ...(options.budget?.maxOutputTokens !== undefined ? { maxOutputTokens: options.budget.maxOutputTokens } : {}) }, tokens: 0, modelCalls: 0, toolCalls: 0, usageEstimated: false, decisionVersion: 0, createdAt };
      if (this.inlineMethods) { session.inlineMethods = true; session.methodUnloading = this.methodUnloading; session.methodToolView = this.methodToolView; session.methodTools = executableCard.tools; session.methodSkills = executableCard.skills ?? []; session.methodCards = []; }
      this.store.putSession(session);
      this.store.putRun(run);
      const prepared = prepareInstructionContext(this.store, run, session, { global: this.globalInstructions, memory: this.projectMemory });
      run.contextRef = this.store.blob(prepared.messages);
      run.instructions = prepared.instructions;
      this.store.updateRun(run.id, { contextRef: run.contextRef, instructions: run.instructions });
      this.store.event(run.id, 'run.queued', { objective: options.objective, card: { id: card.id, version: card.version, digest: card.digest } });
      const team = typeof options.team === 'function' ? options.team(structuredClone(run)) : options.team ?? [];
      if (!Array.isArray(team)) throw new KodoError('AGENT_TEAM', 'team must return a synchronous list of spawn requests');
      for (const request of team) this.spawnAgent(sessionId, request);
    });
    return run;
  }
  run(runId: string): Promise<Run> {
    assertSessionCompatible(this.store, this.store.session(this.store.run(runId).sessionId));
    return this.coordinator.drive(runId);
  }
  /** Trusted host validation; callbacks must be reattached after reopening the data directory. */
  setCompletionValidator(runId: string, validator: CompletionValidator): void { this.coordinator.setCompletionValidator(runId, validator); }
  reconcile(runId: string, signal?: AbortSignal): Promise<RecoveryPlan> { return this.coordinator.recovery.inspect(runId, signal); }
  resolveCall(runId: string, callId: string, options: { outcome: RecoveryOutcome; evidence: string; retry?: boolean }): RecoveryPlan;
  resolveCall(callId: string, outcome: 'applied' | 'not_applied', evidence: string): RecoveryPlan;
  resolveCall(first: string, second: string, third: { outcome: RecoveryOutcome; evidence: string; retry?: boolean } | string): RecoveryPlan {
    if (typeof third === 'string') {
      if (!['applied', 'not_applied'].includes(second)) throw new KodoError('RECOVERY_OUTCOME', 'expected applied or not_applied');
      return this.coordinator.recovery.resolve(this.store.call(first).runId, first, { outcome: second === 'applied' ? 'succeeded' : 'not_applied', evidence: third, retry: false });
    }
    return this.coordinator.recovery.resolve(first, second, third);
  }
  rewind(runId: string, toStep: number) {
    return rewindRun(this.store, runId, toStep, { lockDirectory: this.lockDirectory, assertIdle: () => {
      if (this.coordinator.busy || this.coordinator.tools.hasPendingEffects()) throw new KodoError('REWIND_ACTIVE', 'stop active execution before rewinding workspace files');
    } });
  }
  recover(runId: string): Promise<Run> {
    const target = this.store.run(runId);
    assertSessionCompatible(this.store, this.store.session(target.sessionId));
    if (this.coordinator.busy) throw new KodoError('RECOVERY_ACTIVE', 'stop active execution before recovery');
    if (terminal(target.status) && !(target.status === 'failed' && target.error?.startsWith('UNKNOWN_WRITE:'))) throw new KodoError('NOT_INTERRUPTED', 'terminal records remain immutable');
    const recovered = this.store.events(runId, { types: ['recovery.continued'] })[0];
    if (recovered) throw new KodoError('ALREADY_RECOVERED', `recovery already created run ${String(recovered.data.runId)}; inspect or resume that run`);
    const runs = this.store.listRuns(target.sessionId).filter(x => x.status === 'interrupted');
    this.store.transaction(() => { for (const run of runs) this.coordinator.classifyRecovery(run.id); });
    const sources = this.store.listRuns(target.sessionId).filter(run => (run.status === 'interrupted' || (run.status === 'failed' && run.error?.startsWith('UNKNOWN_WRITE:')) || (run.status === 'cancelled' && this.store.calls(run.id).some(call => call.kind === 'tool' && call.effect === 'write' && ['unknown', 'running'].includes(call.status)))));
    const plans = sources.map(run => this.coordinator.recovery.plan(run.id));
    if (plans.some(plan => plan.blocked.length)) throw new KodoError('UNKNOWN_WRITE', 'a write may have completed without a recorded result; reconcile or provide verification evidence before resume');
    let resumedId = runId;
    // Validate and requeue all interrupted peers before any one of them can start side effects.
    this.store.transaction(() => {
      const replacements = new Map<string, string>();
      for (const plan of plans) if (plan.requiresContinuation && !this.store.hasEvent(plan.sourceRunId, { types: ['recovery.continued'] })) {
        const source = this.store.run(plan.sourceRunId);
        const id = randomUUID();
        const requested = plan.pendingModelCallId ? plan.calls.find(call => call.id === plan.pendingModelCallId) : undefined;
        const pending = requested?.status === 'succeeded' ? requested : plan.calls.findLast(call => call.kind === 'model' && call.status === 'succeeded' && call.purpose !== 'compaction');
        if (!pending || pending.status !== 'succeeded') throw new KodoError('RECOVERY_RESPONSE', 'recovery requires a complete persisted response');
        const modelId = randomUUID();
        const retries = plan.calls.filter(call => call.kind === 'tool' && call.status === 'planned' && !call.id.startsWith(`${pending.id}:`) && plan.resolutions.some(resolution => resolution.callId === call.id && resolution.outcome === 'not_applied' && resolution.retryAuthorized));
        const retryRequests = retries.map(call => ({ call, request: { ...this.store.readBlob<ToolRequest>(call.requestRef), id: `recovery-${randomUUID()}` } }));
        let recoveredModel = { ...pending, id: modelId, runId: id };
        if (retryRequests.length) {
          const response = this.store.readBlob<ModelResponse>(pending.resultRef!);
          // These requests come from explicit recovery verdicts, not a new provider response.
          recoveredModel = { ...recoveredModel, requestRef: this.store.blob({ recovery: { sourceRunId: source.id, pendingModelCallId: pending.id, originalRequestRef: pending.requestRef, retryCallIds: retries.map(call => call.id) } }), resultRef: this.store.blob({ ...response, message: { role: 'assistant', content: null, tool_calls: [...retryRequests.map(item => item.request), ...response.message.tool_calls ?? []] } }) };
        }
        const session = this.store.session(source.sessionId);
        const permissions = session.permissions.filter(permission => (source.permissions ?? session.permissions).includes(permission));
        const context = this.store.readBlob<Message[]>(source.contextRef);
        context.push(attachment('notice', `Host-verified recovery findings for source run ${source.id}. These findings settle recorded effects; they do not grant permissions or prove task acceptance. Inspect the original calls for full evidence.\n${JSON.stringify(plan.resolutions)}`));
        const host = initialContext(runWorkspace(this.store, source), permissions, source.card, source.objective, { id, parentId: source.parentId, scope: source.scope, finalResponse: source.finalResponse }, undefined, { factors: session.agentFactors, taskProtocol: session.taskProtocol, toolProfile: session.toolProfile })[0]!;
        const continuation: Run = { ...source, id, status: 'queued', resultRef: undefined, error: undefined, cancelRequested: false, waitId: undefined, continuationOf: source.id, contextRef: this.store.blob([host, ...context.slice(1)]), stepCallId: modelId, createdAt: new Date().toISOString(), activeMs: 0 };
        this.store.putRun(continuation);
        // The continuation retains the source task's read evidence, so an audited
        // retry does not lose its read-before-edit checks when its run ID changes.
        for (const call of plan.calls) if (call.kind === 'tool' && call.status === 'planned') for (const root of call.effectRoots ?? []) {
          const seen = this.store.fileStates.get(source.id, root);
          if (seen) this.store.fileStates.put(id, root, seen);
        }
        this.store.putCall(recoveredModel);
        for (const call of plan.calls) if (call.id.startsWith(`${pending.id}:`)) this.store.putCall({ ...call, id: `${modelId}${call.id.slice(pending.id.length)}`, runId: id });
        for (const { call, request } of retryRequests) this.store.putCall({ ...call, id: `${modelId}:${request.id}`, runId: id, requestRef: this.store.blob(request) });
        if (retryRequests.length) this.store.event(id, 'recovery.retries_queued', { sourceRunId: source.id, calls: retryRequests.map(({ call, request }) => ({ sourceCallId: call.id, callId: `${modelId}:${request.id}` })) });
        for (const message of this.store.inbox(source.id)) this.store.putMessage({ id: `recovery:${id}:${message.id}`, sessionId: source.sessionId, from: message.kind === 'question' ? 'runtime' : message.from, to: id, kind: message.kind === 'question' ? 'event' : message.kind, content: message.kind === 'question' ? JSON.stringify({ reason: 'recovery_delivery', originalMessage: message, note: 'This is the original pending question, not a new question. Answer using originalMessage.id as reply_to.' }) : message.content, ...(message.replyTo ? { replyTo: message.replyTo } : {}), ...(message.artifacts ? { artifacts: message.artifacts } : {}) });
        this.store.event(source.id, 'recovery.continued', { runId: id });
        this.store.event(id, 'run.queued', { continuationOf: source.id, reason: 'verified effect recovery; source terminal records remain immutable' });
        replacements.set(source.id, id);
        if (source.id === runId) resumedId = id;
      }
      for (const peer of this.store.listRuns(target.sessionId)) if ( !terminal(peer.status)) {
        const parentId = peer.parentId ? replacements.get(peer.parentId) : undefined;
        if (parentId) {
          const session = this.store.session(peer.sessionId);
          const permissions = session.permissions.filter(permission => (peer.permissions ?? session.permissions).includes(permission));
          const context = this.store.readBlob<Message[]>(peer.contextRef);
          const host = initialContext(runWorkspace(this.store, peer), permissions, peer.card, peer.objective, { id: peer.id, parentId, scope: peer.scope }, undefined, { factors: session.agentFactors, taskProtocol: session.taskProtocol, toolProfile: session.toolProfile })[0]!;
          this.store.updateRun(peer.id, { parentId, contextRef: this.store.blob([host, ...context.slice(1)]) });
          this.store.event(peer.id, 'recovery.reparented', { previousParentId: peer.parentId!, parentId });
        }
        if (replacements.size) this.store.putMessage({ id: `recovery-map:${resumedId}:${peer.id}`, sessionId: peer.sessionId, from: 'runtime', to: peer.id, kind: 'event', content: JSON.stringify({ reason: 'verified recovery created replacement runs; coordinate with these current IDs and review their completion before reporting', replacements: Object.fromEntries(replacements) }) });
      }
      for (const [sourceId, targetId] of replacements) carryRecoveryTodo(this.store, sourceId, targetId, replacements);
      for (const run of runs) this.coordinator.prepareResume(run.id);
    });
    return this.run(resumedId);
  }
  submitInput(runId: string, content: string, options: { mode?: 'steer' | 'follow_up'; decision?: boolean } = {}): Run {
    if (!content.trim() || content.length > 16_000) throw new KodoError('INPUT', 'input must contain 1 to 16000 characters');
    return this.store.transaction(() => {
      let run = this.store.run(runId);
      if (run.parentId) throw new KodoError('INPUT_TARGET', 'user input must target a main run');
      const session = this.store.session(run.sessionId);
      assertSessionCompatible(this.store, session);
      if (terminal(run.status) || options.mode === 'follow_up') {
        const id = randomUUID();
        const permissions = session.permissions.filter(x => (run.permissions ?? session.permissions).includes(x));
        const source = run;
        run = { id, sessionId: source.sessionId, objective: content, status: 'queued', card: source.card, binding: source.binding, modelLimits: source.modelLimits, modelBindingId: source.modelBindingId, scope: source.scope, toolBindings: source.toolBindings, permissions, continuationOf: source.id, historyFrom: source.id, finalResponse: source.finalResponse, ...(source.toolChoice ? { toolChoice: source.toolChoice } : {}), contextRef: '', step: 0, cancelRequested: false, decisionVersion: session.decisionVersion ?? 0, createdAt: new Date().toISOString() };
        const instructions = initialInstructions(runWorkspace(this.store, run), { global: this.globalInstructions, capacityBytes: runInstructionCapacity(run, session), scope: run.scope, inherited: source.instructions, trigger: 'follow_up',
          ...(source.instructions?.tokenBudget === undefined ? {} : { capacityTokens: Math.max(0, source.instructions.tokenBudget - (source.instructions.reservedTokens ?? 0)) }) });
        run.instructions = instructions.state;
        run.contextRef = this.store.blob(followUpContext(this.store, source, run, instructionMessage(instructions.chain, 'follow_up')));
        this.store.putRun(run);
        this.store.event(id, 'run.queued', { continuationOf: run.continuationOf });
        recordInstructions(this.store, id, 'follow_up', instructions.chain);
      }
      if (options.decision) this.recordDecision(run, content);
      else {
        this.store.putMessage({ id: randomUUID(), sessionId: run.sessionId, from: 'user', to: run.id, kind: 'input', content });
        this.coordinator.mailbox.refresh(run.id);
      }
      return this.store.run(run.id);
    });
  }
  /** A user instruction to a directly managed child; the main run is notified in the same commit so both agree. */
  submitAgentInput(mainRunId: string, agentRunId: string, content: string): { messageId: string; agent: Run; main: Run } {
    if (!content.trim() || content.length > 16_000) throw new KodoError('INPUT', 'input must contain 1 to 16000 characters');
    return this.store.transaction(() => {
      const main = this.store.run(mainRunId);
      if (main.parentId) throw new KodoError('MAIN_RUN', 'directed input must be anchored to a main run');
      const agent = this.store.run(agentRunId);
      if (agent.sessionId !== main.sessionId) throw new KodoError('SESSION_DENIED', 'directed input target must belong to the main run session');
      if (agent.parentId !== main.id) throw new KodoError('AGENT_TARGET', 'directed input target must be a direct child of the main run');
      if (terminal(agent.status) || (agent.status === 'interrupted' && !agent.interruptRequested)) throw new KodoError('RUN_ENDED', `child run ${agent.id} has ended; send a follow-up task to the main run instead`);
      const messageId = randomUUID();
      this.store.putMessage({ id: messageId, sessionId: agent.sessionId, from: 'user', to: agent.id, kind: 'input', content });
      // The notice is coordination evidence, not a new user decision: decisionVersion, grants, scope, card and budget stay unchanged.
      this.store.putMessage({ id: randomUUID(), sessionId: main.sessionId, from: 'user', to: main.id, kind: 'notice', content: `Directed instruction from the user to child agent ${agent.id} (objective: ${agent.objective}):\n${content}\nAlign your coordination with this instruction; do not issue a conflicting requirement to that child.` });
      this.store.event(agent.id, 'user.agent_input', { messageId, mainRunId: main.id, content });
      this.store.event(main.id, 'user.agent_input', { messageId, agentRunId: agent.id, objective: agent.objective, content });
      if (agent.interruptRequested) this.coordinator.resumeInterrupted(agent.id);
      this.coordinator.mailbox.refresh(agent.id);
      return { messageId, agent: this.store.run(agent.id), main: this.store.run(main.id) };
    });
  }
  /** Cancel a directly managed child; terminal targets are returned unchanged so retries stay idempotent. */
  cancelAgent(mainRunId: string, agentRunId: string): Run {
    const main = this.store.run(mainRunId);
    if (main.parentId) throw new KodoError('MAIN_RUN', 'agent cancellation must be anchored to a main run');
    const agent = this.store.run(agentRunId);
    if (agent.sessionId !== main.sessionId) throw new KodoError('SESSION_DENIED', 'cancellation target must belong to the main run session');
    if (agent.parentId !== main.id) throw new KodoError('AGENT_TARGET', 'cancellation target must be a direct child of the main run');
    if (!terminal(agent.status)) this.coordinator.cancel(agent.id);
    return this.store.run(agent.id);
  }
  /** Pause only the child's current turn; a subsequent message can continue its context. */
  interruptAgent(mainRunId: string, agentRunId: string): Run {
    const main = this.store.run(mainRunId);
    const agent = this.store.run(agentRunId);
    if (main.parentId || agent.sessionId !== main.sessionId || agent.parentId !== main.id) throw new KodoError('AGENT_TARGET', 'interrupt target must be a directly managed child in this session');
    this.coordinator.interrupt(agent.id);
    return this.store.run(agent.id);
  }
  answer(questionId: string, content: string, options: { decision?: boolean } = {}): Run {
    if (!content.trim() || content.length > 16_000) throw new KodoError('INPUT', 'answer must contain 1 to 16000 characters');
    return this.store.transaction(() => {
      const question = this.store.message(questionId);
      if (!question || question.to !== 'user' || question.kind !== 'question') throw new KodoError('QUESTION', 'user question not found');
      const run = this.coordinator.mailbox.recoveryTarget(this.store.run(question.from));
      if (terminal(run.status)) throw new KodoError('RUN_ENDED', 'question belongs to a terminal run; submit new input to create a continuation');
      const previous = this.store.answer(question.id);
      if (previous) {
        if (previous.content !== content) throw new KodoError('ANSWER_CONFLICT', 'question already has a different answer');
        return run;
      }
      this.store.putMessage({ id: `answer:${questionId}`, sessionId: run.sessionId, from: 'user', to: run.id, kind: 'answer', content, replyTo: questionId });
      if (options.decision) this.recordDecision(run, content);
      this.coordinator.mailbox.refresh(run.id);
      return this.store.run(run.id);
    });
  }
  private recordDecision(run: Run, content: string): void {
    const session = this.store.session(run.sessionId);
    const version = (session.decisionVersion ?? 0) + 1;
    this.store.putDecision(session.id, version, content);
    this.store.putSession({ ...session, decisionVersion: version });
    this.store.event(run.id, 'decision.updated', { version, content });
    for (const peer of this.store.listRuns(session.id)) if ( !terminal(peer.status)) {
      // A queued exploration or explore child must not begin work for a superseded decision.
      if ((peer.exploration || peer.explore) && ['queued', 'running'].includes(peer.status) && peer.step === 0 && !peer.stepCallId) {
        this.coordinator.cancel(peer.id, { initiator: 'decision', by: run.id });
        continue;
      }
      this.store.putMessage({ id: `decision:${session.id}:${version}:${peer.id}`, sessionId: session.id, from: 'user', to: peer.id, kind: 'decision', content: JSON.stringify({ version, content }) });
      this.coordinator.mailbox.refresh(peer.id);
    }
  }
  updatePermissions(runId: string, permissions: Permission[]): Run {
    return this.store.transaction(() => {
      const run = this.store.run(runId);
      if (run.parentId || terminal(run.status)) throw new KodoError('PERMISSIONS', 'change permissions on an active main run');
      const session = this.store.session(run.sessionId);
      if (permissions.some(x => !session.permissions.includes(x)) || new Set(permissions).size !== permissions.length) throw new KodoError('PERMISSION_ESCALATION', 'runtime permission updates can only revoke existing grants');
      this.store.putSession({ ...session, permissions });
      this.recordDecision(run, `User revoked permissions. Effective session grants: ${permissions.join(', ') || 'none'}.`);
      this.coordinator.revokeSession(session.id);
      return this.store.run(runId);
    });
  }
  snapshot(runId: string): RunSnapshot {
    const run = this.store.run(runId);
    const session = this.store.session(run.sessionId);
    return { run, session, runs: this.store.listRuns(session.id).map(x => ({ ...x, stale: (x.decisionVersion ?? 0) < (session.decisionVersion ?? 0) })), calls: this.store.calls(run.id), events: this.store.events(run.id), messages: this.store.messages(session.id), waits: this.store.waits(session.id), questions: this.coordinator.mailbox.userQuestions(session.id), decisions: this.store.decisions(session.id) };
  }
  context(runId: string) { return this.coordinator.contextSnapshot(runId); }
  /** C0 cross-run aggregation for every run in the run's session; read-only, no model call. */
  contextReport(runId: string) { return inspectContextReport(this.store, this.store.run(runId)); }
  runs(options: PageOptions & { sessionId?: string; status?: Run['status'] } = {}): Page<Run> { return this.store.runsPage(options); }
  sessions(options: PageOptions = {}): Page<Session> { return this.store.sessionsPage(options); }
  calls(runId: string, options: PageOptions = {}): Page<import('../runtime/types.js').Call> { this.store.run(runId); return this.store.callsPage(runId, options); }
  events(options: PageOptions & { sessionId?: string; runId?: string } = {}): Page<RuntimeEvent> { return this.store.eventsPage(options); }
  messages(sessionId: string, options: PageOptions & { recipient?: string } = {}): Page<Envelope> { this.store.session(sessionId); return this.store.messagesPage(sessionId, options); }
  async shutdown(): Promise<void> {
    await this.coordinator.shutdown();
    const connections = [...this.mcpConnections];
    this.mcpConnections.clear();
    const results = await Promise.allSettled(connections.map(connection => connection.close()));
    this.close();
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
  close(): void {
    if (this.coordinator.busy) throw new KodoError('RUNTIME_ACTIVE', 'await application.shutdown() before closing an active runtime');
    if (this.coordinator.tools.hasPendingEffects()) throw new KodoError('RUNTIME_ACTIVE', 'a cancelled host write callback is still running; wait for it to settle before closing the application');
    if (this.mcpConnections.size) throw new KodoError('MCP_ACTIVE', 'await application.shutdown() to close MCP connections before closing the store');
    this.store.close();
  }
}
const knowledgeGuidance = 'Search private knowledge only when useful, read an exact revision, inspect original evidence and record adoption with update_progress.knowledge_uses including its purpose. Current hashes mean freshness, not semantic correctness. A stale or unknown entry needs targeted investigation before adoption. Open questions remain unresolved.';
/** Both variants embed the default card prompt, so a prompt change needs new immutable versions. */
function explorationMainCard(structured: boolean): Card {
  const tools = [...defaultCard.tools, 'knowledge.browse', 'knowledge.search', 'knowledge.read'];
  const guidance = structured
    ? `exploration.plan dispatches read-only research children: use it for independent investigations with concrete inputs and a consumer, such as mapping unfamiliar modules in parallel. Use spawn_agent for children that implement, test or otherwise change files. Small tasks with known entry points should batch direct reads without planning or knowledge overhead. Continue unrelated work while children investigate; avoid rereading their assigned area. ${knowledgeGuidance}`
    : knowledgeGuidance;
  return parseCard(`---
schema_version: 1
id: builtin/exploration-main
version: ${structured ? '1.2.0' : '1.1.0'}
name: Project exploration agent
description: Complete local tasks with optional bounded exploration and private project knowledge.
capabilities:
  tools: ${JSON.stringify(tools)}
---
${defaultCard.prompt}
${guidance}`, { toolNames: tools });
}
export { ProjectKnowledge } from '../knowledge/index.js';
export type { KnowledgeRef, KnowledgeSummary, KnowledgeFreshness, KnowledgePage, KnowledgeSearch, KnowledgeRead, KnowledgeUse, KnowledgeNode, KnowledgeBrowse } from '../knowledge/index.js';
export { ModelProvider, ChatCompletionsProvider, ResponsesProvider, AnthropicProvider } from '../providers/index.js';
export { createAgentDraft, saveAgentMethod, writeAgentDraft } from '../agents/authoring.js';
export { saveConfigurationDraft } from '../agents/configuration-save.js';
export * from '../cases/index.js';
export { createLocalServer } from '../web/index.js';
export type { LocalServerHandle, LocalServerOptions } from '../web/index.js';
export { createWebFetchTool } from '../tools/webfetch.js';
export type { WebFetchPolicy } from '../tools/webfetch.js';
export { lspTools } from '../tools/lsp.js';
export type { LspOptions, LspServerConfig } from '../tools/lsp.js';
export { todoTools } from '../tools/todo.js';
export type { TodoItem, TodoSnapshot } from '../tools/todo.js';
export { readImage, validateImageInput } from '../tools/image.js';
export { createShellTool, resolveBashProgram } from '../tools/shell.js';
export type { ShellToolOptions, ShellInvocation } from '../tools/shell.js';
export { parseCard, loadCard } from '../agents/card.js';
export { KodoError, defaultBudget } from '../runtime/types.js';
export { resolveModelLimits } from '../providers/model-limits.js';
export { discoverModelLimits } from '../providers/model-discovery.js';
export type { ReadOnlyCommand } from '../tools/index.js';
export type { Provider, ModelResponse, ModelImage, Message, ToolRequest, Run, ModelBinding, ModelLimits, ResolvedModelLimits, ModelProtocol, Budget, CompletionCheck, CompletionValidator } from '../runtime/types.js';
export type { FileScope, Card, Session, Permission, RuntimeEvent, ToolRecoveryCheck, ToolRecoveryVerifier } from '../runtime/types.js';
export type { SpawnAgentRequest } from '../messaging/spawn-spec.js';
export type { ToolRegistration, ToolExecutionContext } from '../tools/registry.js';
export type { HookRegistration, HookInput, HookResult, HookKind } from '../runtime/hooks.js';
export type { VerificationPolicy } from '../tools/verify.js';
export { createVerificationTool } from '../tools/verify.js';
export type { Page, PageOptions, SubscriberError } from '../storage/index.js';
export { loadSkill, skillTools, connectMcp } from '../extensions/index.js';
export type { Skill, McpConfig, McpConnection, McpToolPolicy } from '../extensions/index.js';
export type { AssemblyPolicy, CompactionPolicy, TaskProgress } from '../runtime/context.js';
export { createSandbox } from '../sandbox/execute.js';
export type { SandboxRunner, SandboxRunOptions } from '../sandbox/execute.js';
export type { SandboxPolicy, SandboxOptions } from '../sandbox/index.js';
export { PackageRegistry } from '../packages/registry.js';
export type { PackageStatus, PackageDiagnostic, PackagePointer, PackageProvenance, VerifiedAdoptionOptions } from '../packages/registry.js';
export { exportPackage, importPackage, inspectPackage, inspectInstalledPackage } from '../packages/archive.js';
/** Prefer a host's transactional activation when using the public convenience function. */
export async function activatePackage(host: PackageHost, installed: InstalledPackage, options: PackageActivationOptions): Promise<Card> {
  return host.activatePackage ? await host.activatePackage(installed, options) : await activatePackageResources(host, installed, options);
}
export { packageCompatibility, validatePackageBindings, verifyToolExamples } from '../packages/runtime.js';
export type { PackageHost, PackageBindings, PackageActivationOptions, PackageVerification } from '../packages/runtime.js';
export type { PackageDeclaration, PackageManifest, PackageInspection, InstalledPackage, PackageFile, PackageTool, PackageSkill, PackageMcp } from '../packages/schema.js';
