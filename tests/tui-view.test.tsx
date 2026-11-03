import { cleanup, render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KodoTui, visibleTranscript } from '../src/tui/view.js';
import { KODO_MARK_LINES } from '../src/tui/brand.js';
import { helpPanel } from '../src/tui/commands.js';
import type { TuiActions, TuiEntry, TuiSnapshot } from '../src/tui/types.js';

afterEach(cleanup);
const tick = () => new Promise(resolve => setTimeout(resolve, 35));
function fixture(overrides: Partial<TuiSnapshot> = {}) {
  let state: TuiSnapshot = { workspace: 'E:/project/demo', model: 'fixture-model', status: 'idle', entries: [], tasks: [], questions: [], queue: [], usage: 'Context 0% (estimated) · Pricing not configured', busy: false, quitting: false, ...overrides };
  const listeners = new Set<() => void>();
  const update = (changes: Partial<TuiSnapshot>) => { state = { ...state, ...changes }; listeners.forEach(listener => listener()); };
  const submit = vi.fn(async (text: string) => {
    if (text === '/help') update({ panel: { title: 'Commands', lines: [], items: [{ id: 'tasks', label: 'Tasks', command: '/tasks' }, { id: 'agents', label: 'Agent library', command: '/agents' }] } });
    if (text === '/permissions') update({ panel: { title: 'Permissions', lines: ['Choose an approval mode.'], items: [{ id: 'ask', label: 'Ask', command: '/permissions ask' }, { id: 'yolo', label: 'YOLO', command: '/permissions yolo' }] } });
    if (text === '/tasks') update({ panel: { title: 'Tasks', lines: ['Main task · Running'], items: [{ id: 'child', label: 'Inspect child', command: '/tasks show child' }] } });
    if (text.startsWith('/files')) update({ panel: { title: '文件路径', lines: ['仅附路径，不读取正文'], items: [{ id: 'file', label: 'src/main.ts', input: '@src/main.ts' }] } });
  });
  const controller: TuiActions = {
    snapshot: () => state, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    submit, dismissPanel: () => update({ panel: undefined }), interrupt: vi.fn(async () => {}), quit: vi.fn(async () => update({ quitting: true })), onText() {}, close: vi.fn(async () => {}),
  };
  return { controller, submit, update, listeners };
}

