import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runProcess } from '../src/tools/index.js';
import { resolveBashProgram } from '../src/tools/shell.js';
import { temp } from './helpers.js';

const bashArgs = (command: string, args: string[] = []): string[] => ['--noprofile', '--norc', '-p', '-o', 'pipefail', '-c', command, '--', ...args];
const quoted = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

describe.skipIf(process.platform !== 'win32')('Windows Bash process jobs', () => {
  it('preserves cwd, arguments, stdin, stdout, stderr, environment and nonzero exit codes', async () => {
    const root = path.join(temp(), 'directory with spaces');
    mkdirSync(root);
    writeFileSync(path.join(root, 'marker.txt'), 'present');
    const bash = await resolveBashProgram();
    const command = 'test -f marker.txt || exit 9; IFS= read -r line; printf "%s\\n" "$1" "$2" "$3" "$line" "$KODO_TREE_TEST_VALUE"; printf diagnostic >&2; exit 7';
    const result = await runProcess(bash, bashArgs(command, ['with space', 'embedded"quote', 'trailing\\']), root, 'KODO_TEST_KEY', new AbortController().signal, { stdin: 'input payload\n', env: { KODO_TREE_TEST_VALUE: 'inherited' } });
    expect(result).toMatchObject({ exitCode: 7, stdout: 'with space\nembedded"quote\ntrailing\\\ninput payload\ninherited\n', stderr: 'diagnostic', cancelled: false });
  });

  it.each([false, true])('terminates descendants without inherited output pipes (parent exits early: %s)', async exitEarly => {
    const root = temp();
    const bash = await resolveBashProgram();
    const source = `const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true }); console.log(JSON.stringify({ parent: process.pid, child: child.pid })); ${exitEarly ? 'process.exit(0)' : 'setInterval(() => {}, 1000)'}`;
    const command = `${quoted(process.execPath.replaceAll('\\', '/'))} -e ${quoted(source)}`;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 10_000);
    let cancel: ReturnType<typeof setTimeout> | undefined;
    let output = '';
    let pids: { parent: number; child: number } | undefined;
    try {
      const result = await runProcess(bash, bashArgs(command), root, 'KODO_TEST_KEY', controller.signal, { onOutput(stream, content) {
        if (stream !== 'stdout' || pids) return;
        output += content;
        if (!output.includes('\n')) return;
        pids = JSON.parse(output.split('\n')[0]!) as typeof pids;
        cancel = setTimeout(() => controller.abort(), 100);
      } });
      expect(pids, result.stderr).toBeDefined();
      expect(result).toMatchObject({ cancelled: true });
      for (const pid of [pids!.parent, pids!.child]) {
        let alive = true;
        for (let attempt = 0; attempt < 100; attempt++) {
          try { process.kill(pid, 0); }
          catch (error) { expect((error as NodeJS.ErrnoException).code).toBe('ESRCH'); alive = false; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(alive, `owned process ${pid} must have exited`).toBe(false);
      }
    } finally { clearTimeout(deadline); clearTimeout(cancel); controller.abort(); }
  });
});
