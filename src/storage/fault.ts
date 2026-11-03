import type Database from 'better-sqlite3';

/** Operational storage failures poison a connection; caller/data constraint errors do not. */
export function storageFault(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return /^(SQLITE_(IOERR|FULL|CORRUPT|NOTADB|CANTOPEN|READONLY|PROTOCOL)(_|$)|ENOSPC$|EIO$|EROFS$|LOCK_OWNER$)/.test(code);
}

/** Gate every SQL write, including the named record services, while leaving reads/close available after failure. */
export function guardedConnection(connection: Database.Database, beforeWrite: () => void, failed: (error: unknown) => void): Database.Database {
  const invoke = <T>(action: () => T): T => { try { return action(); } catch (error) { if (storageFault(error)) failed(error); throw error; } };
  const wrapStatement = (statement: Database.Statement): Database.Statement => new Proxy(statement, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (['run', 'all', 'get', 'iterate'].includes(String(property)) && typeof value === 'function') return (...args: unknown[]) => invoke(() => {
        if (!target.readonly) beforeWrite();
        return Reflect.apply(value, target, args);
      });
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const wrapTransaction = (transaction: Database.Transaction): Database.Transaction => new Proxy(transaction, {
    apply(target, thisArg, argumentsList) { return invoke(() => { beforeWrite(); return Reflect.apply(target, thisArg, argumentsList); }); },
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      return ['deferred', 'immediate', 'exclusive'].includes(String(property)) && typeof value === 'function' ? wrapTransaction(value as Database.Transaction) : value;
    },
  });
  return new Proxy(connection, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => invoke(() => wrapStatement(target.prepare(sql)));
      if (property === 'exec') return (sql: string) => invoke(() => { beforeWrite(); return target.exec(sql); });
      if (property === 'transaction') return (action: (...args: unknown[]) => unknown) => wrapTransaction(target.transaction(action));
      if (property === 'pragma') return (sql: string, options?: Database.PragmaOptions) => invoke(() => { if (sql.includes('=') || /^(wal_checkpoint|optimize)/i.test(sql)) beforeWrite(); return target.pragma(sql, options); });
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
