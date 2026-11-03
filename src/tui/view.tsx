import { readFileSync } from 'node:fs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useCursor, useInput, usePaste, useStdout } from 'ink';
import { terminalText } from '../cli/terminal.js';
import { errorText } from '../runtime/types.js';
import { editDraft } from './editor.js';
import { auxiliaryCommands, helpPanel } from './commands.js';
import { KODO_BRAND, KODO_MARK_LINES, KODO_MARK_COMPACT_LINES } from './brand.js';
import { createTuiInterrupt } from './interrupt.js';
import { editInput, emptyDraft, inputLines, insertText, wrapText } from './input.js';
import type { Draft } from './input.js';
import type { TuiActions, TuiEntry, TuiItem, TuiSnapshot } from './types.js';

const theme = { muted: KODO_BRAND.graphite, warning: '#D0AD71', error: '#E18D8D' };
const version = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const roles: Record<TuiEntry['kind'], string> = { user: 'You', assistant: 'Kodo', tool: 'Tool', error: 'Error', notice: 'Note' };
const statusLabels: Record<string, string> = { queued: 'Queued', running: 'Running', waiting: 'Waiting', waiting_user: 'Needs input', interrupted: 'Interrupted', cancelled: 'Cancelled', completed: 'Finished', failed: 'Failed', idle: 'Ready', stopping: 'Stopping' };
const statusText = (status: string) => statusLabels[status] ?? status;
const safe = (text: string | undefined): string => terminalText(text ?? '');
const isSuccessfulRead = (entry: TuiEntry) => entry.kind === 'tool' && ['succeeded', 'completed'].includes(entry.status ?? '') && /file\.(?:read|list|search)|读取|检索/u.test(entry.title ?? '');

export interface TranscriptLine { text: string; kind: TuiEntry['kind'] }
const transcriptBlocks = new WeakMap<TuiEntry, { title: string; text: string; columns: number; lines: TranscriptLine[] }>();
/** Only the visible page becomes React nodes; large tool bodies stay behind the log action. */
export function visibleTranscript(entries: TuiEntry[], columns: number, rows: number, offset = 0, expanded = false): { lines: TranscriptLine[]; hasOlder: boolean; offset: number } {
  const blocks: TranscriptLine[][] = [];
  let lineCount = 0;
  let index = entries.length - 1;
  const needed = Math.max(1, rows) + Math.max(0, offset);
  while (index >= 0 && lineCount < needed) {
    const entry = entries[index--]!;
    let text = entry.text;
    let title = safe(`${roles[entry.kind]}${entry.title ? ` · ${entry.title}` : ''}${entry.status ? ` · ${statusText(entry.status)}` : ''}`);
    if (!expanded && isSuccessfulRead(entry)) {
      let count = 1;
      while (index >= 0) {
        const before = entries[index]!;
        if (!isSuccessfulRead(before)) break;
        index--; count++;
      }
      title = `Tool · ${count} reads / searches completed`;
      text = 'Ctrl+O to expand · /tasks logs for evidence';
    } else if (entry.kind === 'tool' && !expanded) text = text.split('\n', 2).join('\n');
    else if (expanded && entry.details?.length) text += `\n${entry.details.join('\n')}`;
    if (entry.kind === 'tool' && text.length > 8_000) text = `${text.slice(0, 8_000)}\n[Preview truncated; /tasks logs for full evidence]`;
    let cached = transcriptBlocks.get(entry);
    if (!cached || cached.columns !== columns || cached.title !== title || cached.text !== text) {
      const block = [title, ...wrapText(text, Math.max(1, columns - 2)).map(line => `  ${line}`), ''];
      cached = { title, text, columns, lines: block.map(line => ({ text: line, kind: entry.kind })) };
      transcriptBlocks.set(entry, cached);
    }
    blocks.push(cached.lines);
    lineCount += cached.lines.length;
  }
  const boundedOffset = Math.min(Math.max(0, offset), Math.max(0, lineCount - rows));
  const end = lineCount - boundedOffset;
  const start = Math.max(0, end - rows);
  const lines: TranscriptLine[] = [];
  let position = 0;
  for (let blockIndex = blocks.length - 1; blockIndex >= 0 && position < end; blockIndex--) {
    const block = blocks[blockIndex]!;
    if (position + block.length > start) lines.push(...block.slice(Math.max(0, start - position), end - position));
    position += block.length;
  }
  return { lines, hasOlder: index >= 0 || end > rows, offset: boundedOffset };
}

