import { terminalText } from './terminal.js';
import { createInterface } from 'node:readline';
import type { Application } from '../application/index.js';
import { errorText, terminal } from '../runtime/types.js';
import type { Run } from '../runtime/types.js';

/** Use the terminal's native line editor, including IME/paste, without taking over the screen. */
export async function interactive(app: Application, initial: Run, select: (id: string) => void, beforeRun: (id: string) => void = () => {}): Promise<Run> {
  const terminalInput = Boolean(process.stdin.isTTY && process.stderr.isTTY);
  const lines = createInterface({ input: process.stdin, output: process.stderr, terminal: terminalInput, crlfDelay: Infinity });
  let currentId = initial.id;
  const pending: string[] = [];
  let driving: Promise<void> | undefined;
  let quitting = false;
  let inputClosed = false;
  lines.once('close', () => { inputClosed = true; });
  let revision = 0;
  let handledRevision = -1;
  const choose = (id: string): void => { currentId = id; select(id); };
  const prompt = (): void => { if (!quitting && !inputClosed) { lines.setPrompt('> '); lines.prompt(true); } };
  // Keep the native editor's current input visible after asynchronous runtime output.
  const unsubscribe = app.store.subscribe(event => { if (terminalInput && event.sessionId === initial.sessionId) prompt(); });
  const drive = (): void => {
    if (driving || quitting) return;
    driving = (async () => {
      try {
        for (;;) {
          handledRevision = revision;
          const targetId = currentId;
          beforeRun(targetId);
          await app.run(targetId);
          const current = app.store.run(targetId);
          if (quitting) return;
          if (currentId !== targetId || revision !== handledRevision) continue;
          process.stderr.write(`\n[${current.status}] ${current.id}\n`);
          if (terminal(current.status)) {
            const next = pending.shift();
            if (next) { choose(next); continue; }
          }
          for (const q of app.coordinator.mailbox.userQuestions(current.sessionId)) process.stderr.write(terminalText(`\n待回答 ${q.id}\n${q.content}\n`));
          prompt();
          return;
        }
      } catch (error) { process.stderr.write(`${errorText(error)}\n`); }
      finally { driving = undefined; if (!quitting && revision !== handledRevision) drive(); }
    })();
  };
  process.stderr.write('Kodo 终端交互：直接输入补充；/decision 修改约束；/next 排队后续任务；/status 查看；/cancel 取消；/quit 退出。多行粘贴可用 /paste 开始、/send 提交。\n');
  choose(currentId);
  drive();
  if (terminalInput) prompt();
  let paste: string[] | undefined;
  try {
    for await (const line of lines) {
      try {
        if (line === '/paste' && !paste) { paste = []; continue; }
        if (paste && line !== '/send') { paste.push(line); continue; }
        const pasted = paste !== undefined;
        const text = paste ? paste.join('\n') : line;
        paste = undefined;
        if (!text.trim()) continue;
        if (!pasted && text === '/quit') { quitting = true; break; }
        if (!pasted && text === '/status') { process.stderr.write(`${JSON.stringify(app.snapshot(currentId), null, 2)}\n`); prompt(); continue; }
        if (!pasted && text === '/cancel') { app.coordinator.cancel(currentId); revision++; drive(); continue; }
        if (!pasted && text.startsWith('/next ')) {
          const next = app.submitInput(pending.at(-1) ?? currentId, text.slice(6), { mode: 'follow_up' });
          pending.push(next.id);
          process.stderr.write(`后续任务已排队：${next.id}\n`);
          revision++; drive();
          continue;
        }
        if (!pasted && text.startsWith('/') && !text.startsWith('/decision ')) { process.stderr.write('COMMAND: 未知交互命令。\n'); prompt(); continue; }
        const decision = !pasted && text.startsWith('/decision ');
        const content = decision ? text.slice(10) : text;
        const question = app.coordinator.mailbox.userQuestions(app.store.run(currentId).sessionId)[0];
        const current = question ? app.answer(question.id, content, { decision }) : app.submitInput(currentId, content, { decision });
        choose(current.id);
        revision++; drive();
      } catch (error) { process.stderr.write(`${errorText(error)}\n> `); }
    }
    if (paste !== undefined) process.stderr.write('INPUT_INCOMPLETE: 未收到 /send，多行输入未提交。\n');
    if (quitting) for (const id of [currentId, ...pending]) if (!terminal(app.store.run(id).status)) app.coordinator.cancel(id);
    // EOF finishes submitted work; /quit cancels it and never starts a queued task.
    while (driving) await driving;
    return app.store.run(currentId);
  } finally { unsubscribe(); lines.close(); }
}
