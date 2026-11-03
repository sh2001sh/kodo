import { describe, expect, it } from 'vitest';
import { todoMessage } from '../src/runtime/context-progress.js';

describe('plan snapshots in the context', () => {
  it('bounds plan notes in repeated context snapshots', () => {
    const message = todoMessage({ ownerRunId: 'root', revision: 1, items: [{ id: 'build', content: 'Build the result', status: 'pending', title: 'Implementation', note: 'details '.repeat(120) }] });
    const view = JSON.parse(message.content!.slice(message.content!.indexOf('{')));
    expect(view.items[0].note.length).toBeLessThan(200);
    expect(view.items[0]).not.toHaveProperty('dependsOn');
    expect(view.readFullListWith).toBe('todo.read({full:true})');
  });
});
