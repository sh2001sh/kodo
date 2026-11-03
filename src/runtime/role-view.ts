import type { Run, Session } from './types.js';
import { isLeanProfile, leanAllows } from './tool-view.js';

/** Freeze profile-specific visibility; legacy E delegates execution, compact-v2 keeps a complete coding loop. */
export function roleAllows(run: Pick<Run, 'parentId'> & Partial<Pick<Run, 'card' | 'permissions'>>, session: Pick<Session, 'agentFactors' | 'toolProfile'> & Partial<Pick<Session, 'permissions'>>, name: string): boolean {
  if (isLeanProfile(session.toolProfile) && !run.parentId) {
    // The lean main view is frozen by permissions and card: commands, or native file management without them.
    const exec = Boolean(session.permissions?.includes('exec') && (run.permissions ?? session.permissions).includes('exec') && run.card?.tools.includes('shell.exec'));
    return leanAllows(name, exec);
  }
  if (session.toolProfile === 'compact-v2') {
    const simpleMain = /^builtin\/general-simple(?:-(?:memory|verify|web|lsp))*$/u.test(run.card?.id ?? '');
    if (simpleMain) {
      if (name.startsWith('knowledge.') || ['update_progress', 'history.search', 'artifact.write'].includes(name)) return false;
      // Without exec, native directory/file management remains the complete write path.
      const canExecute = session.permissions?.includes('exec') && (run.permissions ?? session.permissions).includes('exec') && run.card?.tools.includes('shell.exec');
      if (canExecute && ['file.list', 'file.mkdir', 'file.rename', 'file.delete'].includes(name)) return false;
    }
    // A complete coding loop and explicitly configured cards keep execution.
    // This view grants nothing: card declarations, permissions and tool policy still apply.
    return true;
  }
  // Limit the default general workflow only. Explicit custom cards keep their
  // declared tools; this view never substitutes for permission checks.
  if (session.toolProfile === 'compact-v1' && /^builtin\/general-compact(?:-(?:memory|verify|web|lsp))*$/u.test(run.card?.id ?? '')) {
    if (name.startsWith('knowledge.') || name === 'update_progress') return false;
  }
  if (!session.agentFactors?.E || run.parentId) return true;
  return !['shell.exec', 'process.exec', 'process.read', 'image.read', 'web.fetch'].includes(name) && !name.startsWith('lsp.');
}
