import { randomUUID } from 'node:crypto';
import { KodoError } from '../runtime/types.js';
import type { CoreSession, ModelBinding } from './types.js';

/** In-memory session table. Durable storage is a capability, not a core concern. */
export class SessionTable {
  private readonly sessions = new Map<string, CoreSession>();
  create(binding: ModelBinding, metadata: Record<string, unknown> = {}): CoreSession {
    const session: CoreSession = { id: randomUUID(), createdAt: Date.now(), binding, metadata };
    this.sessions.set(session.id, session);
    return session;
  }
  get(id: string): CoreSession {
    const session = this.sessions.get(id);
    if (!session) throw new KodoError('SESSION_NOT_FOUND', `unknown session ${id}`);
    return session;
  }
  list(): CoreSession[] { return [...this.sessions.values()]; }
}
