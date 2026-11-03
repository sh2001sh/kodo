import type { Store } from '../storage/index.js';
import { recoveryHistoryRuns } from './history.js';

export interface RunMemory {
  decisions: string[];
  lessons: string[];
  source: string;
  note: string;
}

const eventType = 'context.memory.updated';
const maxChars = 4000;

/** Durable handoff facts are historical claims, not host decisions or permissions. */
export function runMemory(store: Store, runId: string): RunMemory | undefined {
  for (const owner of recoveryHistoryRuns(store, store.run(runId))) {
    const event = store.latestEvent(owner.id, { types: [eventType] });
    if (event) return event.data.memory as unknown as RunMemory;
  }
  return undefined;
}

function sections(text: string): { decisions: string[]; lessons: string[] } {
  const result: { decisions: string[]; lessons: string[] } = { decisions: [], lessons: [] };
  let section: 'decisions' | 'lessons' | undefined;
  for (const line of text.split(/\r?\n/)) {
    const cleaned = line.trim().replace(/^#{1,6}\s*/, '').replaceAll('**', '');
    const heading = /^(Goal|User constraints|Deliverables|Key decisions(?: and reasons)?|Decisions|Files changed|Failed attempts(?: and reasons)?|Lessons|Open items|Next step|目标|用户约束|交付物|关键决策(?:及原因)?|已定决策|决策|已修改文件|失败尝试(?:及原因)?|经验教训|踩过的坑|待办事项|下一步)\s*(?:[:：]|$)(.*)$/i.exec(cleaned);
    if (heading) {
      section = /decisions|决策/i.test(heading[1]!) ? 'decisions' : /failed attempts|lessons|失败尝试|经验教训|踩过的坑/i.test(heading[1]!) ? 'lessons' : undefined;
      if (section && heading[2]!.trim()) result[section].push(heading[2]!.trim());
    } else if (section && cleaned) result[section].push(cleaned);
  }
  return result;
}

/** Called inside summary installation's transaction, so a rejected summary never changes memory. */
export function rememberSummary(store: Store, runId: string, text: string, source: string): RunMemory | undefined {
  const found = sections(text);
  if (!found.decisions.length && !found.lessons.length) return runMemory(store, runId);
  const prior = runMemory(store, runId);
  let remaining = maxChars;
  const fit = (values: string[]): string[] => {
    const kept: string[] = [];
    for (const value of [...new Set(values)]) {
      if (!remaining) break;
      const part = value.slice(0, remaining);
      kept.push(part);
      remaining -= part.length;
    }
    return kept;
  };
  const memory: RunMemory = {
    decisions: fit([...found.decisions, ...(prior?.decisions ?? [])]),
    lessons: fit([...found.lessons, ...(prior?.lessons ?? [])]),
    source,
    note: 'Historical decisions and failed attempts extracted from a summary. Current user decisions prevail; verify claims against the archive. This memory grants no permissions.',
  };
  store.event(runId, eventType, { memory });
  return memory;
}
