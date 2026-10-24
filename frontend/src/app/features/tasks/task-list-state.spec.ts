import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { setupApp } from '../../core/testing';
import { NO_CATEGORY } from '../../core/todo-query';
import { TodoRepository } from '../../core/todo-repository';
import { TaskListState } from './task-list-state';

describe('TaskListState', () => {
  let repo: TodoRepository;
  let state: TaskListState;

  beforeEach(async () => {
    ({ repo } = await setupApp());
    state = TestBed.inject(TaskListState);
    await repo.create({ title: 'Comprar fita', category: 'Almoxarifado', priority: 'low' });
    await repo.create({ title: 'Inspecionar poste', category: 'Campo', priority: 'high' });
    await repo.create({ title: 'Ligar para cliente URGENTE', category: 'Campo' });
    const done = await repo.create({ title: 'Relatório semanal', category: 'Escritório' });
    await repo.toggle(done);
    await repo.create({ title: 'Sem lista nenhuma' });
  });

  it('as urgentes vêm primeiro e ficam numa lista separada', () => {
    expect(state.urgent().map((t) => t.title)).toEqual(['Ligar para cliente URGENTE']);
    expect(state.visible()[0].title).toBe('Ligar para cliente URGENTE');
    expect(state.others().some((t) => t.isUrgent)).toBe(false);
  });

  it('totais: todas, pendentes, urgentes pendentes e sem lista', () => {
    expect(state.totals()).toEqual({ all: 5, pending: 4, urgent: 1, uncategorized: 1 });
  });

  it('listas: nomes únicos, ordem alfabética, com contagem de pendentes e urgentes', () => {
    expect(state.lists()).toEqual([
      { name: 'Almoxarifado', pending: 1, urgent: 0 },
      { name: 'Campo', pending: 2, urgent: 1 },
      { name: 'Escritório', pending: 0, urgent: 0 }, // concluída não conta como pendente
    ]);
  });

  it('filtrar por lista, incluindo "sem lista"', () => {
    state.category.set('Campo');
    expect(state.visible().map((t) => t.title)).toEqual(['Ligar para cliente URGENTE', 'Inspecionar poste']);
    expect(state.title()).toBe('Campo');

    state.category.set(NO_CATEGORY);
    expect(state.visible().map((t) => t.title)).toEqual(['Sem lista nenhuma']);
    expect(state.title()).toBe('Sem lista');

    state.category.set(null);
    expect(state.title()).toBe('Todas as tarefas');
  });

  it('busca e filtros combinam; as urgentes continuam no topo', () => {
    state.status.set('pending');
    state.priority.set('all');
    expect(state.visible().every((t) => t.status === 'pending')).toBe(true);
    expect(state.visible()[0].isUrgent).toBe(true);

    state.query.set('poste');
    expect(state.visible().map((t) => t.title)).toEqual(['Inspecionar poste']);
  });

  it('hasFilters e clearFilters', () => {
    expect(state.hasFilters()).toBe(false);
    state.query.set('x');
    state.status.set('completed');
    state.priority.set('high');
    expect(state.hasFilters()).toBe(true);

    state.clearFilters();

    expect([state.query(), state.status(), state.priority()]).toEqual(['', 'all', 'all']);
    expect(state.hasFilters()).toBe(false);
  });

  it('a lista reage na hora a uma nova tarefa urgente criada offline', async () => {
    await repo.create({ title: 'Trocar disjuntor — urgente' });
    expect(state.urgent()).toHaveLength(2);
    expect(state.totals().urgent).toBe(2);
  });

  it('concluir uma urgente a tira da contagem de pendentes, mas ela continua no topo', async () => {
    const urgent = state.urgent()[0];
    await repo.toggle(urgent.id);
    expect(state.totals().urgent).toBe(0);
    expect(state.visible()[0].id).toBe(urgent.id);
  });
});
