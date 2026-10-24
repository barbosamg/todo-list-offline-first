import { DBSchema, IDBPDatabase, openDB } from 'idb';
import { OutboxOp, Todo } from './models';

interface Schema extends DBSchema {
  /** Estado confirmado pelo servidor (a "base"). Tombstones nunca são guardados. */
  todos: { key: string; value: Todo };
  /** Fila offline de operações ainda não confirmadas, na ordem em que o usuário as fez. */
  outbox: { key: number; value: OutboxOp };
  meta: { key: string; value: unknown };
}

export interface SyncCommit {
  /** chaves (seq) das operações confirmadas pelo servidor */
  removeOps: number[];
  upserts: Todo[];
  deleteIds: string[];
  cursor: number;
  syncedAt: number;
}

/**
 * Persistência local (IndexedDB), um banco por usuário: trocar de conta nunca mistura dados nem
 * perde a fila pendente de quem saiu.
 */
export class LocalDb {
  private constructor(private readonly db: IDBPDatabase<Schema>) {}

  static async open(userId: string): Promise<LocalDb> {
    const db = await openDB<Schema>(`campo:${userId}`, 1, {
      upgrade(d) {
        d.createObjectStore('todos', { keyPath: 'id' });
        d.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
        d.createObjectStore('meta');
      },
    });
    return new LocalDb(db);
  }

  async load(): Promise<{ todos: Todo[]; ops: OutboxOp[]; cursor: number; syncedAt: number | null }> {
    const [todos, ops, cursor, syncedAt] = await Promise.all([
      this.db.getAll('todos'),
      this.db.getAll('outbox'),
      this.db.get('meta', 'cursor'),
      this.db.get('meta', 'syncedAt'),
    ]);
    return { todos, ops, cursor: (cursor as number | undefined) ?? 0, syncedAt: (syncedAt as number | undefined) ?? null };
  }

  /** Grava a operação e devolve a chave gerada (seq). */
  addOp(op: OutboxOp): Promise<number> {
    return this.db.add('outbox', op);
  }

  putOp(op: OutboxOp): Promise<number> {
    return this.db.put('outbox', op);
  }

  async deleteOps(seqs: number[]): Promise<void> {
    const tx = this.db.transaction('outbox', 'readwrite');
    await Promise.all([...seqs.map((s) => tx.store.delete(s)), tx.done]);
  }

  /** Aplica o resultado de uma sincronização de forma atômica (tudo ou nada). */
  async commitSync(c: SyncCommit): Promise<void> {
    const tx = this.db.transaction(['todos', 'outbox', 'meta'], 'readwrite');
    await Promise.all([
      ...c.removeOps.map((s) => tx.objectStore('outbox').delete(s)),
      ...c.upserts.map((t) => tx.objectStore('todos').put(t)),
      ...c.deleteIds.map((id) => tx.objectStore('todos').delete(id)),
      tx.objectStore('meta').put(c.cursor, 'cursor'),
      tx.objectStore('meta').put(c.syncedAt, 'syncedAt'),
      tx.done,
    ]);
  }

  close(): void {
    this.db.close();
  }
}
