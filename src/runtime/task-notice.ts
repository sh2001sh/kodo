/**
 * Inline budget of one task completion notice, in UTF-8 bytes. Like OpenCode's tool truncation
 * (50 KiB) and DeepSeek harness `spill-policy` (50,000 bytes), a larger notice is stored in full
 * and the model receives a bounded preview with a pointer to the stored copy.
 */
export const taskNoticeMaxBytes = 50 * 1024;

export const taskNoticeHint = 'The complete notice is stored as an artifact. Do not read all of it yourself: delegate an explorer task that searches it with read({ artifact, contentOffset, maxChars }) and reports only the facts you need, or read just the page you need.';

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** Head and tail of `text`, each about `keep / 2` characters, with the omitted count between them. */
function headTail(text: string, keep: number): string {
  if (text.length <= keep) return text;
  let head = Math.ceil(keep / 2), tail = text.length - Math.floor(keep / 2);
  // Never split a surrogate pair.
  if (/[\uD800-\uDBFF]/u.test(text[head - 1] ?? '')) head--;
  if (/[\uDC00-\uDFFF]/u.test(text[tail] ?? '')) tail++;
  return `${text.slice(0, head)}\n…${tail - head} characters omitted…\n${text.slice(tail)}`;
}

/**
 * The notice the model receives: the notice itself when it fits `maxBytes`, otherwise a preview
 * that keeps every small decision field, a head/tail excerpt of the long text fields, and a read
 * pointer to the full notice. `store` persists the full notice and returns its artifact ID.
 */
export function boundTaskNotice(notice: Record<string, unknown>, store: (full: Record<string, unknown>) => string, maxBytes = taskNoticeMaxBytes): string {
  const total = bytes(notice);
  if (total <= maxBytes) return JSON.stringify(notice);
  const artifact = store(notice);
  const details = { tool: 'read', args: { artifact } };
  const truncated = { originalBytes: total, details, hint: taskNoticeHint };
  const long = Object.keys(notice).filter(key => typeof notice[key] === 'string' && Buffer.byteLength(notice[key] as string, 'utf8') > 1000);
  const omitted = { omitted: true, details };
  // Trim long text first; then drop structured fields that have no useful excerpt; finally keep only scalars.
  const shapes: Record<string, unknown>[] = [
    { ...notice },
    { ...notice, evidence: omitted },
    Object.fromEntries(Object.entries(notice).map(([key, value]) => [key, value === null || ['string', 'number', 'boolean'].includes(typeof value) ? value : omitted])),
  ];
  for (const shape of shapes) {
    for (let keep = 16_000; keep >= 64; keep = Math.floor(keep / 2)) {
      const preview = { ...shape, ...Object.fromEntries(long.map(key => [key, headTail(notice[key] as string, keep)])), truncated };
      if (bytes(preview) <= maxBytes) return JSON.stringify(preview);
    }
  }
  return JSON.stringify({ task: notice.task, state: notice.state, truncated });
}
