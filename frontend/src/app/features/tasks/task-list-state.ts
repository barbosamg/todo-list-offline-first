import { Injectable, computed, inject, signal } from '@angular/core';
import { Priority, Status, Todo } from '../../core/models';
import { EMPTY_FILTERS, NO_CATEGORY, TodoFilters, selectTodos } from '../../core/todo-query';
import { TodoRepository } from '../../core/todo-repository';

export interface ListSummary {
  name: string;
  pending: number;
  urgent: number;
}

/** Estado de apresentação da lista: filtros e as visões derivadas (sempre calculadas localmente → funcionam offline). */
@Injectable({ providedIn: 'root' })
export class TaskListState {
  private readonly repo = inject(TodoRepository);

  readonly query = signal('');
  readonly status = signal<'all' | Status>('all');
  readonly priority = signal<'all' | Priority>('all');
  readonly category = signal<string | null>(null);

  readonly filters = computed<TodoFilters>(() => ({
    query: this.query(),
    status: this.status(),
    priority: this.priority(),
    category: this.category(),
  }));
  readonly hasFilters = computed(() => {
    const f = this.filters();
    return f.query.trim() !== '' || f.status !== 'all' || f.priority !== 'all';
  });

  /** Resultado final: filtrado e ordenado, com as urgentes no topo. */
  readonly visible = computed<Todo[]>(() => selectTodos(this.repo.todos(), this.filters()));
  readonly urgent = computed(() => this.visible().filter((t) => t.isUrgent));
  readonly others = computed(() => this.visible().filter((t) => !t.isUrgent));

  readonly all = this.repo.todos;
  readonly totals = computed(() => {
    const all = this.repo.todos();
    return {
      all: all.length,
      pending: all.filter((t) => t.status === 'pending').length,
      urgent: all.filter((t) => t.isUrgent && t.status === 'pending').length,
      uncategorized: all.filter((t) => t.category === null).length,
    };
  });

  /** Listas = categorias em uso (criadas ao atribuir uma lista a uma tarefa). */
  readonly lists = computed<ListSummary[]>(() => {
    const map = new Map<string, ListSummary>();
    for (const t of this.repo.todos()) {
      if (!t.category) continue;
      const s = map.get(t.category) ?? { name: t.category, pending: 0, urgent: 0 };
      if (t.status === 'pending') {
        s.pending++;
        if (t.isUrgent) s.urgent++;
      }
      map.set(t.category, s);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  });

  readonly title = computed(() => {
    const c = this.category();
    return c === null ? 'Todas as tarefas' : c === NO_CATEGORY ? 'Sem lista' : c;
  });

  clearFilters(): void {
    this.query.set(EMPTY_FILTERS.query);
    this.status.set(EMPTY_FILTERS.status);
    this.priority.set(EMPTY_FILTERS.priority);
  }
}
