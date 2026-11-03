import { runProcess } from '../tools/index.js';
import type { ProcessOutput } from '../tools/index.js';
import type { SandboxOptions } from './index.js';

export interface SandboxRunOptions { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string; signal?: AbortSignal }
export interface SandboxRunner { run(program: string, args: string[], options?: SandboxRunOptions): Promise<ProcessOutput> }

/** Each invocation obtains a fresh OS security context; failures never execute the trusted path. */
export function createSandbox(options: SandboxOptions): SandboxRunner {
  const configuration = structuredClone(options);
  return Object.freeze({ async run(program: string, args: string[], invocation: SandboxRunOptions = {}): Promise<ProcessOutput> {
    const signal = invocation.signal ?? AbortSignal.timeout(120_000);
    return await runProcess(program, args, invocation.cwd ?? configuration.workspace, '', signal, { sandbox: configuration, env: invocation.env, stdin: invocation.stdin });
  } });
}
