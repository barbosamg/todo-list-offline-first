import { Injectable, computed, signal } from '@angular/core';
import { LocalDb } from './local-db';
import { overlay } from './merge';
import { Changes, EDITABLE_FIELDS, EditableValues, Field, FieldValue, OutboxOp, SyncResponse, Todo } from './models';
import { isUrgent } from './urgent-rule';

export function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16)); // contexto não seguro (http em IP de LAN)
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Normaliza como o servidor (trim; vazio → null) para que os valores canônicos coincidam. */
export function normalize(field: Field, value: FieldValue): FieldValue {
  if (value === null || value === undefined) return null;
  if (field === 'priority' || field === 'status') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Fonte da verdade LOCAL. Mantém:
 *  • base  — último estado confirmado pelo servidor;
 *  • ops   — fila offline de operações pendentes.
 * A UI lê sempre `todos` = base + ops aplicadas por cima (otimista): toda escrita aparece na hora,
 * com ou sem rede, e a regra de urgentes é avaliada localmente.
 */
@Injectable({ providedIn: 'root' })
export class TodoRepository {
  private db: LocalDb | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private lastAt = 0;
  private inFlight = new Set<string>();

  private readonly base = signal<ReadonlyMap<string, Todo>>(new Map());
  readonly ops = signal<readonly OutboxOp[]>([]);
  readonly lastSyncedAt = signal<number | null>(null);
  readonly ready = signal(false);
  /** incrementa a cada escrita local — o motor de sync observa para disparar o envio */
  readonly writes = signal(0);
  userId: string | null = null;
  cursor = 0;

  readonly todos = computed<Todo[]>(() => {
    const base = this.base();
    const byId = new Map<string, OutboxOp[]>();
    for (const op of this.ops()) (byId.get(op.id) ?? byId.set(op.id, []).get(op.id)!).push(op);

    const result: Todo[] = [];
    for (const [id, todo] of base) {
      const pending = byId.get(id);
      if (!pending) result.push({ ...todo, isUrgent: isUrgent(todo.title, todo.description) });
      else {
        const view = overlay(todo, pending);
        if (view) result.push(view);
      }
    }
    for (const [id, pending] of byId) {
      if (base.has(id)) continue;
      const view = overlay(undefined, pending);
      if (view) result.push(view);
    }
    return result;
  });

  readonly byId = computed(() => new Map(this.todos().map((t) => [t.id, t])));
  /** tarefas com alterações ainda não confirmadas pelo servidor */
  readonly pendingIds = computed(() => new Set(this.ops().map((o) => o.id)));
  readonly pendingCount = computed(() => this.ops().length);

  async init(userId: string): Promise<void> {
    this.db?.close();
    this.ready.set(false);
    this.db = await LocalDb.open(userId);
    this.userId = userId;
    const data = await this.db.load();
    this.base.set(new Map(data.todos.map((t) => [t.id, t])));
    this.ops.set(data.ops);
    this.cursor = data.cursor;
    this.lastSyncedAt.set(data.syncedAt);
    this.inFlight.clear();
    this.ready.set(true);
  }

  close(): void {
    this.db?.close();
    this.db = null;
    this.userId = null;
    this.ready.set(false);
    this.base.set(new Map());
    this.ops.set([]);
  }

  // ---------- escritas do usuário (otimistas, persistidas localmente) ----------

  /** Instante da edição, estritamente crescente neste dispositivo (a ordem das edições é preservada). */
  private nextAt(): number {
    this.lastAt = Math.max(Date.now(), this.lastAt + 1);
    return this.lastAt;
  }

  create(values: Partial<EditableValues> & { title: string }): Promise<string> {
    const id = newId();
    const at = this.nextAt();
    const changes = this.toChanges(values, at);
    if (!changes.title?.value) return Promise.reject(new Error('O título é obrigatório.'));
    return this.serial(async () => {
      await this.append({ opId: newId(), id, changes, deletedAt: null, createdAt: at });
      return id;
    });
  }

  update(id: string, patch: Partial<EditableValues>): Promise<void> {
    return this.serial(async () => {
      const current = this.byId().get(id);
      if (!current) return;
      const at = this.nextAt();
      const changes: Changes = {};
      for (const [field, change] of Object.entries(this.toChanges(patch, at)) as [Field, { value: FieldValue; at: number }][]) {
        const now = (current as unknown as Record<Field, FieldValue>)[field] ?? null;
        if (now !== change.value) changes[field] = change;
      }
      if (Object.keys(changes).length === 0) return;
      await this.enqueueEdit(id, changes);
    });
  }

  toggle(id: string): Promise<void> {
    const current = this.byId().get(id);
    return this.update(id, { status: current?.status === 'completed' ? 'pending' : 'completed' });
  }

  remove(id: string): Promise<void> {
    return this.serial(async () => {
      const mine = this.ops().filter((o) => o.id === id);
      const serverKnows = this.base().has(id) || mine.some((o) => this.inFlight.has(o.opId));
      const unsent = mine.filter((o) => !this.inFlight.has(o.opId));
      if (unsent.length) await this.dropOps(unsent);
      // Criada e removida offline antes de qualquer envio: o servidor nunca soube dela — nada a enviar.
      if (!serverKnows) return;
      await this.append({ opId: newId(), id, changes: {}, deletedAt: this.nextAt(), createdAt: null });
    });
  }

  private toChanges(values: Partial<EditableValues>, at: number): Changes {
    const changes: Changes = {};
    for (const field of EDITABLE_FIELDS) {
      if (!(field in values)) continue;
      const raw = (values as Record<Field, FieldValue | undefined>)[field];
      changes[field] = { value: normalize(field, raw ?? null), at };
    }
    return changes;
  }

  /** Mescla na última operação ainda não enviada da tarefa; senão cria uma nova (menos tráfego ao reconectar). */
  private async enqueueEdit(id: string, changes: Changes): Promise<void> {
    const list = this.ops();
    for (let i = list.length - 1; i >= 0; i--) {
      const op = list[i];
      if (op.id !== id) continue;
      if (this.inFlight.has(op.opId) || op.deletedAt !== null) break;
      const merged: OutboxOp = { ...op, changes: { ...op.changes, ...changes } };
      await this.db!.putOp(merged);
      this.ops.set(list.map((o, j) => (j === i ? merged : o)));
      this.writes.update((n) => n + 1);
      return;
    }
    await this.append({ opId: newId(), id, changes, deletedAt: null, createdAt: null });
  }

  private async append(op: OutboxOp): Promise<void> {
    const seq = await this.db!.addOp(op);
    this.ops.update((list) => [...list, { ...op, seq }]);
    this.writes.update((n) => n + 1);
  }

  private async dropOps(drop: OutboxOp[]): Promise<void> {
    await this.db!.deleteOps(drop.map((o) => o.seq!));
    const gone = new Set(drop.map((o) => o.opId));
    this.ops.update((list) => list.filter((o) => !gone.has(o.opId)));
  }

  /** Serializa as escritas (cada uma lê o estado deixado pela anterior). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  // ---------- usadas pelo motor de sincronização ----------

  /** Próximo lote a enviar; marca como "em voo" para não serem mescladas por edições novas. */
  takeBatch(max: number): OutboxOp[] {
    const batch = this.ops().slice(0, max);
    this.inFlight = new Set(batch.map((o) => o.opId));
    return batch;
  }

  releaseBatch(): void {
    this.inFlight.clear();
  }

  /**
   * Aplica a resposta do servidor: remove as operações confirmadas e atualiza a base
   * (inclusive tombstones, que apagam a tarefa localmente) numa única transação do IndexedDB.
   */
  async commit(sent: OutboxOp[], res: SyncResponse): Promise<void> {
    const answered = new Set(res.results.map((r) => r.opId));
    const confirmed = sent.filter((o) => answered.has(o.opId));

    const upserts: Todo[] = [];
    const deleteIds: string[] = [];
    const consider = (t: Todo) => (t.deletedAt !== null ? deleteIds.push(t.id) : upserts.push(t));
    for (const r of res.results) if (r.current) consider(r.current);
    for (const t of res.changes) consider(t);

    const now = Date.now();
    await this.serial(async () => {
      await this.db!.commitSync({
        removeOps: confirmed.map((o) => o.seq!),
        upserts,
        deleteIds,
        cursor: res.cursor,
        syncedAt: now,
      });
      const next = new Map(this.base());
      for (const t of upserts) next.set(t.id, t);
      for (const id of deleteIds) next.delete(id);
      this.base.set(next);
      const gone = new Set(confirmed.map((o) => o.opId));
      this.ops.update((list) => list.filter((o) => !gone.has(o.opId)));
      this.cursor = res.cursor;
      this.lastSyncedAt.set(now);
    });
    this.inFlight.clear();
  }

  /** Para os testes e para o motor: estado da tarefa sem a camada otimista. */
  baseOf(id: string): Todo | undefined {
    return this.base().get(id);
  }
}
