import path from 'node:path';

/** Sessions store canonical workspace paths. Sibling names are not containment. */
export function workspacesOverlap(left: string, right: string): boolean {
  return [path.relative(left, right), path.relative(right, left)].some(relative =>
    relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)));
}
