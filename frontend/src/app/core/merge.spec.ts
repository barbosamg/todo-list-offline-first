import { describe, expect, it } from 'vitest';
import { applyChanges, blankTodo, overlay } from './merge';
import { Changes, OutboxOp, Todo } from './models';

const ch = (field: keyof Changes, value: string | null, at: number): Changes => ({ [field]: { value, at } });
const op = (id: string, changes: Changes, extra: Partial<OutboxOp> = {}): OutboxOp => ({
  opId: crypto.randomUUID(),
  id,
  changes,
  deletedAt: null,
  createdAt: null,
  ...extra,
});

describe('merge LWW por campo', () => {
  const fresh = () => blankTodo('a', 1);

  it('edições em campos diferentes se combinam', () => {
    let t = applyChanges(fresh(), ch('title', 'Comprar pão', 10));
    t = applyChanges(t, ch('priority', 'high', 20));
    t = applyChanges(t, ch('description', 'integral', 15));
    expect([t.title, t.priority, t.description]).toEqual(['Comprar pão', 'high', 'integral']);
  });

  it('no mesmo campo vence a edição mais recente, não a que chegou por último', () => {
    let t = applyChanges(fresh(), ch('title', 'novo', 30));
    t = applyChanges(t, ch('title', 'velho', 20));
    expect(t.title).toBe('novo');
  });

  it('é comutativo e idempotente (converge em qualquer ordem, com reenvios)', () => {
    const a: Changes = { ...ch('title', 'A', 10), ...ch('category', 'casa', 50) };
    const b: Changes = { ...ch('title', 'B', 20), ...ch('category', 'trabalho', 40) };
    const x = [a, b, a].reduce(applyChanges, fresh());
    const y = [b, a, b].reduce(applyChanges, fresh());
    expect([x.title, x.category]).toEqual([y.title, y.category]);
    expect([x.title, x.category]).toEqual(['B', 'casa']);
  });

  it('empate de timestamp é decidido de forma determinística', () => {
    const x = applyChanges(applyChanges(fresh(), ch('title', 'alfa', 10)), ch('title', 'beta', 10));
    const y = applyChanges(applyChanges(fresh(), ch('title', 'beta', 10)), ch('title', 'alfa', 10));
    expect(x.title).toBe(y.title);
  });

  it('mesmo valor com instante mais novo só registra o instante (merge continua comutativo)', () => {
    // dispositivo A "reabre" (pending @30) quando o servidor já está pending; o B conclui @20 e chega depois
    const reopenFirst = applyChanges(applyChanges(fresh(), ch('status', 'pending', 30)), ch('status', 'completed', 20));
    const completeFirst = applyChanges(applyChanges(fresh(), ch('status', 'completed', 20)), ch('status', 'pending', 30));
    expect(reopenFirst.status).toBe('pending');
    expect(completeFirst.status).toBe('pending');
    expect(reopenFirst.fieldTimes['status']).toBe(30);
  });

  it('recalcula isUrgent a partir de título e descrição', () => {
    let t = applyChanges(fresh(), ch('title', 'Pagar conta', 10));
    expect(t.isUrgent).toBe(false);
    t = applyChanges(t, ch('description', 'é URGENTE', 11));
    expect(t.isUrgent).toBe(true);
    t = applyChanges(t, ch('description', null, 12));
    expect(t.isUrgent).toBe(false);
  });
});

describe('overlay (base + fila pendente)', () => {
  const base: Todo = { ...blankTodo('a', 1), title: 'Server', fieldTimes: { title: 5 }, version: 3 };

  it('mostra a edição pendente por cima do estado do servidor', () => {
    const view = overlay(base, [op('a', ch('title', 'Editado offline', 10))])!;
    expect(view.title).toBe('Editado offline');
  });

  it('descarta edição pendente mais antiga que a do servidor (já convergiu)', () => {
    const view = overlay(base, [op('a', ch('title', 'antiga', 2))])!;
    expect(view.title).toBe('Server');
  });

  it('tarefa criada offline existe só na fila e já aparece', () => {
    const view = overlay(undefined, [op('n', ch('title', 'Nova', 10), { createdAt: 10 })])!;
    expect(view.title).toBe('Nova');
    expect(view.createdAt).toBe(10);
  });

  it('remoção pendente esconde a tarefa imediatamente', () => {
    expect(overlay(base, [op('a', {}, { deletedAt: 9 })])).toBeNull();
  });
});
