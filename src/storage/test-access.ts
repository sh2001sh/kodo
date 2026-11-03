import type Database from 'better-sqlite3';

// Kept outside the public Store/application entry point. Only storage code may
// bind a connection; tests import this module explicitly for migration fixtures.
const connections = new WeakMap<object, Database.Database>();
export function bindStorageTestConnection(store: object, connection: Database.Database): void { connections.set(store, connection); }
export function storageTestConnection(store: object): Database.Database {
  const connection = connections.get(store);
  if (!connection) throw new Error('storage test connection is unavailable');
  return connection;
}
