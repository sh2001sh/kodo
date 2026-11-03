import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import type { Application } from '../application/index.js';
import { KodoError } from '../runtime/types.js';
import { terminalText } from './terminal.js';

export type RetentionDraft = ReturnType<Application['retention']['list']>[number];
export function pendingAgentDrafts(app: Application, sessionId: string): RetentionDraft[] {
  return app.retention.list(sessionId).filter(draft => ['draft', 'requested', 'editing'].includes(draft.status));
}
export function agentDraftSummary(draft: RetentionDraft): string {
  return `${draft.name} · 来源 ${draft.sourceRun} · 报告 ${draft.evidence.reportCompleteness.status} · 宿主验收 ${draft.evidence.hostAcceptance.status} · 主任务验收 ${draft.evidence.mainAcceptance.status}`;
}
export function applyAgentDraftChoice(app: Application, draft: RetentionDraft, choice: string): void {
  const evidence = { source: 'cli' as const, userEventId: randomUUID() };
  if (choice === 'y') app.retention.approve(draft.id, draft.digest, evidence);
  else if (choice === 'n') app.retention.decide(draft.id, draft.digest, 'reject', evidence);
  else if (choice === '') app.retention.decide(draft.id, draft.digest, 'skip', evidence);
  else throw new KodoError('ARGUMENTS', '输入 y 保留、n 丢弃、e 编辑，直接回车跳过。');
}
export function editAgentDraft(app: Application, draft: RetentionDraft, text: string): RetentionDraft {
  let metadata: unknown;
  try { metadata = JSON.parse(text); } catch { throw new KodoError('ARGUMENTS', '编辑内容必须为包含 name、catalog 或 routing 的 JSON 对象。'); }
  return app.retention.edit(draft.id, draft.digest, metadata as Parameters<Application['retention']['edit']>[2]);
}

/** Called after the final response; noninteractive execution only lists drafts. */
export async function reviewAgentDrafts(app: Application, sessionId: string, options: { json?: boolean; interactive?: boolean; output?: (text: string) => void; question?: (prompt: string) => Promise<string> } = {}): Promise<void> {
  const drafts = pendingAgentDrafts(app, sessionId);
  if (!drafts.length) return;
  const output = options.output ?? console.log;
  if (options.json || !(options.interactive ?? Boolean(process.stdin.isTTY && process.stderr.isTTY))) {
    output(JSON.stringify({ type: 'agent.drafts', sessionId, drafts }, null, options.json ? undefined : 2));
    return;
  }
  const lines = options.question ? undefined : createInterface({ input: process.stdin, output: process.stderr });
  const question = options.question ?? ((prompt: string) => lines!.question(prompt));
  try {
    for (const original of drafts) {
      let draft = original;
      if (app.retention.list(sessionId).find(value => value.id === draft.id)?.silent) continue;
      for (;;) {
        output(terminalText(agentDraftSummary(draft)));
        const choice = (await question('保留这个 Agent？[y 保留 / n 丢弃 / e 编辑 / 回车跳过] ')).trim().toLowerCase();
        if (choice === 'e') {
          draft = editAgentDraft(app, draft, await question('元数据 JSON（name、catalog、routing）：'));
          output('已更新草稿；请核对后确认新版本。');
          continue;
        }
        if (!['y', 'n', ''].includes(choice)) { output('请输入 y、n 或 e。'); continue; }
        applyAgentDraftChoice(app, draft, choice);
        break;
      }
    }
  } finally { lines?.close(); }
}
