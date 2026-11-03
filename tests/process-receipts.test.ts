import { describe, expect, it } from 'vitest';
import { Store } from '../src/storage/index.js';
import { fixture } from './helpers.js';

describe('retained lean command output', () => {
  it('keeps short failed output readable after reopening the store, without requiring a temporary file', async () => {
    const { app, runId } = fixture(undefined, ['read', 'write', 'exec'], { toolProfile: 'lean-solo', taskProtocol: 3 });
    const result = await app.coordinator.tools.execute(runId, 'shell.exec', { command: "printf 'check failed'; exit 3" }, AbortSignal.timeout(20_000)) as { exitCode: number; truncated?: boolean; outputArtifact: { id: string } };
    expect(result.exitCode).toBe(3);
    expect(result.truncated).not.toBe(true);
    const directory = app.store.directory;
    await app.shutdown();
    const reopened = new Store(directory);
    try {
      const saved = reopened.readArtifact(runId, result.outputArtifact.id) as { content: string };
      expect(JSON.parse(saved.content)).toMatchObject({ stdout: 'check failed', exitCode: 3 });
    } finally { reopened.close(); }
  });

  it('keeps the complete settled background output in the finish event receipt', async () => {
    const { app, runId } = fixture(undefined, ['read', 'write', 'exec'], { toolProfile: 'lean-team', taskProtocol: 3 });
    await app.coordinator.tools.execute(runId, 'shell.exec', { command: "sleep 0.2; printf 'background complete'", background: true }, AbortSignal.timeout(20_000));
    await app.coordinator.tools.backgroundSettled();
    const event = app.store.latestEvent(runId, { types: ['process.background.finished'] })!;
    const result = app.store.readBlob<{ outputArtifact: { id: string }; exitCode: number }>(event.data.resultRef as string);
    const read = await app.coordinator.tools.execute(runId, 'artifact.read', { id: result.outputArtifact.id }, AbortSignal.timeout(10_000)) as { content: string };
    expect(JSON.parse(read.content)).toMatchObject({ stdout: 'background complete', exitCode: 0 });
  });
});
