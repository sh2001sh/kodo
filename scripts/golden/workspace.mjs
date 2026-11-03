// Workspace seeding helpers shared by the golden runner (pure path + fs, no dist import,
// so unit tests do not need a built dist/).

import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * The model must be able to write into `case.deliverableDir` (e.g. deliverables/), but
 * git does not track empty directories, so the copied workspace may lack it. Create it
 * after seeding; an existing directory (or the workspace root itself) is left alone.
 */
export function ensureDeliverableDir(workspace, deliverableDir) {
  const relative = typeof deliverableDir === 'string' && deliverableDir.trim() ? deliverableDir.replace(/\\/gu, '/') : '.';
  if (relative === '.' || relative === '') return null;
  if (relative.startsWith('/') || /^[A-Za-z]:\//u.test(relative) || relative.split('/').some(segment => segment === '..')) {
    throw new Error(`deliverableDir must stay inside the workspace, got ${deliverableDir}`);
  }
  const target = path.join(workspace, relative);
  try {
    if (statSync(target).isDirectory()) return target;
  } catch { /* missing: create below */ }
  mkdirSync(target, { recursive: true });
  return target;
}