describe('TUI terminal rendering and keyboard interaction', () => {
  it('opens a usable home without creating a model request', async () => {
    const f = fixture();
    const screen = render(<KodoTui controller={f.controller} columns={100} rows={24} />);
    await tick();
    expect(screen.lastFrame()).not.toContain('Know · Organize · Do');
    expect(screen.lastFrame()).not.toMatch(/\p{Script=Han}/u);
    expect(screen.lastFrame()).toMatch(/Kodo \(v\d+\.\d+\.\d+/u);
    expect(screen.lastFrame()).toContain('fixture-model');
    expect(screen.lastFrame()).toContain('E:/project/demo');
    expect(screen.lastFrame()).toContain(KODO_MARK_LINES.find(line => line.trim().length >= 5)!.trim());
    expect(screen.lastFrame()).toContain('Ask Kodo to do anything');
    expect(screen.lastFrame()).not.toContain('Pricing not configured');
    expect(f.submit).not.toHaveBeenCalled();
  });

  it('returns to a compact conversation header while preserving the unsent draft', async () => {
    const f = fixture();
    const screen = render(<KodoTui controller={f.controller} columns={100} rows={24} />);
    await tick(); screen.stdin.write('继续补充的草稿'); await tick();
    f.update({ entries: [{ id: 'response', kind: 'assistant', text: '已开始检查当前项目。' }], status: 'running', busy: true }); await tick();
    const frame = screen.lastFrame() ?? '';
    expect(frame).toContain('已开始检查当前项目。');
    expect(frame).toContain('继续补充的草稿');
    expect(frame).toContain('fixture-model');
    expect(frame).not.toContain('Know · Organize · Do');
    expect(frame).not.toContain(KODO_MARK_LINES.find(line => line.trim().length >= 5)!.trim());
    expect(f.submit).not.toHaveBeenCalled();
    screen.stdin.write('\r'); await tick();
    expect(f.submit).toHaveBeenCalledExactlyOnceWith('继续补充的草稿', { literal: false });
  });

  it('encloses the composer below the conversation and shows the active permission mode', async () => {
    const f = fixture({ permissionMode: 'ask', entries: [{ id: 'response', kind: 'assistant', text: 'Conversation above the input.' }] });
    const screen = render(<KodoTui controller={f.controller} columns={80} rows={24} />);
    await tick();
    const lines = (screen.lastFrame() ?? '').split('\n');
    expect(lines.at(-4)).toBe(`╭${'─'.repeat(78)}╮`);
    expect(lines.at(-3)).toMatch(/^│ › Ask Kodo to do anything\s+│$/u);
    expect(lines.at(-2)).toBe(`╰${'─'.repeat(78)}╯`);
    expect(lines.at(-1)).toContain('Ask · fixture-model · /permissions');
    expect(lines.slice(0, -4).join('\n')).toContain('Conversation above the input.');
    f.update({ permissionMode: 'yolo' }); await tick();
    expect(screen.lastFrame()).toContain('YOLO · fixture-model · /permissions');
    f.update({ notice: 'Approval is pending.' }); await tick();
    expect(screen.lastFrame()).toContain('YOLO · Approval is pending.');
  });

  it('wraps input inside its border while retaining multiline text for submission', async () => {
    const f = fixture();
    const screen = render(<KodoTui controller={f.controller} columns={48} rows={12} />);
    const draft = `${'a'.repeat(42)}\nsecond line`;
    await tick(); screen.stdin.write(`\u001b[200~${draft}\u001b[201~`); await tick();
    const lines = (screen.lastFrame() ?? '').split('\n');
    expect(lines.some(line => line.startsWith('│ › ') && line.endsWith(' │'))).toBe(true);
    expect(lines.some(line => line.includes('second line') && line.startsWith('│ ') && line.endsWith(' │'))).toBe(true);
    expect(lines.every(line => stringWidth(line) <= 48)).toBe(true);
    expect(lines.length).toBeLessThanOrEqual(12);
    screen.stdin.write('\r'); await tick();
    expect(f.submit).toHaveBeenCalledExactlyOnceWith(draft, { literal: true });
  });

  it.each(['Review this draft', '/mo'])('opens permissions with Shift+Tab without replacing the draft: %s', async draft => {
    const f = fixture();
    const screen = render(<KodoTui controller={f.controller} columns={80} rows={24} />);
    await tick(); screen.stdin.write(draft); await tick();
    screen.stdin.write('\u001b[Z'); await tick();
    expect(f.submit).toHaveBeenCalledExactlyOnceWith('/permissions', undefined);
    expect(screen.lastFrame()).toContain('Choose an approval mode.');
    expect(screen.lastFrame()).toContain(draft);
    screen.stdin.write('\u001b'); await tick();
    expect(screen.lastFrame()).toContain(draft);
    expect(f.submit).toHaveBeenCalledTimes(1);
  });

  it('opens permissions with Shift+Tab while another panel is open', async () => {
    const f = fixture({ panel: { title: 'Tasks', lines: ['Main task'], items: [{ id: 'child', label: 'Child task' }] } });
    const screen = render(<KodoTui controller={f.controller} columns={80} rows={24} />);
    await tick(); screen.stdin.write('\u001b[Z'); await tick();
    expect(f.submit).toHaveBeenCalledExactlyOnceWith('/permissions', undefined);
    expect(screen.lastFrame()).toContain('Choose an approval mode.');
    expect(screen.lastFrame()).not.toContain('Child task');
  });

  it.each([[48, 12], [59, 5], [60, 16], [80, 24]])('keeps a monochrome home and its input within a %i×%i terminal', async (columns, rows) => {
    vi.stubEnv('NO_COLOR', '1');
    try {
      const f = fixture({ workspace: `E:/${'很长的工作目录/'.repeat(20)}`, model: 'long-model-'.repeat(20) });
      const screen = render(<KodoTui controller={f.controller} columns={columns} rows={rows} />);
      await tick();
      const frame = screen.lastFrame() ?? '';
      expect(frame).toContain('› ');
      expect(frame.split('\n').every(line => stringWidth(line) <= columns)).toBe(true);
      expect(frame.trimEnd().split('\n').length).toBeLessThanOrEqual(rows);
      screen.stdin.write('中文任务'); await tick(); screen.stdin.write('\r'); await tick();
      expect(f.submit).toHaveBeenCalledExactlyOnceWith('中文任务', { literal: false });
    } finally { vi.unstubAllEnvs(); }
  });

  it('keeps twelve primary commands and discovers auxiliary commands only while searching', async () => {
    const panel = helpPanel();
    expect(panel.items).toHaveLength(12);
    const f = fixture({ panel });
    const screen = render(<KodoTui controller={f.controller} columns={100} rows={24} />);
    await tick();
    expect(screen.lastFrame()).not.toContain('Update task constraints');
    screen.stdin.write('/decision'); await tick();
    expect(screen.lastFrame()).toContain('Update task constraints');
    screen.stdin.write('\r'); await tick();
    expect(screen.lastFrame()).toContain('/decision');
    expect(f.submit).not.toHaveBeenCalled();
  });

  it('opens command discovery when a standalone slash is submitted', async () => {
    const f = fixture();
    const screen = render(<KodoTui controller={f.controller} columns={80} rows={24} />);
    await tick(); screen.stdin.write('/'); await tick(); screen.stdin.write('\r'); await tick();
    expect(f.submit).toHaveBeenCalledExactlyOnceWith('/help', { literal: false });
  });

  it('suggests commands as they are typed and accepts a choice without opening an extra panel', async () => {
    const f = fixture();
    const screen = render(<KodoTui controller={f.controller} columns={80} rows={24} />);
    await tick(); screen.stdin.write('/mo'); await tick();
    expect(screen.lastFrame()).toContain('/model');
    expect(f.submit).not.toHaveBeenCalled();
    screen.stdin.write('\t'); await tick();
    expect(screen.lastFrame()).toContain('/model ');
    expect(f.submit).not.toHaveBeenCalled();
    screen.stdin.write('\r'); await tick();
    expect(f.submit).toHaveBeenCalledExactlyOnceWith('/model ', { literal: false });
  });

  it('selects slash suggestions with arrows and dismisses them without losing the draft', async () => {
    const f = fixture();
    const screen = render(<KodoTui controller={f.controller} columns={80} rows={24} />);
    await tick(); screen.stdin.write('/'); await tick();
    expect(screen.lastFrame()).toContain('/new');
    screen.stdin.write('\u001b[B'); await tick(); screen.stdin.write('\r'); await tick();
    expect(f.submit).toHaveBeenCalledExactlyOnceWith('/new', { literal: false });
    screen.stdin.write('/mo'); await tick(); screen.stdin.write('\u001b'); await tick();
    expect(screen.lastFrame()).toContain('/mo');
    expect(screen.lastFrame()).not.toContain('Model for new sessions');
    expect(f.submit).toHaveBeenCalledTimes(1);
  });

  it('suggests files while typing and inserts a quoted reference without submitting the task', async () => {
    const f = fixture();
    const completeFiles = vi.fn(async () => [{ id: 'src/my file.ts', label: 'src/my file.ts', input: '@"src/my file.ts"' }]);
    f.controller.completeFiles = completeFiles;
    const screen = render(<KodoTui controller={f.controller} columns={80} rows={24} />);
    await tick(); screen.stdin.write('Review @src/my'); await new Promise(resolve => setTimeout(resolve, 100));
    expect(completeFiles).toHaveBeenCalledWith('src/my');
    expect(screen.lastFrame()).toContain('src/my file.ts');
    expect(f.submit).not.toHaveBeenCalled();
    screen.stdin.write('\r'); await tick();
    expect(screen.lastFrame()).toContain('Review @"src/my file.ts"');
    expect(f.submit).not.toHaveBeenCalled();
    screen.stdin.write('\r'); await tick();
    expect(f.submit).toHaveBeenCalledExactlyOnceWith('Review @"src/my file.ts" ', { literal: false });
  });

  it('ignores stale file completions and never reopens a dismissed suggestion list', async () => {
    const f = fixture();
    let oldResult!: (items: { id: string; label: string; input: string }[]) => void;
    const old = new Promise<{ id: string; label: string; input: string }[]>(resolve => { oldResult = resolve; });
    f.controller.completeFiles = vi.fn(async query => query === 'a' ? old : [{ id: 'ab.ts', label: 'ab.ts', input: '@ab.ts' }]);
    const screen = render(<KodoTui controller={f.controller} columns={80} rows={24} />);
    await tick(); screen.stdin.write('@a'); await new Promise(resolve => setTimeout(resolve, 90));
    screen.stdin.write('b'); await new Promise(resolve => setTimeout(resolve, 90));
    expect(screen.lastFrame()).toContain('ab.ts');
    oldResult([{ id: 'old.ts', label: 'old.ts', input: '@old.ts' }]); await tick();
    expect(screen.lastFrame()).not.toContain('old.ts');
    screen.stdin.write('\u001b'); await tick();
    expect(screen.lastFrame()).not.toContain('ab.ts');
    expect(screen.lastFrame()).toContain('@ab');
    expect(f.submit).not.toHaveBeenCalled();
  });

  it('keeps surrounding text and closes the file picker after an inline completion', async () => {
    const f = fixture();
    f.controller.completeFiles = vi.fn(async () => [{ id: 'src/main.ts', label: 'src/main.ts', input: '@src/main.ts' }]);
    const screen = render(<KodoTui controller={f.controller} columns={80} rows={24} />);
    await tick(); screen.stdin.write('Read @src/ma please'); await tick();
    for (let index = 0; index < 7; index++) screen.stdin.write('\u001b[D');
    await new Promise(done => setTimeout(done, 100));
    screen.stdin.write('\r'); await tick();
    expect(f.submit).not.toHaveBeenCalled();
    screen.stdin.write('\r'); await tick();
    expect(f.submit).toHaveBeenCalledExactlyOnceWith('Read @src/main.ts please', { literal: false });
  });

  it('keeps failed file searches inline and preserves input', async () => {
    const f = fixture();
    f.controller.completeFiles = vi.fn(async () => { throw new Error('File suggestions require read permission.'); });
    const screen = render(<KodoTui controller={f.controller} columns={80} rows={24} />);
    await tick(); screen.stdin.write('Review @src'); await new Promise(resolve => setTimeout(resolve, 100));
    expect(screen.lastFrame()).toContain('File suggestions require read permission.');
    expect(screen.lastFrame()).toContain('Review @src');
    expect(f.submit).not.toHaveBeenCalled();
  });

  it('does not submit a task when Enter is pressed before file suggestions finish', async () => {
    const f = fixture();
    let resolve!: (items: { id: string; label: string; input: string }[]) => void;
    f.controller.completeFiles = vi.fn(() => new Promise<{ id: string; label: string; input: string }[]>(done => { resolve = done; }));
    const screen = render(<KodoTui controller={f.controller} columns={80} rows={24} />);
    await tick(); screen.stdin.write('Review @src'); await new Promise(done => setTimeout(done, 90));
    screen.stdin.write('\r'); await tick();
    expect(f.submit).not.toHaveBeenCalled();
    expect(screen.lastFrame()).toContain('Searching files...');
    resolve([{ id: 'src/a.ts', label: 'src/a.ts', input: '@src/a.ts' }]); await tick();
    screen.stdin.write('\r'); await tick();
    expect(f.submit).not.toHaveBeenCalled();
    expect(screen.lastFrame()).toContain('Review @src/a.ts');
  });

  it('never opens suggestions for literal pasted commands or references', async () => {
    const f = fixture();
    const completeFiles = vi.fn(async () => []);
    f.controller.completeFiles = completeFiles;
    const screen = render(<KodoTui controller={f.controller} columns={80} rows={24} />);
    await tick(); screen.stdin.write('\u001b[200~/model @src\u001b[201~'); await new Promise(resolve => setTimeout(resolve, 100));
    expect(completeFiles).not.toHaveBeenCalled();
    expect(screen.lastFrame()).not.toContain('Model for new sessions');
    screen.stdin.write('\r'); await tick();
    expect(f.submit).toHaveBeenCalledExactlyOnceWith('/model @src', { literal: true });
  });

  it('allows a second Ctrl+C to exit while the first interruption is still pending', async () => {
    const f = fixture({ busy: true, status: 'running' });
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(f.controller.interrupt).mockImplementation(async () => pending);
    const screen = render(<KodoTui controller={f.controller} columns={80} rows={24} />);
    try {
      await tick(); screen.stdin.write('unsent draft'); await tick(); screen.stdin.write('\u0003'); await tick();
      expect(screen.lastFrame()).toContain('Press Ctrl+C again to exit.');
      expect(screen.lastFrame()).toContain('unsent draft');
      expect(f.controller.quit).not.toHaveBeenCalled();
      screen.stdin.write('\u0003'); await tick();
      expect(f.controller.quit).toHaveBeenCalledExactlyOnceWith(true);
    } finally { release(); await tick(); }
  });

  it.each(['/stop all', '/cancel', '/quit', '/permissions', '/permissions yolo'])('delivers %s while an author submission remains pending and preserves its ordinary-input lock', async command => {
    const f = fixture();
    let releaseAuthor!: () => void;
    let releaseControl!: () => void;
    const author = new Promise<void>(resolve => { releaseAuthor = resolve; });
    const control = new Promise<void>(resolve => { releaseControl = resolve; });
    f.submit.mockImplementation(async text => text === '/agents new long' ? author : text === command ? control : undefined);
    const screen = render(<KodoTui controller={f.controller} columns={100} rows={24} />);
    try {
      await tick(); screen.stdin.write('/agents new long'); await tick(); screen.stdin.write('\r'); await tick();
      screen.stdin.write('仍在等待作者操作'); await tick(); screen.stdin.write('\r'); await tick();
      expect(f.submit).toHaveBeenCalledTimes(1);
      expect(screen.lastFrame()).toContain('仍在等待作者操作');
      screen.stdin.write('\u0015'); await tick(); screen.stdin.write(command); await tick(); screen.stdin.write('\r'); await tick();
      expect(f.submit).toHaveBeenCalledTimes(2);
      expect(f.submit).toHaveBeenLastCalledWith(command, { literal: false });
      releaseControl(); await tick();
      screen.stdin.write('控制结束仍不能启动第二个任务'); await tick(); screen.stdin.write('\r'); await tick();
      expect(f.submit).toHaveBeenCalledTimes(2);
      expect(screen.lastFrame()).toContain('控制结束仍不能启动第二个任务');
      releaseAuthor(); await tick();
      screen.stdin.write('\r'); await tick();
      expect(f.submit).toHaveBeenLastCalledWith('控制结束仍不能启动第二个任务', { literal: false });
    } finally { releaseAuthor(); releaseControl(); await tick(); }
  });

  it('keeps pasted control text and commands with extra arguments behind the ordinary-input lock', async () => {
    const f = fixture();
    let releaseAuthor!: () => void;
    const author = new Promise<void>(resolve => { releaseAuthor = resolve; });
    f.submit.mockImplementation(async () => author);
    const screen = render(<KodoTui controller={f.controller} columns={100} rows={24} />);
    try {
      await tick(); screen.stdin.write('/agents new long'); await tick(); screen.stdin.write('\r'); await tick();
      screen.stdin.write('\u001b[200~/quit\u001b[201~'); await tick(); screen.stdin.write('\r'); await tick();
      expect(f.submit).toHaveBeenCalledTimes(1);
      expect(screen.lastFrame()).toContain('/quit');
      for (const command of ['/quit confirm extra', '/stop all extra', '/cancel extra', '/stopper']) {
        screen.stdin.write('\u0015'); await tick(); screen.stdin.write(command); await tick(); screen.stdin.write('\r'); await tick();
        expect(f.submit).toHaveBeenCalledTimes(1);
        expect(screen.lastFrame()).toContain(command);
      }
    } finally { releaseAuthor(); await tick(); }
  });

  it('sends one quit confirmation while the author and confirmation operations are pending', async () => {
    const f = fixture();
    let releaseAuthor!: () => void;
    let releaseConfirmation!: () => void;
    const author = new Promise<void>(resolve => { releaseAuthor = resolve; });
    const confirmation = new Promise<void>(resolve => { releaseConfirmation = resolve; });
    f.submit.mockImplementation(async text => text === '/agents new long' ? author : confirmation);
    const screen = render(<KodoTui controller={f.controller} columns={100} rows={24} />);
    try {
      await tick(); screen.stdin.write('/agents new long'); await tick(); screen.stdin.write('\r'); await tick();
      f.update({ panel: { title: '退出确认', lines: ['长作者操作仍未返回'], items: [{ id: 'confirm', label: '中断并退出', command: '/quit confirm' }] } }); await tick();
      for (let press = 0; press < 3; press++) { screen.stdin.write('\r'); await tick(); }
      expect(f.submit.mock.calls.filter(call => call[0] === '/quit confirm')).toHaveLength(1);
      releaseConfirmation(); await tick();
      f.update({ panel: undefined }); await tick();
      screen.stdin.write('作者仍在运行'); await tick(); screen.stdin.write('\r'); await tick();
      expect(f.submit).toHaveBeenCalledTimes(2);
      expect(screen.lastFrame()).toContain('作者仍在运行');
    } finally { releaseAuthor(); releaseConfirmation(); await tick(); }
  });

  it('keeps bracketed slash and multiline paste literal until a separate Enter', async () => {
    const f = fixture();
    const screen = render(<KodoTui controller={f.controller} columns={100} rows={24} />);
    await tick();
    screen.stdin.write('\u001b[200~/quit\n中文下一行\u001b[201~');
    await tick();
    expect(f.submit).not.toHaveBeenCalled();
    expect(screen.lastFrame()).toContain('/quit');
    screen.stdin.write('\r');
    await tick();
    expect(f.submit).toHaveBeenCalledExactlyOnceWith('/quit\n中文下一行', { literal: true });
  });

  it('accepts a newly typed command after deleting an entire multiline paste', async () => {
    const f = fixture();
    const screen = render(<KodoTui controller={f.controller} columns={100} rows={24} />);
    await tick(); screen.stdin.write('/help\r'); await tick();
    expect(f.submit).not.toHaveBeenCalled();
    screen.stdin.write('\u007f'); await tick(); screen.stdin.write('\u0015'); await tick();
    screen.stdin.write('/help'); await tick(); screen.stdin.write('\r'); await tick();
    expect(f.submit).toHaveBeenCalledExactlyOnceWith('/help', { literal: false });
    expect(screen.lastFrame()).toContain('Commands');
  });

  it('preserves the main draft while browsing a child and sends one action per Enter', async () => {
    const f = fixture();
    const screen = render(<KodoTui controller={f.controller} columns={130} rows={24} />);
    await tick();
    screen.stdin.write('给主代理的草稿'); await tick();
    screen.stdin.write('\u0010'); await tick();
    screen.stdin.write('Tasks'); await tick();
    screen.stdin.write('\r'); await tick();
    expect(f.submit.mock.calls.filter(call => call[0] === '/tasks')).toHaveLength(1);
    expect(screen.lastFrame()).toContain('› ');
    expect(screen.lastFrame()).toContain('给主代理的草稿');
    screen.stdin.write('\u001b'); await tick();
    screen.stdin.write('\r'); await tick();
    expect(f.submit).toHaveBeenLastCalledWith('给主代理的草稿', { literal: false });
  });

  it('interrupts on Ctrl+C while keeping unsent input and releases subscriptions on unmount', async () => {
    const f = fixture({ busy: true, status: 'running' });
    const screen = render(<KodoTui controller={f.controller} columns={80} rows={24} />);
    await tick(); screen.stdin.write('未发送'); await tick();
    screen.stdin.write('\u0003'); await tick();
    expect(f.controller.interrupt).toHaveBeenCalledTimes(1);
    expect(screen.lastFrame()).toContain('未发送');
    screen.unmount(); await tick();
    expect(f.listeners.size).toBe(0);
    screen.stdin.write('\u0003'); await tick();
    expect(f.controller.interrupt).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('shows new content while history is frozen, including a capped transcript: %s', async capped => {
    const entries: TuiEntry[] = Array.from({ length: 25 }, (_, index) => ({ id: `${index}`, kind: 'assistant', text: `消息 ${index}` }));
    const f = fixture({ entries });
    const screen = render(<KodoTui controller={f.controller} columns={80} rows={24} />);
    await tick(); screen.stdin.write('\u001b[5~'); await tick();
    f.update({ entries: [...(capped ? entries.slice(1) : entries), { id: 'new', kind: 'error', text: '新的执行错误' }] }); await tick();
    expect(screen.lastFrame()).toContain('1 new');
    expect(screen.lastFrame()).not.toContain('新的执行错误');
    screen.stdin.write('\u001b[6~'); await tick();
    expect(screen.lastFrame()).toContain('新的执行错误');
  });

  it('keeps accepting draft input while browsing ten thousand records and receiving new output', async () => {
    const entries: TuiEntry[] = Array.from({ length: 10_000 }, (_, index) => ({ id: String(index), kind: 'assistant', text: `历史消息 ${index}` }));
    const f = fixture({ entries });
    const screen = render(<KodoTui controller={f.controller} columns={80} rows={24} />);
    await tick(); screen.stdin.write('\u001b[5~'); await tick();
    screen.stdin.write('历史浏览中的中文草稿'); await tick();
    f.update({ entries: [...entries, { id: 'new', kind: 'error', text: '最新错误证据' }] }); await tick();
    expect(screen.lastFrame()).toContain('历史浏览中的中文草稿');
    expect(screen.lastFrame()).toContain('1 new');
    expect(screen.lastFrame()).not.toContain('最新错误证据');
    screen.stdin.write('\u001b[6~'); await tick();
    expect(screen.lastFrame()).toContain('最新错误证据');
    expect(screen.lastFrame()).toContain('历史浏览中的中文草稿');
    expect(f.submit).not.toHaveBeenCalled();
  });

  it('completes a file reference without replacing the preceding message or reading the file', async () => {
    const f = fixture();
    const screen = render(<KodoTui controller={f.controller} columns={100} rows={24} />);
    await tick(); screen.stdin.write('请查看 @src/ma'); await tick();
    screen.stdin.write('\t'); await tick(); screen.stdin.write('\r'); await tick();
    expect(screen.lastFrame()).toContain('请查看 @src/main.ts');
    expect(f.submit).toHaveBeenCalledExactlyOnceWith('/files src/ma', undefined);
  });

  it('keeps the text after the cursor while completing a file reference', async () => {
    const f = fixture();
    const screen = render(<KodoTui controller={f.controller} columns={100} rows={24} />);
    await tick(); screen.stdin.write('请查看 @src/ma 完成'); await tick();
    for (let index = 0; index < 3; index++) { screen.stdin.write('\u001b[D'); await tick(); }
    screen.stdin.write('\t'); await tick(); screen.stdin.write('\r'); await tick();
    screen.stdin.write('\r'); await tick();
    expect(f.submit).toHaveBeenLastCalledWith('请查看 @src/main.ts 完成', { literal: false });
  });

  it('restores an unsent draft when submission fails', async () => {
    const f = fixture();
    f.submit.mockRejectedValueOnce(new Error('运行无法创建'));
    const screen = render(<KodoTui controller={f.controller} columns={100} rows={24} />);
    await tick(); screen.stdin.write('需要保留的任务'); await tick(); screen.stdin.write('\r'); await tick();
    expect(screen.lastFrame()).toContain('需要保留的任务');
    expect(screen.lastFrame()).toContain('运行无法创建');
  });

  it('pages long panel evidence while keeping its actions selectable', async () => {
    const f = fixture({ panel: { title: '任务证据', lines: Array.from({ length: 60 }, (_, index) => `证据 ${String(index).padStart(2, '0')}`), items: [{ id: 'action', label: '查看调用', input: '/tasks logs fixture' }] } });
    const screen = render(<KodoTui controller={f.controller} columns={100} rows={24} />);
    await tick();
    expect(screen.lastFrame()).toContain('证据 00');
    const seen = new Set<string>();
    for (let page = 0; page < 8; page++) {
      for (const match of (screen.lastFrame() ?? '').matchAll(/证据 (\d{2})/gu)) seen.add(match[1]!);
      screen.stdin.write('\u001b[6~'); await tick();
    }
    expect([...seen].sort()).toEqual(Array.from({ length: 60 }, (_, index) => String(index).padStart(2, '0')));
    expect(screen.lastFrame()).toContain('查看调用');
    for (let page = 0; page < 8; page++) { screen.stdin.write('\u001b[5~'); await tick(); }
    expect(screen.lastFrame()).toContain('证据 00');
    screen.stdin.write('\r'); await tick();
    expect(screen.lastFrame()).toContain('/tasks logs fixture');
    expect(f.submit).not.toHaveBeenCalled();
  });

  it('keeps the draft after an external editor failure', async () => {
    const f = fixture();
    const editor = vi.fn(async () => { throw new Error('EDITOR_EXIT: 编辑器退出码 9'); });
    const screen = render(<KodoTui controller={f.controller} columns={100} rows={24} externalEditor={editor} />);
    await tick(); screen.stdin.write('原来的草稿'); await tick(); screen.stdin.write('\u0007'); await tick();
    expect(editor).toHaveBeenCalledWith('原来的草稿');
    expect(screen.lastFrame()).toContain('原来的草稿');
    expect(screen.lastFrame()).toContain('编辑器退出码 9');
  });

  it('normalizes external editor content and sends slash-prefixed content literally', async () => {
    const f = fixture();
    const screen = render(<KodoTui controller={f.controller} columns={100} rows={24} externalEditor={async () => '/quit\r\n中文'} />);
    await tick(); screen.stdin.write('\u0007'); await tick();
    expect(f.submit).not.toHaveBeenCalled();
    screen.stdin.write('\r'); await tick();
    expect(f.submit).toHaveBeenCalledExactlyOnceWith('/quit\n中文', { literal: true });
  });

  it('allows ordinary commands after an external editor clears the draft', async () => {
    const f = fixture();
    const screen = render(<KodoTui controller={f.controller} columns={100} rows={24} externalEditor={async () => ''} />);
    await tick(); screen.stdin.write('原草稿'); await tick(); screen.stdin.write('\u0007'); await tick();
    screen.stdin.write('/help'); await tick(); screen.stdin.write('\r'); await tick();
    expect(f.submit).toHaveBeenCalledExactlyOnceWith('/help', { literal: false });
  });

  it('starts a replacement evidence page at its beginning even when its title stays the same', async () => {
    const f = fixture({ panel: { title: '原始证据 · 分页', lines: Array.from({ length: 60 }, (_, index) => `旧页 ${index}`) } });
    const screen = render(<KodoTui controller={f.controller} columns={100} rows={24} />);
    await tick(); screen.stdin.write('\u001b[6~'); await tick();
    expect(screen.lastFrame()).not.toContain('旧页 0');
    f.update({ panel: { title: '原始证据 · 分页', lines: Array.from({ length: 60 }, (_, index) => `新页 ${index}`) } }); await tick();
    expect(screen.lastFrame()).toContain('新页 0');
  });

  it.each([[48, 12], [59, 5], [60, 15], [79, 16], [80, 24], [119, 24], [120, 24], [130, 24]])('keeps content and input within a %i×%i terminal', async (columns, rows) => {
    const f = fixture({ entries: [{ id: 'long', kind: 'assistant', text: '中文 English '.repeat(20) }] });
    const screen = render(<KodoTui controller={f.controller} columns={columns} rows={rows} />);
    await tick();
    expect(screen.lastFrame()).toContain('› ');
    expect((screen.lastFrame() ?? '').split('\n').every(line => stringWidth(line) <= columns)).toBe(true);
    expect((screen.lastFrame() ?? '').trimEnd().split('\n').length).toBeLessThanOrEqual(rows);
  });

  it.each([119, 120])('keeps draft and conversation correctly arranged around the sidebar at %i columns', async columns => {
    const f = fixture({ entries: [{ id: 'main', kind: 'assistant', text: '主对话保持可读' }], panel: { title: 'Tasks', lines: ['子任务的真实状态'] } });
    const screen = render(<KodoTui controller={f.controller} columns={columns} rows={24} />);
    await tick();
    expect(screen.lastFrame()).toContain('子任务的真实状态');
    expect(screen.lastFrame()?.includes('主对话保持可读')).toBe(columns >= 120);
    expect((screen.lastFrame() ?? '').split('\n').every(line => stringWidth(line) <= columns)).toBe(true);
  });
});

describe('bounded transcript projection', () => {
  it('updates cached transcript blocks when text changes or the terminal is resized', () => {
    const entry: TuiEntry = { id: 'stream', kind: 'assistant', text: '原内容' };
    visibleTranscript([entry], 80, 18);
    entry.text = '更新后的中文长行'.repeat(4);
    const next = visibleTranscript([entry], 20, 18);
    expect(next.lines.map(line => line.text).join('')).toContain('更新后的中文长行');
    expect(next.lines.every(line => stringWidth(line.text) <= 20)).toBe(true);
  });
  it('keeps verification evidence separate from successful reads mentioned in its text', () => {
    const page = visibleTranscript([
      { id: 'read', kind: 'tool', title: 'file.read', status: 'succeeded', text: '读取完成' },
      { id: 'check', kind: 'tool', title: 'verify.run', status: 'succeeded', text: '检索回归测试通过' },
    ], 80, 18);
    expect(page.lines.map(line => line.text).join('\n')).toContain('verify.run');
    expect(page.lines.map(line => line.text).join('\n')).toContain('检索回归测试通过');
  });
  it('clamps scrolling at the oldest line instead of showing a blank viewport', () => {
    const page = visibleTranscript([{ id: 'first', kind: 'user', text: '第一条消息' }], 80, 18, 10_000);
    expect(page.lines.map(line => line.text).join('\n')).toContain('第一条消息');
    expect(page.hasOlder).toBe(false);
    expect(page.offset).toBe(0);
  });
  it('renders only a viewport from ten thousand records and keeps failures visible', () => {
    const entries: TuiEntry[] = Array.from({ length: 10_000 }, (_, index) => ({ id: String(index), kind: 'tool', title: 'file.read', status: 'succeeded', text: 'read evidence' }));
    entries.push({ id: 'failure', kind: 'error', text: '验证失败；不能宣称完成' });
    const page = visibleTranscript(entries, 80, 18);
    expect(page.lines.length).toBeLessThanOrEqual(18);
    expect(page.lines.map(line => line.text).join('\n')).toContain('验证失败');
    expect(page.lines.map(line => line.text).join('\n')).toContain('10000 reads / searches');
  });
});
