import { PRIORITY_RANK, Priority, Status, Todo } from './models';

/**
 * Ordenação padrão (idêntica à do servidor, TodoOrdering.cs):
 *   1. urgentes primeiro (regra de negócio — independe de status, prioridade ou filtros);
 *   2. dentro de cada grupo: pendentes antes de concluídas;
 *   3. prioridade alta → baixa;
 *   4. vencimento mais próximo primeiro (sem data por último);
 *   5. mais recentes primeiro; id como desempate estável.
 */
export function compareTodos(a: Todo, b: Todo): number {
  if (a.isUrgent !== b.isUrgent) return a.isUrgent ? -1 : 1;
  if (a.status !== b.status) return a.status === 'pending' ? -1 : 1;
  if (a.priority !== b.priority) return PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
  const da = a.dueDate ?? '9999-12-31';
  const db = b.dueDate ?? '9999-12-31';
  if (da !== db) return da < db ? -1 : 1;
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export const NO_CATEGORY = '__none__';

export interface TodoFilters {
  query: string;
  status: 'all' | Status;
  priority: 'all' | Priority;
  /** null = todas; NO_CATEGORY = sem lista; senão o nome da lista */
  category: string | null;
}

export const EMPTY_FILTERS: TodoFilters = { query: '', status: 'all', priority: 'all', category: null };

export function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

export function matches(todo: Todo, f: TodoFilters): boolean {
  if (f.status !== 'all' && todo.status !== f.status) return false;
  if (f.priority !== 'all' && todo.priority !== f.priority) return false;
  if (f.category === NO_CATEGORY ? todo.category !== null : f.category !== null && todo.category !== f.category) return false;
  const q = fold(f.query.trim());
  if (q && !fold(`${todo.title} ${todo.description ?? ''} ${todo.category ?? ''}`).includes(q)) return false;
  return true;
}

/** Filtra e ordena. As urgentes SEMPRE ficam no topo, mesmo com filtros ativos. */
export function selectTodos(todos: readonly Todo[], f: TodoFilters): Todo[] {
  return todos.filter((t) => matches(t, f)).sort(compareTodos);
}
