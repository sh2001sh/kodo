import { KodoError } from './types.js';
import type { Run, Session, ToolRequest, ToolSpec } from './types.js';
import { workspaceGitParameters } from './workspace-git.js';

/** Frozen session profiles whose model sees a renamed, smaller tool view. */
export type LeanProfile = 'lean-solo';
export const leanProfiles: readonly string[] = ['lean-solo'];
export const isLeanProfile = (profile: string | undefined): profile is LeanProfile => profile !== undefined && leanProfiles.includes(profile);

const object = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({ type: 'object', additionalProperties: false, properties, required });
const text = { type: 'string', minLength: 1, maxLength: 4096 };
const offset = { type: 'integer', minimum: 0 };
const maxChars = { type: 'integer', minimum: 256, maximum: 32_000 };
const hex = { type: 'string', pattern: '^[a-f0-9]{64}$' };

/** One model tool and the kernel tools it may resolve to; `exec` views need command execution. */
interface ViewTool { spec: ToolSpec; kernel: readonly string[]; when: 'always' | 'exec' | 'noexec' }

const viewTools: ViewTool[] = [
  { when: 'always', kernel: ['file.read', 'history.read', 'history.search', 'artifact.read'], spec: { name: 'read', description: 'Read exactly one source: path (workspace file; offset 1-based line, limit lines; default page 600 lines/24000 characters), history (archive ref; offset/limit messages), history_query (literal earlier-output search), or artifact (stored output ID).', parameters: object({
    path: text, history: hex, history_query: { type: 'string', minLength: 1, maxLength: 1000 }, artifact: text,
    offset, limit: { type: 'integer', minimum: 1, maximum: 1000 }, contentOffset: offset, maxChars, run_id: { type: 'string' }, cursor: { type: 'string', maxLength: 4096 },
  }) } },
  { when: 'always', kernel: ['file.patch'], spec: { name: 'edit', description: 'Replace exact text in an existing file. Edits apply in order, each oldText matching exactly once; all must match before saving. Reuse known content without a redundant read. If the file changed since this run read or wrote it, read it again.', parameters: object({
    path: text, edits: { type: 'array', minItems: 1, maxItems: 100, items: object({ oldText: { type: 'string', minLength: 1, maxLength: 64_000 }, newText: { type: 'string', maxLength: 64_000 } }, ['oldText', 'newText']) },
  }, ['path', 'edits']) } },
  { when: 'always', kernel: ['file.apply_patch'], spec: { name: 'write', description: 'Create or replace a whole file (read existing files first), up to 64000 bytes. Parent must exist. Use edit for local changes.', parameters: object({ path: text, content: { type: 'string', maxLength: 64_000 } }, ['path', 'content']) } },
  { when: 'exec', kernel: ['shell.exec'], spec: { name: 'bash', description: 'Run Bash; returns exit code, preview and outputArtifact. Direct tests retain full captured output; pipes/redirection may lose it. Preserve exit codes. Long commands return a job id; background:true starts immediately. Collect with job; no nohup or trailing &.', parameters: object({
    command: { type: 'string', minLength: 1, maxLength: 32_000 }, background: { type: 'boolean' }, timeoutMs: { type: 'integer', minimum: 1, maximum: 86_400_000, description: 'Total lifetime in ms, default 600000.' },
  }, ['command']) } },
  { when: 'exec', kernel: ['process.read', 'workspace.git'], spec: { name: 'job', description: 'Read a background job by id: output pages (pass the returned offsets to continue), state and exit code. waitMs waits for new output or exit; stop:true terminates it.', parameters: object({
    id: { type: 'string', minLength: 1, maxLength: 64 }, stdoutOffset: offset, stderrOffset: offset, maxChars, waitMs: { type: 'integer', minimum: 0, maximum: 300_000 }, stop: { type: 'boolean' },
  }, ['id']) } },
  { when: 'noexec', kernel: ['file.search'], spec: { name: 'search', description: 'Find literal text in files under a workspace path.', parameters: object({ path: text, query: { type: 'string', minLength: 1, maxLength: 200 } }, ['path', 'query']) } },
  { when: 'noexec', kernel: ['file.list'], spec: { name: 'list', description: 'List a workspace directory, up to 200 entries per page; pass next.cursor to continue.', parameters: object({ path: text, cursor: { type: 'string', minLength: 1, maxLength: 8192 }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, ['path']) } },
  { when: 'noexec', kernel: ['file.mkdir'], spec: { name: 'mkdir', description: 'Create one directory whose parent exists. Create nested paths one level at a time.', parameters: object({ path: text }, ['path']) } },
  { when: 'noexec', kernel: ['file.rename'], spec: { name: 'move', description: 'Move a file you have read to a path that does not exist yet.', parameters: object({ path: text, destination: text }, ['path', 'destination']) } },
  { when: 'noexec', kernel: ['file.delete'], spec: { name: 'delete', description: 'Delete a regular file you have read.', parameters: object({ path: text }, ['path']) } },
];
/** Coordination tools keep their kernel names and schemas in lean views. */
const passThrough = new Set(['ask_user']);
function inView(tool: ViewTool, exec: boolean): boolean {
  return tool.when === 'always' || (tool.when === 'exec') === exec;
}
const byModelName = new Map(viewTools.map(tool => [tool.spec.name, tool]));
const byKernelName = new Map(viewTools.flatMap(tool => tool.kernel.map(name => [name, tool] as const)));

/** Whether a run in a lean session may execute commands; frozen with the run's permissions and card. */
export function viewExec(run: Pick<Run, 'card' | 'permissions'>, session: Pick<Session, 'permissions'>): boolean {
  return session.permissions.includes('exec') && (run.permissions ?? session.permissions).includes('exec') && run.card.tools.includes('shell.exec');
}

/**
 * Model-visible tool list for a lean view, built from the kernel tools the run
 * may use. A view tool appears only when its primary kernel tool is available.
 */
export function leanToolSpecs(kernelSpecs: readonly ToolSpec[], exec: boolean): ToolSpec[] {
  const available = new Set(kernelSpecs.map(spec => spec.name));
  const tools = viewTools.filter(tool => inView(tool, exec) && available.has(tool.kernel[0]!)).map(tool => tool.spec.name === 'job' ? {
    ...tool.spec,
    description: 'Read/stop a job by id; page with offsets. Or action:git with git:{action:status|diff|branch|commit,...} in the original repository. Read status for expectedHead; integrate children before committing.',
    parameters: object({ ...(tool.spec.parameters.properties as Record<string, unknown>), action: { const: 'git' }, git: workspaceGitParameters }),
  } : tool.spec);
  return [...tools, ...kernelSpecs.filter(spec => passThrough.has(spec.name))];
}

/** Model name a lean view uses for a kernel tool, if any. */
export const viewName = (kernelName: string): string | undefined => passThrough.has(kernelName) ? kernelName : byKernelName.get(kernelName)?.spec.name;

const pick = (args: Record<string, unknown>, keys: readonly string[], rename: Record<string, string> = {}): Record<string, unknown> =>
  Object.fromEntries(keys.filter(key => args[key] !== undefined).map(key => [rename[key] ?? key, args[key]]));

function readTarget(args: Record<string, unknown>): ToolRequest['name'] {
  const modes = ['path', 'history', 'history_query', 'artifact'].filter(key => args[key] !== undefined);
  if (modes.length !== 1) throw new KodoError('TOOL_ARGUMENTS', 'read needs exactly one of path, history, history_query or artifact');
  const allowed: Record<string, string[]> = { path: ['offset', 'limit', 'contentOffset', 'maxChars'], history: ['offset', 'limit', 'contentOffset', 'maxChars'], history_query: ['run_id', 'cursor', 'limit'], artifact: ['contentOffset', 'maxChars'] };
  const extra = Object.keys(args).filter(key => key !== modes[0] && !allowed[modes[0]!]!.includes(key));
  if (extra.length) throw new KodoError('TOOL_ARGUMENTS', `read with ${modes[0]} does not accept ${extra.join(', ')}`);
  return modes[0]!;
}

/**
 * Canonical kernel call for a model call in the session's frozen view. Kernel
 * names the view already covers pass through; anything else is rejected before execution.
 */
export function resolveToolCall(profile: string | undefined, request: ToolRequest, exec: boolean): ToolRequest {
  // Kernel names inside the view (recovery retries, equivalent direct calls) keep their identity.
  if (!isLeanProfile(profile) || leanAllows(request.name, exec)) return request;
  const tool = byModelName.get(request.name);
  if (!tool || !inView(tool, exec)) throw new KodoError('TOOL_DENIED', `${request.name} is not part of this run's tool view; use the advertised tools`);
  let args: Record<string, unknown>;
  try { args = JSON.parse(request.arguments) as Record<string, unknown>; }
  catch { throw new KodoError('TOOL_ARGUMENTS', 'arguments must be complete JSON'); }
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new KodoError('TOOL_ARGUMENTS', 'arguments must be a JSON object');
  const kernel = (name: string, value: Record<string, unknown>): ToolRequest => ({ id: request.id, name, arguments: JSON.stringify(value) });
  switch (request.name) {
    case 'read': {
      const mode = readTarget(args);
      if (mode === 'path') return kernel('file.read', pick(args, ['path', 'offset', 'limit', 'contentOffset', 'maxChars']));
      if (mode === 'history') return kernel('history.read', pick(args, ['history', 'offset', 'limit', 'contentOffset', 'maxChars'], { history: 'ref' }));
      if (mode === 'history_query') return kernel('history.search', pick(args, ['history_query', 'run_id', 'cursor', 'limit'], { history_query: 'query' }));
      return kernel('artifact.read', pick(args, ['artifact', 'contentOffset', 'maxChars'], { artifact: 'id' }));
    }
    case 'edit': return kernel('file.patch', pick(args, ['path', 'edits']));
    case 'write': return kernel('file.apply_patch', pick(args, ['path', 'content']));
    case 'bash': return kernel('shell.exec', pick(args, ['command', 'background', 'timeoutMs']));
    case 'job': {
      if (args.action !== undefined || args.git !== undefined) {
        if (args.action !== 'git' || !args.git || typeof args.git !== 'object' || Array.isArray(args.git) || Object.keys(args).some(key => !['action', 'git'].includes(key))) throw new KodoError('TOOL_ARGUMENTS', 'Git delivery requires main job({action:"git",git:{action,...}}) without process arguments');
        return kernel('workspace.git', args.git as Record<string, unknown>);
      }
      return kernel('process.read', pick(args, ['id', 'stdoutOffset', 'stderrOffset', 'maxChars', 'waitMs', 'stop']));
    }
    case 'search': return kernel('file.search', pick(args, ['path', 'query']));
    case 'list': return kernel('file.list', pick(args, ['path', 'cursor', 'limit']));
    case 'mkdir': return kernel('file.mkdir', pick(args, ['path']));
    case 'move': return kernel('file.rename', pick(args, ['path', 'destination']));
    case 'delete': return kernel('file.delete', pick(args, ['path']));
    default: return request;
  }
}

/**
 * The canonical request of a model call for this run, or the original with the
 * view error to report. Team children use their own frozen role view; legacy profiles keep canonical names.
 */
export function canonicalRequest(run: Pick<Run, 'parentId' | 'card' | 'permissions'>, session: Pick<Session, 'toolProfile' | 'permissions'>, request: ToolRequest): { request: ToolRequest; error?: KodoError } {
  if (!isLeanProfile(session.toolProfile) || run.parentId) return { request };
  try { return { request: resolveToolCall(session.toolProfile, request, viewExec(run, session)) }; }
  catch (error) { if (error instanceof KodoError) return { request, error }; throw error; }
}

const toolMentions: [RegExp, string][] = [
  [/Use recovery\.inspect to request host verification\. /g, ''], [/\brecovery\.inspect\b/g, 'automatic host verification'],
  [/\bprocess\.read\b/g, 'job'], [/\bshell\.exec\b/g, 'bash'], [/\bfile\.read\b/g, 'read'], [/\bartifact\.read\b/g, 'read with artifact'],
  [/\bhistory\.read\b/g, 'read with history'], [/\bhistory\.search\b/g, 'read with history_query'], [/\bfile\.patch\b/g, 'edit'], [/\bfile\.apply_patch\b/g, 'write'],
];
/** Runtime-written prose and pointer fields name tools as the lean model sees them; tool output is never rewritten. */
export function viewText(profile: string | undefined, text: string): string {
  return isLeanProfile(profile) ? toolMentions.reduce((value, [pattern, name]) => value.replace(pattern, name), text) : text;
}

const runtimeFields = new Set(['error', 'readWith', 'note', 'hint']);
/** Rewrites only runtime-authored fields of a tool result (errors, pointers, notes), never captured output. */
export function viewResult(profile: string | undefined, value: unknown, depth = 0): unknown {
  if (!isLeanProfile(profile) || depth > 3 || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item === 'string' && runtimeFields.has(key) ? viewText(profile, item) : item && typeof item === 'object' && !Array.isArray(item) ? viewResult(profile, item, depth + 1) : item]));
}

/** Kernel tools a lean view can reach; everything else stays hidden and is rejected on execution. */
/** Whether a kernel tool belongs to the frozen lean view of a run; command and file-management tools are exclusive. */
export function leanAllows(name: string, exec: boolean): boolean {
  if (name === 'workspace.git') return exec;
  if (passThrough.has(name)) return name === 'ask_user';
  const tool = byKernelName.get(name);
  return Boolean(tool && inView(tool, exec));
}
