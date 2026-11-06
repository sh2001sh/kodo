import type { RuntimeCore } from '../core/runtime.js';
import type { IntegrationPlugin, IntegrationCommand } from '../plugins/integration.js';
import type { FrozenCase, CaseDefinition } from '../cases/schema.js';
import type { CaseRun } from '../cases/store.js';
import type { CaseComparison } from '../cases/runner.js';
import { freezeCase } from '../cases/schema.js';
import { CaseRunStore } from '../cases/store.js';
import { compareCaseRuns } from '../cases/runner.js';

/**
 * EvalIntegrationPlugin provides the case evaluation framework as an integration.
 *
 * API interface:
 * - freeze(def): Freeze a case definition
 * - run(frozen, options): Execute a frozen case
 * - list(): List all case runs
 * - compare(runA, runB): Compare two case runs
 * - adopt(agentId, runs): Adopt a version (placeholder)
 * - rollback(agentId, runs): Rollback a version (placeholder)
 *
 * CLI interface:
 * - freeze: Freeze a case definition
 * - run: Execute a frozen case
 * - list: List case runs
 * - compare: Compare two case runs
 * - adopt: Adopt a version
 * - rollback: Rollback a version
 */
export class EvalIntegrationPlugin implements IntegrationPlugin {
  readonly kind = 'integration' as const;
  readonly name = 'eval';
  readonly version = '0.1.0';

  private runtime!: RuntimeCore;
  private store!: CaseRunStore;

  async initialize(runtime: RuntimeCore): Promise<void> {
    this.runtime = runtime;

    // Verify that Store is provided
    if (!runtime.store) {
      throw new Error('EvalIntegrationPlugin requires a Store instance. Pass store to createRuntime({ store }).');
    }

    // Initialize CaseRunStore with the Store from runtime
    this.store = new CaseRunStore(runtime.store);
  }

  getInterface() {
    return {
      api: {
        freeze: this.freezeCase.bind(this),
        run: this.runCase.bind(this),
        list: this.listCases.bind(this),
        compare: this.compareCases.bind(this),
        adopt: this.adoptVersion.bind(this),
        rollback: this.rollbackVersion.bind(this),
      },
      cli: [
        {
          name: 'freeze',
          description: 'Freeze a case definition into an executable format',
          handler: async (args: Record<string, unknown>) => {
            const { input, output } = args as { input: string; output?: string };
            console.log('Freeze case:', input, output);
            // TODO: Implement CLI handler
            return { success: true, message: `Frozen case would be written to ${output || 'stdout'}` };
          },
        },
        {
          name: 'run',
          description: 'Execute a frozen case',
          handler: async (args: Record<string, unknown>) => {
            const { frozen } = args as { frozen: string };
            // TODO: Implement CLI handler
            return { success: true, message: `Case ${frozen} would be executed` };
          },
        },
        {
          name: 'list',
          description: 'List all case runs',
          handler: async (args: Record<string, unknown>) => {
            const runs = await this.listCases(args);
            return runs;
          },
        },
        {
          name: 'compare',
          description: 'Compare two case runs',
          handler: async (args: Record<string, unknown>) => {
            const { runA, runB } = args as { runA: string; runB: string };
            const comparison = await this.compareCases(runA, runB);
            return comparison;
          },
        },
        {
          name: 'adopt',
          description: 'Adopt a version based on case runs',
          handler: async (args: Record<string, unknown>) => {
            const { agent, runs } = args as { agent: string; runs: string[] };
            await this.adoptVersion(agent, runs);
            return { success: true, message: `Adopted version for ${agent}` };
          },
        },
        {
          name: 'rollback',
          description: 'Rollback to a previous version',
          handler: async (args: Record<string, unknown>) => {
            const { agent, runs } = args as { agent: string; runs: string[] };
            await this.rollbackVersion(agent, runs);
            return { success: true, message: `Rolled back ${agent}` };
          },
        },
      ] as IntegrationCommand[],
    };
  }

  // API Methods

  /**
   * Freeze a case definition into an executable format.
   */
  private async freezeCase(definition: CaseDefinition): Promise<FrozenCase> {
    const frozen = freezeCase(definition);
    console.log('Frozen case:', frozen.digest);
    return frozen;
  }

  /**
   * Execute a frozen case.
   */
  private async runCase(): Promise<CaseRun> {
    // TODO: Integrate with runtime
    // The existing runCase expects full RunCaseOptions which includes provider, binding, etc.
    // This needs proper integration with RuntimeCore
    throw new Error('EvalIntegrationPlugin.runCase needs proper RuntimeCore integration - TODO');
  }

  /**
   * List all case runs.
   */
  private async listCases(options?: Record<string, unknown>): Promise<{ items: CaseRun[]; next: number | null }> {
    const { limit, after } = (options || {}) as {
      limit?: number;
      after?: number;
    };

    return this.store.list({
      limit: limit || 50,
      after: after || 0,
    });
  }

  /**
   * Compare two case runs.
   */
  private async compareCases(runAId: string, runBId: string): Promise<CaseComparison> {
    const runA = this.store.get(runAId);
    const runB = this.store.get(runBId);

    return compareCaseRuns(runA, runB);
  }

  /**
   * Adopt a version based on case runs.
   * TODO: Implement version adoption logic.
   */
  private async adoptVersion(agentId: string, runIds: string[]): Promise<void> {
    // Placeholder: This will be implemented when we integrate with AgentAuthoringPlugin
    console.log(`Adopting version for ${agentId} based on runs:`, runIds);
  }

  /**
   * Rollback to a previous version.
   * TODO: Implement version rollback logic.
   */
  private async rollbackVersion(agentId: string, runIds: string[]): Promise<void> {
    // Placeholder: This will be implemented when we integrate with AgentAuthoringPlugin
    console.log(`Rolling back ${agentId} based on runs:`, runIds);
  }

  async cleanup(): Promise<void> {
    // Nothing to clean up for now
  }
}
