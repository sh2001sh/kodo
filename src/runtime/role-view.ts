import type { Run, Session } from './types.js';

/**
 * The default card's tool view: a complete coding loop without redundant CRUD when
 * commands run. Explicit custom cards keep their declared tools. This view grants
 * nothing; card declarations, permissions and tool policy still apply.
 */
export function roleAllows(run: Pick<Run, 'parentId'> & Partial<Pick<Run, 'card' | 'permissions'>>, session: Partial<Pick<Session, 'permissions'>>, name: string): boolean {
  if (!/^builtin\/general-simple(?:-(?:memory|verify|web|lsp))*$/u.test(run.card?.id ?? '')) return true;
  if (name.startsWith('knowledge.') || ['update_progress', 'artifact.write'].includes(name)) return false;
  // Without exec, native directory/file management remains the complete write path.
  const canExecute = session.permissions?.includes('exec') && (run.permissions ?? session.permissions).includes('exec') && run.card?.tools.includes('shell.exec');
  return !(canExecute && ['file.list', 'file.mkdir', 'file.rename', 'file.delete'].includes(name));
}
