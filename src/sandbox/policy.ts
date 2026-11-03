import { KodoError } from '../runtime/types.js';

export interface SandboxResources {
  /** Windows: committed memory for the entire job. Linux: virtual address space per process. */
  memoryBytes?: number;
  /** Windows: job process count. Linux: conservative per-real-user process/thread ceiling. */
  maxProcesses?: number;
}

/** Validate before preparing resources; unsupported policy must never silently weaken isolation. */
export function validateSandboxResources(value: unknown, platform: NodeJS.Platform = process.platform): asserts value is SandboxResources | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['memoryBytes', 'maxProcesses'].includes(key))) throw new KodoError('SANDBOX_CONFIG', 'invalid sandbox resource policy');
  const resources = value as SandboxResources;
  for (const [name, limit] of Object.entries(resources)) {
    if (!Number.isSafeInteger(limit) || limit <= 0 || (name === 'maxProcesses' && limit > 0xffffffff)) throw new KodoError('SANDBOX_CONFIG', `sandbox ${name} must be a positive safe integer within the operating system limit`);
  }
  if (platform === 'darwin' && (resources.memoryBytes !== undefined || (resources.maxProcesses !== undefined && resources.maxProcesses !== 1))) throw new KodoError('SANDBOX_UNAVAILABLE', 'macOS sandbox-exec supports only maxProcesses: 1 (forks denied); memory and larger process quotas require a different backend');
}

/** Current native backends enforce network none/all, but have no endpoint filtering. */
export function validateSandboxNetworkAllowlist(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim() || Array.from(item).some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127))) throw new KodoError('SANDBOX_CONFIG', 'invalid sandbox network allowlist');
  throw new KodoError('SANDBOX_UNAVAILABLE', 'sandbox network endpoint allowlists require an enforcing network backend; hostname checks or proxy environment variables do not restrict arbitrary child sockets. Use network: none or an explicitly trusted network: allow policy');
}
