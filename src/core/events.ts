/**
 * Named plugin-to-plugin events. The core never emits on its own; plugins define
 * the names and payload types (for example task-analysis's `task.graph_built`).
 * Listeners run in subscription order and are awaited; a throw reaches the emitter.
 */
export class PluginEvents {
  private readonly listeners = new Map<string, Set<(payload: unknown) => unknown>>();
  on<T>(name: string, listener: (payload: T) => unknown): () => void {
    const set = this.listeners.get(name) ?? new Set();
    const entry = listener as (payload: unknown) => unknown;
    set.add(entry);
    this.listeners.set(name, set);
    return () => { set.delete(entry); };
  }
  async emit(name: string, payload: unknown): Promise<void> {
    for (const listener of [...this.listeners.get(name) ?? []]) await listener(payload);
  }
}
