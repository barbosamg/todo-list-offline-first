import { describe, expect, it } from 'vitest';
import { blankTodo } from './merge';
import { Todo } from './models';
import { EMPTY_FILTERS, NO_CATEGORY, selectTodos } from './todo-query';
import { isUrgent } from './urgent-rule';

let n = 0;
function todo(title: string, extra: Partial<Todo> = {}): Todo {
  const t = { ...blankTodo(`id-${n++}`, 1), title, ...extra };
  return { ...t, isUrgent: isUrgent(t.title, t.description) };
}
const titles = (l: Todo[]) => l.map((t) => t.title);

describe('ordenação e filtros', () => {
  it('urgentes ficam no topo, mesmo concluídas ou de baixa prioridade', () => {
    const list = [
      todo('alta', { priority: 'high', dueDate: '2026-01-01' }),
      todo('Urgente concluída', { status: 'completed', priority: 'low' }),
      todo('média'),
    ];
    expect(titles(selectTodos(list, EMPTY_FILTERS))[0]).toBe('Urgente concluída');
  });

  it('entre urgentes vale a ordenação padrão: prioridade, depois vencimento', () => {
    const list = [
      todo('U baixa urgente', { priority: 'low' }),
      todo('U alta tarde urgente', { priority: 'high', dueDate: '2026-12-01' }),
      todo('U alta cedo urgente', { priority: 'high', dueDate: '2026-06-01' }),
      todo('comum alta', { priority: 'high' }),
    ];
    expect(titles(selectTodos(list, EMPTY_FILTERS))).toEqual([
      'U alta cedo urgente',
      'U alta tarde urgente',
      'U baixa urgente',
      'comum alta',
    ]);
  });

  it('ordem padrão: pendentes, prioridade, vencimento (sem data por último), mais recentes', () => {
    const list = [
      todo('concluída alta', { priority: 'high', status: 'completed' }),
      todo('pendente baixa', { priority: 'low' }),
      todo('média sem data', { createdAt: 5 }),
      todo('média com data', { dueDate: '2026-03-01', createdAt: 1 }),
      todo('média sem data antiga', { createdAt: 2 }),
    ];
    expect(titles(selectTodos(list, EMPTY_FILTERS))).toEqual([
      'média com data',
      'média sem data',
      'média sem data antiga',
      'pendente baixa',
      'concluída alta',
    ]);
  });

  it('as urgentes continuam no topo com filtros ativos', () => {
    const list = [todo('alta', { priority: 'high' }), todo('urgente alta', { priority: 'high' }), todo('baixa', { priority: 'low' })];
    expect(titles(selectTodos(list, { ...EMPTY_FILTERS, priority: 'high' }))).toEqual(['urgente alta', 'alta']);
  });

  it('busca ignora maiúsculas e acentos e olha título, descrição e lista', () => {
    const list = [todo('Reunião', { description: 'sala 3' }), todo('Compras', { category: 'Casa' })];
    expect(titles(selectTodos(list, { ...EMPTY_FILTERS, query: 'reuniao' }))).toEqual(['Reunião']);
    expect(titles(selectTodos(list, { ...EMPTY_FILTERS, query: 'SALA' }))).toEqual(['Reunião']);
    expect(titles(selectTodos(list, { ...EMPTY_FILTERS, query: 'casa' }))).toEqual(['Compras']);
  });

  it('filtra por status e por lista (incluindo "sem lista")', () => {
    const list = [
      todo('a', { category: 'Casa' }),
      todo('b', { category: 'Trabalho', status: 'completed' }),
      todo('c'),
    ];
    expect(titles(selectTodos(list, { ...EMPTY_FILTERS, status: 'completed' }))).toEqual(['b']);
    expect(titles(selectTodos(list, { ...EMPTY_FILTERS, category: 'Casa' }))).toEqual(['a']);
    expect(titles(selectTodos(list, { ...EMPTY_FILTERS, category: NO_CATEGORY }))).toEqual(['c']);
  });
});
