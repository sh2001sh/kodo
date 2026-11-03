import { afterEach, describe, expect, it } from 'vitest';
import type { Provider } from '../src/runtime/types.js';
import { answer, fixture, scripted } from './helpers.js';

type Request = Parameters<Provider['complete']>[0];

const isState = (content: unknown): boolean => typeof content === 'string' && content.startsWith('<kodo-runtime kind="state">');

describe('benchmark-only KODO_ABLATION switches', () => {
  afterEach(() => { delete process.env.KODO_ABLATION; });

  async function capture(): Promise<Request> {
    let seen: Request | undefined;
    const { app, runId } = fixture(scripted(async request => { seen = request; return answer(); }));
    expect((await app.run(runId)).status).toBe('completed');
    return seen!;
  }

  it('sends the state frame and the full tool set by default', async () => {
    const request = await capture();
    expect(isState(request.messages.at(-1)?.content)).toBe(true);
    expect(request.tools.map(spec => spec.name)).toContain('spawn_agent');
  });

  it('omits the state frame for no-state', async () => {
    process.env.KODO_ABLATION = 'no-state';
    const request = await capture();
    expect(request.messages.some(message => isState(message.content))).toBe(false);
    expect(request.tools.map(spec => spec.name)).toContain('spawn_agent');
  });

  it('keeps only file and process tools for small-tools', async () => {
    process.env.KODO_ABLATION = 'small-tools';
    const request = await capture();
    const names = request.tools.map(spec => spec.name);
    expect(isState(request.messages.at(-1)?.content)).toBe(true);
    expect(names).toContain('file.read');
    expect(names).not.toContain('spawn_agent');
    expect(names).not.toContain('todo.write');
    expect(names.every(name => name.startsWith('file.') || name.startsWith('process.') || name === 'shell.exec' || name === 'artifact.read')).toBe(true);
  });
});
