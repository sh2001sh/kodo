import { stringify } from 'yaml';
import { parseCard } from './card.js';
import { hostPrivateValues, safeOutput } from './authoring.js';
import type { AgentDraft } from './authoring.js';
import { hostToolNames } from '../tools/catalog.js';
import { builtinToolNames } from '../tools/index.js';
import { KodoError } from '../runtime/types.js';
import type { Store } from '../storage/index.js';

export interface SaveConfigurationOptions {
  store: Store;
  /** The session that owns the run; other sessions' configurations are refused. */
  sessionId: string;
  runId: string;
  id: string;
  version?: string;
  name?: string;
  description?: string;
  /** Task-specific values to reject, in addition to the workspace, state directory and env credentials. */
  privateValues?: readonly string[];
}

const fail = (message: string): KodoError => new KodoError('AGENT_AUTHORING', message);

/**
 * Turn the ad-hoc configuration a completed run actually used into a reviewable
 * card draft. No model is called: the method is the recorded prompt and tool set,
 * so the saved version reproduces what ran. Skills and extension tools are not
 * bundled here and are refused rather than silently dropped.
 */
export function saveConfigurationDraft(options: SaveConfigurationOptions): AgentDraft {
  const run = options.store.run(options.runId);
  if (run.sessionId !== options.sessionId) throw fail('source run does not belong to the authorized session');
  const { card } = run;
  if (!card.derivedFrom) throw fail('source run did not use an ad-hoc configuration; its registered card already has an exportable version');
  if (run.status !== 'completed' || !run.resultRef) throw fail('source run must be completed with a recorded result');
  if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(options.id) || !/^\d+\.\d+\.\d+$/.test(options.version ?? '0.1.0')) throw fail('provide author/name and a numeric semantic version');
  if (card.skills?.length) throw fail(`skills ${JSON.stringify(card.skills)} cannot be bundled by a configuration save; package them as capability resources and reference them from a package card`);
  const portable: readonly string[] = [...builtinToolNames, ...hostToolNames];
  const unbundled = card.tools.filter(tool => !portable.includes(tool));
  if (unbundled.length) throw fail(`tools ${JSON.stringify(unbundled.slice(0, 8))} are host extensions that this card cannot carry; package them as capability resources`);
  const version = options.version ?? '0.1.0';
  const name = options.name ?? card.name;
  const description = options.description ?? card.description ?? `Saved configuration derived from ${card.derivedFrom.id}`;
  const base = `${card.derivedFrom.id}@${card.derivedFrom.version}`;
  const frontmatter = stringify({ schema_version: 1, id: options.id, version, name, description, ...(card.nudges === undefined ? {} : { nudges: card.nudges }), capabilities: { tools: card.tools } }).trimEnd();
  const cardContent = `---\n${frontmatter}\n---\nSaved ad-hoc configuration derived from ${base}. One recorded run is single evidence, not proof of reuse; validate on new inputs before adopting.\n\n${card.prompt}\n`;
  safeOutput(cardContent, [...(options.privateValues ?? []), ...hostPrivateValues(options.store, run)]);
  parseCard(cardContent, { toolNames: hostToolNames });
  const quality = options.store.readBlob<{ quality?: { status?: string } }>(run.resultRef).quality?.status ?? 'not_checked';
  return { id: options.id, version, mode: 'configuration-draft', cardContent, origin: { runId: run.id, quality, derivedFrom: card.derivedFrom, evidence: 'single-run' } };
}