export interface KodoTuiProps {
  controller: TuiActions;
  columns?: number;
  rows?: number;
  onInterrupt?: (onNotice?: (text: string) => void) => Promise<void>;
  externalEditor?: (text: string) => Promise<string>;
}

export function KodoTui({ controller, columns: configuredColumns, rows: configuredRows, onInterrupt, externalEditor }: KodoTuiProps) {
  const { exit, suspendTerminal } = useApp();
  const { setCursorPosition } = useCursor();
  const { stdout: output } = useStdout();
  const stdout = output as NodeJS.WriteStream;
  const [size, setSize] = useState(() => ({ columns: configuredColumns ?? stdout.columns ?? 80, rows: configuredRows ?? stdout.rows ?? 24 }));
  const [snapshot, setSnapshot] = useState<TuiSnapshot>(() => controller.snapshot());
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState(0);
  const [panelScroll, setPanelScroll] = useState(0);
  const [scroll, setScroll] = useState<{ offset: number; frozen?: TuiEntry[] }>({ offset: 0 });
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(false);
  const [dismissedCompletion, setDismissedCompletion] = useState('');
  const [completionIndex, setCompletionIndex] = useState(0);
  const [fileSuggestions, setFileSuggestions] = useState<{ key: string; items: TuiItem[]; error?: string }>({ key: '', items: [] });
  const editingRef = useRef(false);
  const sending = useRef(false);
  const pendingControls = useRef(new Set<string>());
  const fileCompletion = useRef<{ before: string; after: string; literal: boolean } | undefined>(undefined);
  const defaultInterrupt = useMemo(() => createTuiInterrupt(controller, { onNotice: setNotice }), [controller]);
  const completionTarget = useMemo(() => {
    if (snapshot.panel || draft.literal) return undefined;
    const before = draft.text.slice(0, draft.cursor);
    const slash = /^\/([^\s/]*)$/u.exec(before);
    const key = `${draft.text}\0${draft.cursor}`;
    if (slash && !draft.text.slice(draft.cursor).trim()) return { kind: 'command' as const, query: slash[1]!, from: 0, key };
    const file = /(?:^|\s)@(?:"([^"\n]*)|([^\s"@]*))$/u.exec(before);
    if (file) return { kind: 'file' as const, query: file[1] ?? file[2] ?? '', from: before.lastIndexOf('@'), key };
    return undefined;
  }, [snapshot.panel, draft]);
  const completing = completionTarget && completionTarget.key !== dismissedCompletion ? completionTarget : undefined;
  const completionItems = useMemo(() => {
    if (completing?.kind === 'file') return fileSuggestions.key === completing.key ? fileSuggestions.items : [];
    if (completing?.kind !== 'command') return [];
    const primary = helpPanel().items ?? [];
    return (completing.query ? [...primary, ...auxiliaryCommands] : primary).filter(item => item.id.startsWith(completing.query.toLowerCase()));
  }, [completing, fileSuggestions]);
  useEffect(() => { setCompletionIndex(0); }, [completionTarget?.key]);
  useEffect(() => {
    if (completing?.kind !== 'file' || !controller.completeFiles) return;
    let active = true;
    const timer = setTimeout(() => {
      void controller.completeFiles!(completing.query).then(items => {
        if (active) setFileSuggestions({ key: completing.key, items });
      }, error => {
        if (active) setFileSuggestions({ key: completing.key, items: [], error: safe(errorText(error)) });
      });
    }, 60);
    return () => { active = false; clearTimeout(timer); };
  }, [completing?.kind, completing?.key, completing?.query, controller]);

  useEffect(() => {
    const update = () => { if (!editingRef.current) setSnapshot(controller.snapshot()); };
    const unsubscribe = controller.subscribe(update);
    update();
    return unsubscribe;
  }, [controller]);
  useEffect(() => {
    const resize = () => { if (!editingRef.current) setSize({ columns: configuredColumns ?? stdout.columns ?? 80, rows: configuredRows ?? stdout.rows ?? 24 }); };
    stdout.on('resize', resize);
    resize();
    return () => { stdout.off('resize', resize); };
  }, [stdout, configuredColumns, configuredRows, editing]);
  useEffect(() => { if (snapshot.quitting) exit(); }, [snapshot.quitting, exit]);
  const panelPage = snapshot.panel ? `${snapshot.panel.title}\n${snapshot.panel.lines.join('\n')}\n${snapshot.panel.items?.map(item => item.id).join('\n') ?? ''}` : '';
  useEffect(() => { setFilter(''); setSelected(0); setPanelScroll(0); }, [panelPage]);

  const dispatch = useCallback((text: string, options?: { literal?: boolean }, recovery?: Draft) => {
    const control = !options?.literal && /^\/(?:stop(?:\s+all)?|cancel|quit(?:\s+(?:confirm|back))?|permissions(?:\s+.*)?)$/u.test(text.trim()) ? text.trim().replace(/\s+/gu, ' ') : undefined;
    if (control) {
      if (pendingControls.current.has(control)) return false;
      pendingControls.current.add(control);
    } else {
      if (sending.current) return false;
      sending.current = true;
    }
    setNotice('');
    void controller.submit(text, options).catch(error => {
      setNotice(safe(errorText(error)));
      if (recovery) setDraft(current => current.text ? insertText({ ...recovery, cursor: recovery.text.length }, `\n${current.text}`, current.literal) : recovery);
    }).finally(() => {
      if (control) pendingControls.current.delete(control);
      else sending.current = false;
    });
    return true;
  }, [controller]);
  const interrupt = () => { void (onInterrupt ? onInterrupt(setNotice) : defaultInterrupt()).catch(error => setNotice(safe(errorText(error)))); };
  const edit = async () => {
    if (editingRef.current) return;
    editingRef.current = true; setEditing(true);
    try {
      await suspendTerminal(async () => {
        const content = await (externalEditor ?? editDraft)(draft.text);
        setDraft(insertText(emptyDraft(), content, true));
      });
    } catch (error) { setNotice(safe(errorText(error))); }
    finally {
      editingRef.current = false; setEditing(false); setSnapshot(controller.snapshot());
    }
  };

  const columns = Math.max(8, size.columns), rows = Math.max(5, size.rows);
  const tiny = rows < 10;
  const headerHeight = tiny ? 1 : 2;
  const side = Boolean(snapshot.panel && columns >= 120 && /task|collaboration/iu.test(snapshot.panel.title));
  const contentWidth = side ? columns - 36 : columns;
  const suggestionHeight = completing && rows >= 9 ? Math.min(5, Math.max(1, completionItems.length), rows - headerHeight - 4) : 0;
  const chromeHeight = headerHeight + 3 + suggestionHeight;
  const input = inputLines(draft, Math.max(1, columns - 6), Math.max(1, Math.min(tiny ? 1 : 4, rows - chromeHeight - 1)));
  const bodyHeight = Math.max(0, rows - input.lines.length - chromeHeight);
  const pageSize = Math.max(1, bodyHeight - 2);
  const items = useMemo(() => {
    const choices = snapshot.panel?.items ?? [];
    const searchable = filter && /commands/iu.test(snapshot.panel?.title ?? '') ? [...choices, ...auxiliaryCommands] : choices;
    return searchable.filter(item => !filter || `${item.label} ${item.detail ?? ''}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  }, [snapshot.panel?.items, snapshot.panel?.title, filter]);
  const index = Math.min(selected, Math.max(0, items.length - 1));

  const selectItem = (item: TuiItem | undefined) => {
    if (!item || item.disabled) { if (item?.disabled) setNotice('Unavailable. Check dependencies and status.'); return; }
    if (item.input !== undefined) {
      let text = item.input;
      let cursor = text.length;
      let literal = false;
      if (fileCompletion.current !== undefined && text.startsWith('@')) {
        const completion = fileCompletion.current;
        cursor += completion.before.length;
        text = completion.before + text + completion.after;
        literal = completion.literal;
        fileCompletion.current = undefined;
      }
      setDraft({ text, cursor, literal });
      setDismissedCompletion(`${text}\0${cursor}`);
      controller.dismissPanel();
    } else if (item.command) dispatch(item.command);
  };

  const chooseCompletion = (item: TuiItem, tab = false) => {
    if (!completing) return;
    if (completing.kind === 'file') {
      const after = draft.text.slice(draft.cursor);
      const inserted = item.input ?? `@${item.id}`;
      const separator = after.startsWith(' ') ? '' : ' ';
      const text = draft.text.slice(0, completing.from) + inserted + separator + after;
      const cursor = completing.from + inserted.length + separator.length;
      setDraft({ text, cursor, literal: draft.literal });
      setDismissedCompletion(`${text}\0${cursor}`);
    } else if (tab || item.input !== undefined) {
      const text = item.input ?? `${item.command ?? `/${item.id}`} `;
      setDraft({ text, cursor: text.length, literal: false });
    } else if (item.command && dispatch(item.command, { literal: false }, draft)) {
      setDraft(emptyDraft()); setScroll({ offset: 0 });
    }
  };

  useInput((value, key) => {
    if (key.eventType === 'release' || key.eventType === 'repeat' && (key.return || key.ctrl)) return;
    if (key.ctrl && value === 'c') { interrupt(); return; }
    if (key.ctrl && value === 'p') { setFilter(''); setSelected(0); setPanelScroll(0); dispatch('/help'); return; }
    if (key.ctrl && value === 'o') { setExpanded(previous => !previous); return; }
    if (key.ctrl && value === 'g') { void edit(); return; }
    if (key.tab && key.shift) { dispatch('/permissions'); return; }
    if (key.escape) {
      if (snapshot.panel) { controller.dismissPanel(); fileCompletion.current = undefined; }
      else if (completing) setDismissedCompletion(completing.key);
      else if (!draft.text && snapshot.busy) interrupt();
      return;
    }
    if (completing && !snapshot.panel && suggestionHeight > 0) {
      if (key.upArrow || key.downArrow) { setCompletionIndex(current => completionItems.length ? (current + (key.upArrow ? -1 : 1) + completionItems.length) % completionItems.length : 0); return; }
      if ((key.return && !key.shift && !key.meta || key.tab) && completionItems.length) {
        chooseCompletion(completionItems[Math.min(completionIndex, completionItems.length - 1)]!, key.tab); return;
      }
      // Enter belongs to an open file picker, including its loading/empty state.
      // Esc or a space returns to ordinary submission; a slow scan must not send a task.
      if (completing.kind === 'file' && key.return && !key.shift && !key.meta) return;
    }
    if (snapshot.panel) {
      if (key.return) { selectItem(items[index]); return; }
      if (key.downArrow || (key.tab && !key.shift)) { setSelected(current => items.length ? (current + 1) % items.length : 0); return; }
      if (key.upArrow || (key.tab && key.shift)) { setSelected(current => items.length ? (current + items.length - 1) % items.length : 0); return; }
      if (key.pageUp || key.pageDown) {
        const change = key.pageUp ? -linesAllowance : linesAllowance;
        setPanelScroll(current => Math.max(0, Math.min(Math.max(0, panelContent.length - linesAllowance), current + change)));
        return;
      }
      if (key.backspace || key.delete) { setFilter(current => [...segmenterForFilter.segment(current)].slice(0, -1).map(part => part.segment).join('')); setSelected(0); return; }
      if (!key.ctrl && !key.meta && value) { setFilter(current => current + safe(value).replaceAll('\n', '')); setSelected(0); }
      return;
    }
    if (key.pageUp) {
      setScroll(current => {
        const frozen = current.frozen ?? snapshot.entries.map(entry => ({ ...entry }));
        const page = visibleTranscript(frozen, contentWidth, bodyHeight, current.offset + pageSize, expanded);
        return page.offset ? { frozen, offset: page.offset } : { offset: 0 };
      });
      return;
    }
    if (key.pageDown) { setScroll(current => current.offset <= pageSize ? { offset: 0 } : { ...current, offset: current.offset - pageSize }); return; }
    if (key.tab) {
      const match = /(?:^|\s)@([^\s]*)$/u.exec(draft.text.slice(0, draft.cursor));
      if (match) {
        const at = draft.text.lastIndexOf('@', draft.cursor - 1);
        fileCompletion.current = { before: draft.text.slice(0, at), after: draft.text.slice(draft.cursor), literal: draft.literal };
        dispatch(`/files ${match[1] ?? ''}`);
      } else dispatch('/help');
      return;
    }
    // Ink delivers a bracketed/multiline paste as text. Never interpret its line breaks as Enter.
    if (value.includes('\n') || (value.includes('\r') && !key.return) || value.length > 1 && value.includes('\r')) { setDraft(current => insertText(current, value, true)); return; }
    if (key.return && key.shift) { setDraft(current => insertText(current, '\n', true)); return; }
    if (key.return) {
      if (!draft.text.trim()) return;
      const text = key.meta ? `/next ${draft.text}` : !draft.literal && draft.text.trim() === '/' ? '/help' : draft.text;
      if (dispatch(text, { literal: key.meta ? false : draft.literal }, draft)) {
        setDraft(emptyDraft()); setScroll({ offset: 0 });
      }
      return;
    }
    setDraft(current => editInput(current, value, key));
  }, { isActive: !editing });

  usePaste(text => {
    if (snapshot.panel) { setFilter(current => current + safe(text).replaceAll('\n', ' ')); setSelected(0); }
    else setDraft(current => insertText(current, text, true));
  }, { isActive: !editing });

  const transcript = useMemo(() => visibleTranscript(scroll.frozen ?? snapshot.entries, contentWidth, bodyHeight, scroll.offset, expanded), [scroll.frozen, scroll.offset, snapshot.entries, contentWidth, bodyHeight, expanded]);
  const newEntries = useMemo(() => {
    if (!scroll.frozen) return 0;
    const known = new Map(scroll.frozen.map(entry => [entry.id, entry]));
    return snapshot.entries.reduce((count, entry) => {
      const previous = known.get(entry.id);
      return count + (!previous || previous.text !== entry.text || previous.status !== entry.status || previous.title !== entry.title ? 1 : 0);
    }, 0);
  }, [scroll.frozen, snapshot.entries]);
  const colored = !process.env.NO_COLOR && process.env.TERM !== 'dumb';
  const color = (kind: 'accent' | 'muted' | 'warning' | 'error') => colored && kind !== 'accent' ? theme[kind] : undefined;
  const entryColor = (kind: TuiEntry['kind']) => kind === 'error' ? color('error') : kind === 'notice' || kind === 'tool' ? color('muted') : undefined;
  const panel = snapshot.panel;
  const panelWidth = side ? 34 : contentWidth;
  const panelContent = useMemo(() => panel ? panel.lines.flatMap(line => wrapText(line, panelWidth - 2)) : [], [panel, panelWidth]);
  const linesAllowance = Math.max(1, bodyHeight - 4 - Math.min(items.length, 5));
  const start = Math.min(panelScroll, Math.max(0, panelContent.length - linesAllowance));
  const itemHeight = Math.max(1, bodyHeight - Math.min(panelContent.length, linesAllowance) - 4);
  const itemStart = Math.max(0, Math.min(index - Math.floor(itemHeight / 2), items.length - itemHeight));
  const panelView = panel && <Box width={panelWidth} flexDirection="column" height={bodyHeight} overflow="hidden">
    <Text bold color={color('accent')} wrap="truncate">{safe(panel.title)}</Text>
    {panelContent.slice(start, start + linesAllowance).map((line, lineIndex) => <Text key={`line-${start + lineIndex}`} wrap="truncate">{line}</Text>)}
    {panel.items && <Text dimColor wrap="truncate">{filter ? `Filter: ${filter}` : 'Type to filter · Up/Down to select'}</Text>}
    {items.slice(itemStart, itemStart + itemHeight).map((item, itemIndex) => <Text key={item.id} color={index === itemStart + itemIndex ? color('accent') : undefined} dimColor={item.disabled} wrap="truncate">{index === itemStart + itemIndex ? '> ' : '  '}{safe(item.label)}</Text>)}
    {panel.items && !items.length && <Text color={color('warning')}>No matches. Edit the filter.</Text>}
    <Text dimColor wrap="truncate">{safe(items[index]?.detail ?? panel.hint ?? 'Enter to select · Esc to return')}</Text>
    {panelContent.length > linesAllowance && <Text dimColor wrap="truncate">PageUp / PageDown · {start + 1}/{panelContent.length}</Text>}
  </Box>;

  const completionStart = Math.max(0, Math.min(completionIndex - Math.floor(suggestionHeight / 2), completionItems.length - suggestionHeight));
  const completionMessage = completing?.kind === 'file' ? fileSuggestions.key === completing.key ? fileSuggestions.error ?? 'No matching files.' : controller.completeFiles ? 'Searching files...' : 'Press Tab to browse files.' : 'No matching commands.';
  const permissionMode = snapshot.permissionMode === 'yolo' ? 'YOLO' : 'Ask';
  const footer = notice || safe(snapshot.notice) || (scroll.frozen ? `History · ${newEntries} new · PageDown for latest` : snapshot.questions.length ? `${snapshot.questions.length} questions · /tasks answer` : snapshot.queue.length ? `${snapshot.queue.length} queued · /next` : snapshot.busy ? `${safe(snapshot.model)} · ${statusText(snapshot.status)} · Ctrl+C to interrupt` : `${safe(snapshot.model || 'No model selected')} · /permissions · / commands · @ files`);
  setCursorPosition(editing || panel ? undefined : { x: 4 + input.cursor.column, y: headerHeight + bodyHeight + suggestionHeight + 1 + input.cursor.row });
  if (editing) return <Text dimColor>Editing input. Save and close the editor to return.</Text>;
  return <Box width={columns} height={rows} flexDirection="column" overflow="hidden">
    <Text bold wrap="truncate">{'>_ '}{KODO_BRAND.name} <Text dimColor>(v{version})</Text>{panel ? <Text dimColor> · {safe(panel.title)}</Text> : ''}</Text>
    {headerHeight > 1 && <Text dimColor wrap="truncate-middle">{safe(snapshot.workspace)}</Text>}
    <Box height={bodyHeight} flexDirection="row" overflow="hidden">
      {(!panel || side) && <Box width={contentWidth} flexDirection="column" overflow="hidden">
        {!snapshot.entries.length ? !completing && <BrandHome columns={contentWidth} rows={bodyHeight} color={color('muted')} /> : transcript.lines.map((line, lineIndex) => <Text key={lineIndex} color={entryColor(line.kind)} wrap="truncate">{line.text || ' '}</Text>)}
      </Box>}
      {side && <Text dimColor>│ </Text>}
      {panelView}
    </Box>
    {suggestionHeight > 0 && <Box height={suggestionHeight} flexDirection="column" overflow="hidden">
      {completionItems.length ? completionItems.slice(completionStart, completionStart + suggestionHeight).map((item, itemIndex) => <Text key={item.id} bold={completionIndex === completionStart + itemIndex} dimColor={completionIndex !== completionStart + itemIndex} wrap="truncate">{completionIndex === completionStart + itemIndex ? '> ' : '  '}{safe(item.label)}</Text>) : <Text dimColor wrap="truncate">{completionMessage}</Text>}
    </Box>}
    <Box width={columns} height={input.lines.length + 2} flexShrink={0} borderStyle="round" borderColor={color('muted')} paddingX={1} flexDirection="column">
      {input.lines.map((line, lineIndex) => <Text key={lineIndex} wrap="truncate">{lineIndex ? '  ' : '› '}{!draft.text && !panel ? <Text dimColor>Ask Kodo to do anything</Text> : line}</Text>)}
    </Box>
    <Text dimColor wrap="truncate">{permissionMode} · {panel && !notice && !snapshot.notice ? 'Enter to select · Esc to return' : footer}</Text>
  </Box>;
}

function BrandHome({ columns, rows, color }: { columns: number; rows: number; color?: string }) {
  const lines = rows >= 16 && columns >= 40 ? KODO_MARK_LINES : KODO_MARK_COMPACT_LINES;
  if (rows < lines.length || columns < 24) return null;
  return <Box width={columns} height={rows} justifyContent="center" alignItems="center" flexDirection="column"><Text aria-hidden color={color}>{lines.join('\n')}</Text></Box>;
}

const segmenterForFilter = new Intl.Segmenter('zh', { granularity: 'grapheme' });
