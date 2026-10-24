import { Changes, EDITABLE_FIELDS, Field, FieldValue, OutboxOp, Todo } from './models';
import { isUrgent } from './urgent-rule';

/**
 * Resolução de conflitos no dispositivo: a MESMA regra do servidor (TodoMerger.cs).
 * Registrador LWW por campo: vence o maior timestamp de edição; empate desempatado pelo valor.
 * Como a regra é idêntica nos dois lados e é comutativa/idempotente, cliente e servidor convergem.
 */
export function lwwWins(at: number, value: FieldValue, currentAt: number, currentValue: FieldValue): boolean {
  if (at !== currentAt) return at > currentAt;
  return (value ?? '') > (currentValue ?? ''); // ordinal (UTF-16), como string.CompareOrdinal
}

export function blankTodo(id: string, createdAt: number): Todo {
  return {
    id,
    title: '',
    description: null,
    dueDate: null,
    priority: 'medium',
    status: 'pending',
    category: null,
    isUrgent: false,
    version: 0,
    seq: 0,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    fieldTimes: {},
  };
}

export function applyChanges(todo: Todo, changes: Changes): Todo {
  const next: Todo = { ...todo, fieldTimes: { ...todo.fieldTimes } };
  const target = next as unknown as Record<Field, FieldValue>;
  for (const field of EDITABLE_FIELDS) {
    const change = changes[field];
    if (!change) continue;
    const current = (next as unknown as Record<Field, FieldValue>)[field] ?? null;
    if (current === change.value) {
      // mesmo valor: só registra o instante mais recente (igual ao servidor) para o merge continuar comutativo
      if (change.at > (next.fieldTimes[field] ?? 0)) next.fieldTimes[field] = change.at;
      continue;
    }
    if (!lwwWins(change.at, change.value, next.fieldTimes[field] ?? 0, current)) continue;
    target[field] = change.value;
    next.fieldTimes[field] = change.at;
    next.updatedAt = Math.max(next.updatedAt, change.at);
  }
  next.isUrgent = isUrgent(next.title, next.description);
  return next;
}

/**
 * Visão local de uma tarefa = estado confirmado pelo servidor (base) + operações pendentes por cima.
 * Retorna null se há uma remoção pendente (some da UI imediatamente) ou se a tarefa ainda é inválida.
 */
export function overlay(base: Todo | undefined, ops: readonly OutboxOp[]): Todo | null {
  if (ops.some((o) => o.deletedAt !== null)) return null;
  let todo = base ?? blankTodo(ops[0].id, ops.find((o) => o.createdAt)?.createdAt ?? Date.now());
  for (const op of ops) todo = applyChanges(todo, op.changes);
  if (!base && !todo.title) return null;
  return { ...todo, isUrgent: isUrgent(todo.title, todo.description) };
}
