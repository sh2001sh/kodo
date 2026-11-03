import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { Application } from '../application/index.js';
import { Store } from '../storage/index.js';
import { PackageRegistry } from '../packages/registry.js';
import { KodoError } from '../runtime/types.js';
import { cliDataDirectory } from './packages.js';
import { readCliJson, readHostState } from './host-state.js';

const help = `kodo agent drafts [--session SESSION_ID] [--data-dir PATH] [--json]
kodo agent approve DRAFT_ID --digest DIGEST [--data-dir PATH] [--json]
kodo agent discard DRAFT_ID --digest DIGEST [--data-dir PATH] [--json]
kodo agent edit DRAFT_ID --digest DIGEST --metadata JSON_FILE [--data-dir PATH] [--json]
Editing produces a new digest and never approves the new draft. Approval applies only to the displayed digest.
These commands do not call a model. Retained cards enter the next session.`;

export async function agentCommand(args: string[]): Promise<void> {
  if (['drafts', 'approve', 'discard', 'edit'].includes(args[0] ?? '')) { await agentDraftCommand(args); return; }
  const { agentAuthoringCommand } = await import('../agents/authoring-cli.js');
  await agentAuthoringCommand(args);
  if (!args.length || args.includes('--help') || args.includes('-h')) console.log(`\n${help}`);
}

/** Explicit host actions; neither a model tool call nor nearby conversation text approves a draft. */
export async function agentDraftCommand(args: string[], host: { output?: (text: string) => void } = {}): Promise<void> {
  const output = host.output ?? console.log;
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: {
      help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' },
      'data-dir': { type: 'string' }, session: { type: 'string' }, digest: { type: 'string' }, metadata: { type: 'string' },
    } });
  } catch { throw new KodoError('ARGUMENTS', 'invalid draft options; use agent drafts --help'); }
  const { positionals, values } = parsed;
  if (values.help || !positionals.length) { output(help); return; }
  const [command, draftId] = positionals;
  if (!['drafts', 'approve', 'discard', 'edit'].includes(command!) || positionals.length !== (command === 'drafts' ? 1 : 2)) throw new KodoError('ARGUMENTS', 'choose drafts, approve, discard or edit');
  if (command !== 'drafts' && (!draftId || !values.digest || !/^[a-f0-9]{64}$/.test(values.digest))) throw new KodoError('ARGUMENTS', 'draft actions require a draft ID and its --digest');
  if (command === 'drafts' && (values.digest || values.metadata) || command !== 'drafts' && values.session || (command === 'edit') !== Boolean(values.metadata)) throw new KodoError('ARGUMENTS', '--session applies to drafts; --metadata is required only for edit');
  const directory = cliDataDirectory(values['data-dir']);
  // Reattach dependencies from the source session instead of treating a retained extension as a builtin.
  let sessionId = values.session;
  if (draftId) {
    const store = new Store(directory);
    try { sessionId = store.agentDrafts.get(draftId)?.sessionId; } finally { store.close(); }
  }
  const saved = command === 'approve' && sessionId ? readHostState(directory).find(item => item.sessionId === sessionId) : undefined;
  const app = new Application(directory, undefined, undefined, { ...saved?.tools, ...saved?.agents,
    ...(saved?.sandbox ? { sandbox: saved.sandbox } : {}), ...(saved?.compaction !== undefined ? { compaction: saved.compaction } : {}),
    ...(saved?.assembly ? { assembly: saved.assembly } : {}), ...(saved?.memory !== undefined ? { memory: saved.memory } : {}),
    ...(saved?.lazyTools !== undefined ? { lazyTools: saved.lazyTools } : {}), ...(saved?.verification ? { verification: saved.verification } : {}),
  });
  try {
    if (saved?.package) {
      const registry = new PackageRegistry(path.join(directory, 'capabilities'));
      const installed = await registry.inspect(saved.package.id, saved.package.version);
      if (installed.digest !== saved.package.digest) throw new KodoError('CAPABILITY_CHANGED', 'approval requires the original package digest');
      const session = app.store.session(saved.sessionId);
      const relative = path.relative(session.workspace, directory);
      const deny = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ? [] : [relative || '.'];
      await registry.activate(app, saved.package.id, saved.package.version, { workspace: session.workspace, deny, stdio: { write: saved.package.stdioWrite, network: saved.package.stdioNetwork }, reuseVerification: true });
    }
    const action = { source: 'cli' as const, userEventId: randomUUID() };
    let result: unknown;
    if (command === 'drafts') result = { drafts: app.retention.list(values.session) };
    else if (command === 'approve') result = app.retention.approve(draftId!, values.digest!, action);
    else if (command === 'discard') result = app.retention.decide(draftId!, values.digest!, 'reject', action);
    else result = app.retention.edit(draftId!, values.digest!, readCliJson(values.metadata!) as Parameters<typeof app.retention.edit>[2]);
    output(JSON.stringify(result, null, values.json ? undefined : 2));
  } finally { await app.shutdown(); }
}
