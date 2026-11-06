import type { RuntimeCore } from '../core/runtime.js';
import type { IntegrationPlugin } from '../plugins/integration.js';
import { createAgentDraft, saveAgentMethod, writeAgentDraft } from '../agents/authoring.js';
import { saveConfigurationDraft } from '../agents/configuration-save.js';
import { exportPackage } from '../packages/archive.js';
import type { AgentDraft, AgentDraftOptions, SaveAgentOptions } from '../agents/authoring.js';
import type { PackageDeclaration } from '../packages/schema.js';

/**
 * AgentAuthoringPlugin provides agent authoring capabilities as an integration.
 *
 * API interface:
 * - create(options): Create an agent draft from a description
 * - save(runId, options): Extract agent method from a completed run
 * - saveConfig(runId, options): Save configuration draft from a completed run
 * - write(draft, output): Write agent draft to disk
 * - export(directory, archive): Export agent package as archive
 *
 * CLI interface:
 * - create: Create agent draft from description
 * - save: Extract agent method from run
 * - save-config: Save configuration from run
 *
 * Dependencies:
 * - Store (optional for create, required for save/save-config)
 * - Provider (optional for create with template, required for model extraction)
 */
export class AgentAuthoringPlugin implements IntegrationPlugin {
  readonly kind = 'integration' as const;
  readonly name = 'agent-authoring';
  readonly version = '0.1.0';

  private runtime!: RuntimeCore;

  async initialize(runtime: RuntimeCore): Promise<void> {
    this.runtime = runtime;
    // Store is optional: required for save/save-config, not for create
    // Validation happens at method call time
  }

  getInterface() {
    return {
      api: {
        create: this.createAgent.bind(this),
        save: this.saveAgent.bind(this),
        saveConfig: this.saveConfigAgent.bind(this),
        write: this.writeAgent.bind(this),
        export: this.exportAgent.bind(this),
      },
      cli: [
        {
          name: 'create',
          description: 'Create an agent draft from a description',
          handler: this.createCommand.bind(this),
        },
        {
          name: 'save',
          description: 'Extract agent method from a completed run',
          handler: this.saveCommand.bind(this),
        },
        {
          name: 'save-config',
          description: 'Save configuration draft from a completed run',
          handler: this.saveConfigCommand.bind(this),
        },
      ],
    };
  }

  async dispose(): Promise<void> {
    // No cleanup needed
  }

  // API Methods

  /**
   * Create an agent draft from a description.
   *
   * @param options - Agent creation options
   * @returns Agent draft
   *
   * @example
   * ```typescript
   * const draft = await api.create({
   *   description: 'Extract key points from long documents',
   *   id: 'myorg/document-summarizer',
   *   allowedTools: ['file.read', 'file.list'],
   *   template: true, // or provide model for extraction
   * });
   * ```
   */
  async createAgent(options: AgentDraftOptions): Promise<AgentDraft> {
    return await createAgentDraft(options);
  }

  /**
   * Extract agent method from a completed run.
   * Requires Store.
   *
   * @param runId - Run ID to extract from
   * @param options - Save options (must include sessionId)
   * @returns Agent draft with extracted method
   */
  async saveAgent(
    runId: string,
    options: Omit<SaveAgentOptions, 'store' | 'runId'>
  ): Promise<AgentDraft> {
    if (!this.runtime.store) {
      throw new Error(
        'AgentAuthoringPlugin.save requires a Store instance. Pass store to createRuntime({ store }).'
      );
    }

    return await saveAgentMethod({
      ...options,
      store: this.runtime.store,
      runId,
    });
  }

  /**
   * Save configuration draft from a completed run.
   * Requires Store.
   *
   * @param runId - Run ID to save configuration from
   * @param options - Configuration save options
   * @returns Agent draft with configuration
   */
  async saveConfigAgent(
    runId: string,
    options: {
      sessionId: string;
      id: string;
      version?: string;
      name?: string;
      description: string;
    }
  ): Promise<AgentDraft> {
    if (!this.runtime.store) {
      throw new Error(
        'AgentAuthoringPlugin.saveConfig requires a Store instance. Pass store to createRuntime({ store }).'
      );
    }

    return saveConfigurationDraft({
      store: this.runtime.store,
      sessionId: options.sessionId,
      runId,
      id: options.id,
      version: options.version,
      name: options.name,
      description: options.description,
    });
  }

  /**
   * Write agent draft to disk.
   *
   * @param draft - Agent draft to write
   * @param output - Output options
   * @returns Written file paths
   */
  async writeAgent(
    draft: AgentDraft,
    output: {
      directory: string;
      license: string;
      sourceUrl: string;
    }
  ): Promise<{
    directory: string;
    cardPath: string;
    declarationPath: string;
    declaration: PackageDeclaration;
  }> {
    return await writeAgentDraft(draft, output);
  }

  /**
   * Export agent package as archive.
   *
   * @param directory - Agent directory
   * @param archive - Archive file path
   */
  async exportAgent(
    directory: string,
    declaration: PackageDeclaration,
    archive: string
  ): Promise<void> {
    await exportPackage(directory, declaration, archive);
  }

  // CLI Commands
  // TODO: Implement CLI handlers. These are placeholders that will be wired
  // to the existing agentAuthoringCommand in authoring-cli.ts.

  private readonly createCommand: (args: Record<string, unknown>) => Promise<unknown> = async () => {
    throw new Error('CLI handler not yet implemented');
  };

  private readonly saveCommand: (args: Record<string, unknown>) => Promise<unknown> = async () => {
    throw new Error('CLI handler not yet implemented');
  };

  private readonly saveConfigCommand: (args: Record<string, unknown>) => Promise<unknown> = async () => {
    throw new Error('CLI handler not yet implemented');
  };
}
