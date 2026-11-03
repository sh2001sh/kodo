import stringWidth from 'string-width';
import { terminalText } from '../cli/terminal.js';

const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' });
export interface Draft { text: string; cursor: number; literal: boolean }
export interface InputKey {
  leftArrow?: boolean; rightArrow?: boolean; upArrow?: boolean; downArrow?: boolean;
  backspace?: boolean; delete?: boolean; home?: boolean; end?: boolean; ctrl?: boolean;
}
export const emptyDraft = (): Draft => ({ text: '', cursor: 0, literal: false });
const boundaries = (text: string): number[] => [...segmenter.segment(text)].map(part => part.index).concat(text.length);
const removeText = (draft: Draft, from: number, to: number): Draft => {
  const text = draft.text.slice(0, from) + draft.text.slice(to);
  return { text, cursor: from, literal: Boolean(text) && draft.literal };
};
export function insertText(draft: Draft, value: string, literal = false): Draft {
  const text = terminalText(value.replaceAll('\r\n', '\n').replaceAll('\r', '\n'));
  const combined = draft.text.slice(0, draft.cursor) + text + draft.text.slice(draft.cursor);
  return { text: combined, cursor: draft.cursor + text.length, literal: Boolean(combined) && (draft.literal || literal || text.includes('\n')) };
}

/** Cursor offsets are UTF-16 indices, but deletion and movement preserve grapheme clusters. */
export function editInput(draft: Draft, input: string, key: InputKey): Draft {
  const start = draft.cursor ? draft.text.lastIndexOf('\n', draft.cursor - 1) + 1 : 0;
  const ending = draft.text.indexOf('\n', draft.cursor);
  const end = ending < 0 ? draft.text.length : ending;
  if (key.leftArrow || key.rightArrow || key.backspace || key.delete || key.ctrl && ['b', 'f'].includes(input)) {
    const points = boundaries(draft.text);
    const previous = points.findLast(point => point < draft.cursor) ?? 0;
    const next = points.find(point => point > draft.cursor) ?? draft.text.length;
    if (key.leftArrow || key.ctrl && input === 'b') return { ...draft, cursor: previous };
    if (key.rightArrow || key.ctrl && input === 'f') return { ...draft, cursor: next };
    return key.backspace ? removeText(draft, previous, draft.cursor) : removeText(draft, draft.cursor, next);
  }
  if (key.home || (key.ctrl && input === 'a')) return { ...draft, cursor: start };
  if (key.end || (key.ctrl && input === 'e')) return { ...draft, cursor: end };
  if (key.ctrl && input === 'u') return removeText(draft, start, draft.cursor);
  if (key.ctrl && input === 'k') return removeText(draft, draft.cursor, end);
  if (key.ctrl && input === 'w') {
    const before = draft.text.slice(start, draft.cursor);
    const from = start + before.replace(/\s*\S+\s*$/u, '').length;
    return removeText(draft, from, draft.cursor);
  }
  if (key.upArrow || key.downArrow) {
    const column = stringWidth(draft.text.slice(start, draft.cursor));
    const targetStart = key.upArrow ? start > 1 ? draft.text.lastIndexOf('\n', start - 2) + 1 : 0 : end + 1;
    if (key.upArrow ? start === 0 : end === draft.text.length) return draft;
    const nextEnd = draft.text.indexOf('\n', targetStart);
    const line = draft.text.slice(targetStart, nextEnd < 0 ? undefined : nextEnd);
    let cursor = targetStart;
    let used = 0;
    for (const part of segmenter.segment(line)) {
      if (used + stringWidth(part.segment) > column) break;
      used += stringWidth(part.segment); cursor += part.segment.length;
    }
    return { ...draft, cursor };
  }
  if (key.ctrl) return draft;
  return insertText(draft, input);
}

/** Wrap by terminal cells, including CJK and combining sequences; no ANSI from evidence survives. */
export function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  const maximum = Math.max(1, width);
  for (const source of terminalText(text).replaceAll('\t', '  ').split('\n')) {
    let line = '', cells = 0;
    for (const part of segmenter.segment(source)) {
      const size = stringWidth(part.segment);
      if (cells > 0 && cells + size > maximum) { lines.push(line); line = ''; cells = 0; }
      // A one-column emergency viewport cannot represent a wide glyph.
      if (size > maximum) { if (line) lines.push(line); lines.push('?'); line = ''; cells = 0; continue; }
      line += part.segment; cells += size;
    }
    lines.push(line);
  }
  return lines;
}

export function inputLines(draft: Draft, width: number, height = 4): { lines: string[]; hidden: number; cursor: { column: number; row: number } } {
  const marked = draft.text.slice(0, draft.cursor) + '▏' + draft.text.slice(draft.cursor);
  const lines = wrapText(marked || '▏', width);
  const cursorLines = wrapText(draft.text.slice(0, draft.cursor) + '▏', width);
  const cursorLine = cursorLines.length - 1;
  const start = Math.max(0, Math.min(cursorLine - height + 1, lines.length - height));
  return { lines: lines.slice(start, start + height), hidden: Math.max(0, lines.length - height), cursor: { column: stringWidth(cursorLines.at(-1)!) - 1, row: cursorLine - start } };
}
