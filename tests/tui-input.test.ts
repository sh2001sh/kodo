import { readFileSync } from 'node:fs';
import path from 'node:path';
import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';
import { editInput, emptyDraft, inputLines, insertText, wrapText } from '../src/tui/input.js';
import { editDraft, editorArguments } from '../src/tui/editor.js';
import { temp } from './helpers.js';

describe('TUI Unicode input and literal paste', () => {
  it('moves and removes complete CJK, emoji and combining graphemes', () => {
    let draft = insertText(emptyDraft(), '中e\u0301👨‍👩‍👧文');
    draft = editInput(draft, '', { leftArrow: true });
    expect(draft.text.slice(draft.cursor)).toBe('文');
    draft = editInput(draft, '', { backspace: true });
    expect(draft.text).toBe('中e\u0301文');
    draft = editInput(draft, '', { backspace: true });
    expect(draft.text).toBe('中文');
    expect(draft.cursor).toBe(1);
    draft = editInput(draft, '', { delete: true });
    expect(draft.text).toBe('中');
  });

  it('normalizes pasted line endings and keeps slash commands as literal input', () => {
    const draft = insertText(emptyDraft(), '/quit\r\n中文\r/end', true);
    expect(draft).toEqual({ text: '/quit\n中文\n/end', cursor: 13, literal: true });
    expect(insertText(emptyDraft(), '/quit', true).literal).toBe(true);
    expect(insertText(emptyDraft(), '\u001b[31m数据\u001b[0m\u0007', true).text).toBe('数据');
  });

  it('resets literal paste semantics after all draft content is removed', () => {
    const pasted = insertText(emptyDraft(), '/help\r', true);
    const joined = editInput(pasted, '', { backspace: true });
    expect(joined.literal).toBe(true);
    const cleared = editInput(joined, 'u', { ctrl: true });
    expect(cleared).toEqual(emptyDraft());
    expect(insertText(cleared, '/help').literal).toBe(false);
    expect(editInput(insertText(emptyDraft(), '中', true), '', { backspace: true }).literal).toBe(false);
    expect(editInput({ text: '中', cursor: 0, literal: true }, '', { delete: true }).literal).toBe(false);
    expect(editInput({ text: '中', cursor: 0, literal: true }, 'k', { ctrl: true }).literal).toBe(false);
    expect(editInput(insertText(emptyDraft(), '中', true), 'w', { ctrl: true }).literal).toBe(false);
  });

  it('keeps visual columns when moving between mixed-width lines', () => {
    const draft = { text: '中文ab\na中文\nlast', cursor: 4, literal: true };
    const down = editInput(draft, '', { downArrow: true });
    expect(down.cursor).toBe(8);
    expect(editInput(down, '', { home: true }).cursor).toBe(5);
    expect(editInput(down, 'u', { ctrl: true }).text).toBe('中文ab\n\nlast');
  });

  it('keeps the cursor before an initial blank line without duplicating input', () => {
    const draft = { text: '\n中文', cursor: 0, literal: true };
    expect(editInput(draft, '', { home: true })).toEqual(draft);
    expect(editInput(draft, 'u', { ctrl: true })).toEqual(draft);
    expect(editInput({ ...draft, cursor: 1 }, '', { upArrow: true }).cursor).toBe(0);
  });

  it('wraps terminal cells and shows the cursor within a bounded multiline editor', () => {
    const wrapped = wrapText('中文e\u0301abc\n次行', 5);
    expect(wrapped.join('')).toBe('中文e\u0301abc次行');
    expect(wrapped.every(line => stringWidth(line) <= 5)).toBe(true);
    const text = '第一行\n第二行\n第三行\n第四行\n第五行';
    const shown = inputLines({ text, cursor: text.length, literal: true }, 12, 2);
    expect(shown.lines).toHaveLength(2);
    expect(shown.lines.join('')).toContain('第五行▏');
    expect(shown.hidden).toBe(3);
    expect(shown.cursor).toEqual({ column: 6, row: 1 });
    const wrappedCursor = inputLines({ text: '中文a', cursor: 3, literal: false }, 5, 1);
    expect(wrappedCursor.lines).toEqual(['▏']);
    expect(wrappedCursor.cursor).toEqual({ column: 0, row: 0 });
  });
});

describe('TUI external editor argv and temporary files', () => {
  it('keeps executable paths and explicit arguments intact without a shell', () => {
    expect(editorArguments({ EDITOR: 'C:\\Program Files\\Editor\\edit.exe' })).toEqual(['C:\\Program Files\\Editor\\edit.exe']);
    expect(editorArguments({ EDITOR: '"C:\\Program Files\\Editor\\edit.exe" --wait' })).toEqual(['C:\\Program Files\\Editor\\edit.exe', '--wait']);
    expect(editorArguments({ KODO_EDITOR_JSON: '["editor","--wait","a b"]', EDITOR: 'ignored' })).toEqual(['editor', '--wait', 'a b']);
    expect(() => editorArguments({ EDITOR: 'editor | another' })).toThrow('shell');
    expect(() => editorArguments({ KODO_EDITOR_JSON: 'bad JSON' })).toThrow('JSON');
  });

  it('returns saved UTF-8 input and removes its own private temporary directory', async () => {
    const directory = temp();
    const marker = path.join(directory, 'editor-file.txt');
    const source = 'const fs=require("node:fs"); const file=process.argv.at(-1); fs.writeFileSync(process.argv[1],file); fs.appendFileSync(file,"\\n中文新增","utf8");';
    const result = await editDraft('原草稿', { environment: { KODO_EDITOR_JSON: JSON.stringify([process.execPath, '-e', source, marker]) } });
    expect(result).toBe('原草稿\n中文新增');
    const file = readFileSync(marker, 'utf8');
    expect(() => readFileSync(file, 'utf8')).toThrow();
  });

  it('reports editor failure instead of discarding the original draft', async () => {
    await expect(editDraft('保留的草稿', { environment: { KODO_EDITOR_JSON: JSON.stringify([process.execPath, '-e', 'process.exit(7)']) } })).rejects.toThrow('exit code 7');
  });
});
