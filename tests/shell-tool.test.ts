import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertManagedShell, readOnlyShell, resolveBashProgram } from '../src/tools/shell.js';
import { fixture } from './helpers.js';

async function shellFixture(permissions: ('read' | 'write' | 'exec')[] = ['read', 'write', 'exec']) {
  const result = fixture(undefined, permissions);
  await resolveBashProgram();
  const original = result.app.store.run(result.runId);
  result.app.store.updateRun(result.runId, { card: { ...original.card, tools: [...original.card.tools, 'shell.exec'] } });
  return { ...result, execute: (args: Record<string, unknown>, signal = new AbortController().signal) => result.app.coordinator.tools.execute(result.runId, 'shell.exec', args, signal) };
}

describe('governed Bash command tool', () => {
  it('preserves ordinary quoted text, redirects, comments and here-documents', () => {
    for (const command of ["echo 'a & b'", 'true && echo done', 'echo done >&2', 'echo done &> log', 'echo done |& cat', '# notes &\necho done', "cat <<'EOF'\na & b\nEOF\necho done"]) {
      expect(() => assertManagedShell(command), command).not.toThrow();
    }
  });

  it('classifies only complete literal read/wait sequences as read-only', () => {
    for (const command of ['sleep 0.1', 'cd . && sleep 1; tail -n 5 log.txt', 'grep -E "^(FAILED|ERROR)" log.txt | head -20', "echo 'literal; text'", 'cat log.txt 2>/dev/null', 'pwd;']) expect(readOnlyShell(command), command).toBe(true);
    for (const command of ['sleep 1; echo done > result.txt', 'sleep 1; mkdir output', 'sleep 1 &', 'tail --unknown log.txt', 'sleep 1 &&', '']) expect(readOnlyShell(command), command).toBe(false);
  });

  it('classifies process probes, 2>&1 and one level of subshell grouping as read-only', () => {
    // Probe commands the FastAPI run issued after its monitoring call timed out (steps 76, 81, 82).
    for (const command of [
      'cd /app && (pgrep -af "pytest tests" || echo "no pytest running") 2>&1 | head -5',
      'cd /app && (pgrep -af "pytest" || echo "no pytest running"); echo "--- log tail ---"; tail -c 3000 /tmp/full_suite.log 2>/dev/null || echo "no log"',
      'tail -c 2000 /tmp/full_suite.log; echo "=== EXIT MARKER ==="; grep -c "passed" /tmp/full_suite.log',
      'ps aux | grep pytest', 'wc -l log.txt', 'cat log.txt 2>&1 | tail -n 5', '(true)', '(echo a; echo b)',
    ]) expect(readOnlyShell(command), command).toBe(true);
    for (const command of [
      '(echo a) > out.txt', '((x=1))', '(echo a', 'echo a)', '(echo a) (echo b)', '(echo a) echo b', '( (echo a) )',
      'echo a 2>&1 > f', 'echo a 2>&12', 'echo a 2>&1x', 'wc --files0-from=x', '(rm x)', '()', 'echo $(rm x)', 'pgrep -f x | sh',
    ]) expect(readOnlyShell(command), command).toBe(false);
  });

  it('supports shell variables, pipelines and redirects in the run workspace', async () => {
    const { root, execute } = await shellFixture();
    const output = await execute({ command: "VALUE='hello world'; printf '%s\\n' \"$VALUE\" | tr a-z A-Z > result.txt; cat result.txt" });
    expect(output).toMatchObject({ exitCode: 0, stdout: 'HELLO WORLD\n', timedOut: false });
    expect(readFileSync(path.join(root, 'result.txt'), 'utf8')).toBe('HELLO WORLD\n');
    expect(await execute({ command: 'false | cat' })).toMatchObject({ exitCode: 1 });
  });

  it('starts with a fresh cwd and ignores environment startup scripts', async () => {
    const { root, execute } = await shellFixture();
    const startup = path.join(root, 'startup.sh');
    writeFileSync(startup, 'printf injected > injected.txt');
    const previous = process.env.BASH_ENV;
    process.env.BASH_ENV = startup;
    try {
      expect(await execute({ command: 'mkdir inner; cd inner; NAME=previous; printf changed' })).toMatchObject({ exitCode: 0 });
      expect(await execute({ command: "test -d inner && printf '%s' \"${NAME-unset}\"" })).toMatchObject({ exitCode: 0, stdout: 'unset' });
      expect(existsSync(path.join(root, 'injected.txt'))).toBe(false);
    } finally { if (previous === undefined) delete process.env.BASH_ENV; else process.env.BASH_ENV = previous; }
  });

  it('preserves nonzero exits, stderr, timeout and cancellation', async () => {
    const { execute } = await shellFixture();
    expect(await execute({ command: 'printf failure >&2; exit 7' })).toMatchObject({ exitCode: 7, stderr: 'failure' });
    expect(await execute({ command: 'sleep 30', timeoutMs: 150 })).toMatchObject({ cancelled: true, timedOut: true });
    const controller = new AbortController();
    const pending = execute({ command: 'sleep 30' }, controller.signal);
    setTimeout(() => controller.abort(), 150);
    expect(await pending).toMatchObject({ cancelled: true, timedOut: false });
  }, 15_000);

  it('rejects absent exec authorization and uncertain writes before invoking the process', async () => {
    const denied = await shellFixture(['read', 'write']);
    await expect(denied.execute({ command: 'printf denied > forbidden' })).rejects.toMatchObject({ code: 'TOOL_DENIED' });
    expect(existsSync(path.join(denied.root, 'forbidden'))).toBe(false);
    const uncertain = await shellFixture();
    uncertain.app.store.putCall({ id: 'uncertain-shell', runId: uncertain.runId, step: 0, kind: 'tool', name: 'process.exec', effect: 'write', status: 'unknown', reservedTokens: 0, requestRef: uncertain.app.store.blob({}) });
    await expect(uncertain.execute({ command: 'printf denied > forbidden' })).rejects.toMatchObject({ code: 'UNKNOWN_WRITE' });
    expect(existsSync(path.join(uncertain.root, 'forbidden'))).toBe(false);
  });

  it('accepts only the managed command schema and host-owned absolute shell', async () => {
    const { execute } = await shellFixture();
    for (const args of [{ command: 'pwd', cwd: '..' }, { command: 'pwd', program: 'bash' }, { command: 'pwd', timeoutMs: 0 }, { command: '' }]) {
      await expect(execute(args)).rejects.toMatchObject({ code: 'TOOL_ARGUMENTS' });
    }
    await expect(resolveBashProgram({ program: './bash.exe' })).rejects.toMatchObject({ code: 'SHELL_CONFIG' });
    await expect(resolveBashProgram({ program: process.execPath })).rejects.toMatchObject({ code: 'SHELL_CONFIG' });
    await expect(execute({ command: 'sleep 1', timeoutMs: 86_400_001 })).rejects.toMatchObject({ code: 'TOOL_ARGUMENTS' });
  });
});
