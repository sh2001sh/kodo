import type { SandboxResources } from './policy.js';

/** Fully resolved host policy. Workspace scope entries are relative paths. */
export interface SandboxLaunchInput {
  program: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  workspace: string;
  read?: string[];
  write: string[];
  deny: string[];
  network: 'none' | 'allow';
  networkAllowlist?: string[];
  resources?: SandboxResources;
  /** Trusted host runtime files/directories, exposed read-only. */
  readOnlyPaths?: string[];
  /** Exact host-owned run scratch directory; independent of workspace write permission. */
  outputDirectory?: string;
}

export interface PreparedSandbox {
  program: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Read-only descriptors inherited after stdin/stdout/stderr by the OS backend. */
  extraFiles?: number[];
  cleanup: () => Promise<void>;
}
