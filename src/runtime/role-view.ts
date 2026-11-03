import type { Run, Session } from './types.js';
import { isLeanProfile, leanAllows, leanChildRole } from './tool-view.js';

/** Freeze profile-specific visibility; legacy E delegates execution, compact-v2 keeps a complete coding loop. */
export function roleAllows(run: Pick<Run, 'parentId'> & Partial<Pick<Run, 'card' | 'execution' | 'permissions' | 'taskNode'>>, session: Pick<Session, 'agentFactors' | 'toolProfile'> & Partial<Pick<Session, 'permissions' | 'inlineMethods'>>, name: string): boolean {
  if (session.inlineMethods && !run.parentId && (name.startsWith('knowledge.') || name === 'artifact.write')) return true;
  if (session.toolProfile !== 'lean-team') {
    if (name === 'workspace.integrate') return !run.parentId;
    if (name === 'workspace.commit') return Boolean(run.parentId && run.execution);
  }
  if (isLeanProfile(session.toolProfile) && (!run.parentId || session.toolProfile === 'lean-team')) {
    // The lean main view is frozen by permissions and card: commands, or native file management without them.
    const exec = Boolean(session.permissions?.includes('exec') && (run.permissions ?? session.permissions).includes('exec') && run.card?.tools.includes('shell.exec'));
    return leanAllows(name, exec, leanChildRole(run), session.toolProfile);
  }
  if (session.toolProfile === 'compact-v2') {
    const simpleMain = /^builtin\/general-simple(?:-(?:memory|verify|web|lsp))*(?:-roster-[a-f0-9]{12})?$/u.test(run.card?.id ?? '');
    const simpleMember = run.card?.version === '1.3.0' && ['kodo/explorer', 'kodo/tester', 'kodo/reviewer', 'kodo/implementer', 'kodo/frontend', 'kodo/backend'].includes(run.card.id);
    if (simpleMain || simpleMember) {
      if (name.startsWith('agent.') || name.startsWith('knowledge.') || ['explore', 'exploration.plan', 'update_progress', 'list_agents', 'history.search', 'artifact.write'].includes(name)) return false;
      // Without exec, native directory/file management remains the complete write path.
      const canExecute = session.permissions?.includes('exec') && (run.permissions ?? session.permissions).includes('exec') && run.card?.tools.includes('shell.exec');
      if (canExecute && ['file.list', 'file.mkdir', 'file.rename', 'file.delete'].includes(name)) return false;
    }
    // A complete coding loop and explicitly configured specialists keep execution.
    // This view grants nothing: card declarations, permissions and tool policy still apply.
    return true;
  }
  // Limit the default general workflow only. Explicit specialist/custom cards keep
  // their declared tools; this view never substitutes for permission checks.
  if (session.toolProfile === 'compact-v1' && /^builtin\/general-compact(?:-(?:memory|verify|web|lsp))*(?:-roster-[a-f0-9]{12})?$/u.test(run.card?.id ?? '')) {
    if (name.startsWith('agent.') || name.startsWith('knowledge.') || ['explore', 'exploration.plan', 'update_progress', 'list_agents'].includes(name)) return false;
  }
  if (session.toolProfile === 'compact-v1' && run.parentId && run.card?.version === '1.2.0' && ['kodo/explorer', 'kodo/tester', 'kodo/reviewer', 'kodo/implementer', 'kodo/frontend', 'kodo/backend'].includes(run.card.id) && ['list_agents', 'update_progress'].includes(name)) return false;
  if (!session.agentFactors?.E || run.parentId) return true;
  return !['shell.exec', 'process.exec', 'process.read', 'image.read', 'web.fetch'].includes(name) && !name.startsWith('lsp.');
}
