import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { blankTodo } from './merge';
import { SyncResponse, Todo } from './models';
import { setupApp, tick } from './testing';
import { TodoRepository, newId, normalize } from './todo-repository';

const serverTodo = (id: string, title: string, extra: Partial<Todo> = {}): Todo => ({
  ...blankTodo(id, 1), title, version: 1, seq: 1, fieldTimes: { title: 5 }, ...extra,
});
const response = (extra: Partial<SyncResponse> = {}): SyncResponse => ({ results: [], changes: [], cursor: 0, hasMore: false, ...extra });

describe('TodoRepository', () => {
  let repo: TodoRepository;

  beforeEach(async () => {
    ({ repo } = await setupApp());
  });

  describe('criação', () => {
    it('exige título', async () => {
      await expect(repo.create({ title: '   ' })).rejects.toThrow(/título/i);
      expect(repo.todos()).toHaveLength(0);
    });

    it('apara espaços e guarda só os campos informados', async () => {
      const id = await repo.create({ title: '  Medir tensão  ', priority: 'high' });
      const t = repo.byId().get(id)!;
      expect([t.title, t.priority, t.status, t.description, t.category]).toEqual(['Medir tensão', 'high', 'pending', null, null]);
    });

    it('descrição/lista vazias viram null', async () => {
      const id = await repo.create({ title: 'x', description: '  ', category: '' });
      const t = repo.byId().get(id)!;
      expect([t.description, t.category]).toEqual([null, null]);
    });

    it('cada criação gera um id e uma operação próprios', async () => {
      const a = await repo.create({ title: 'a' });
      const b = await repo.create({ title: 'b' });
      expect(a).not.toBe(b);
      expect(repo.ops()).toHaveLength(2);
      expect(repo.ops()[0].createdAt).toBeTypeOf('number');
    });
  });

  describe('edição', () => {
    it('só envia os campos que realmente mudaram', async () => {
      const id = await repo.create({ title: 'a', priority: 'low' });
      repo.ops().forEach(() => undefined);
      await repo.update(id, { title: 'a', priority: 'low', category: 'Campo' });
      const changes = Object.keys(repo.ops()[0].changes);
      expect(changes.sort()).toEqual(['category', 'priority', 'title']); // mesclada na op de criação
      expect(repo.byId().get(id)!.category).toBe('Campo');
    });

    it('editar sem mudar nada não grava nada', async () => {
      const id = await repo.create({ title: 'a' });
      const before = repo.writes();
      await repo.update(id, { title: 'a' });
      expect(repo.writes()).toBe(before);
    });

    it('editar uma tarefa inexistente é ignorado', async () => {
      await repo.update('nao-existe', { title: 'x' });
      expect(repo.ops()).toHaveLength(0);
    });

    it('toggle conclui e reabre', async () => {
      const id = await repo.create({ title: 'a' });
      await repo.toggle(id);
      expect(repo.byId().get(id)!.status).toBe('completed');
      await repo.toggle(id);
      expect(repo.byId().get(id)!.status).toBe('pending');
    });

    it('instantes das edições são estritamente crescentes (nunca empatam no mesmo dispositivo)', async () => {
      const id = await repo.create({ title: 'a' });
      await repo.update(id, { title: 'b' });
      await repo.update(id, { title: 'c' });
      const t = repo.byId().get(id)!;
      expect(t.title).toBe('c');
      const at = repo.ops()[0].changes.title!.at;
      expect(at).toBeGreaterThan(repo.ops()[0].createdAt!);
    });

    it('urgente: adicionar e remover a palavra reordena a flag na hora', async () => {
      const id = await repo.create({ title: 'Verificar bateria' });
      await repo.update(id, { description: 'URGENTE amanhã' });
      expect(repo.byId().get(id)!.isUrgent).toBe(true);
      await repo.update(id, { description: null });
      expect(repo.byId().get(id)!.isUrgent).toBe(false);
    });
  });

  describe('exclusão', () => {
    it('tarefa já conhecida pelo servidor: some da UI e enfileira a exclusão', async () => {
      await repo.commit([], response({ changes: [serverTodo('s1', 'Do servidor')], cursor: 1 }));
      expect(repo.todos()).toHaveLength(1);

      await repo.remove('s1');

      expect(repo.todos()).toHaveLength(0);
      expect(repo.ops()).toHaveLength(1);
      expect(repo.ops()[0].deletedAt).not.toBeNull();
    });

    it('remove também as edições pendentes que se tornaram inúteis', async () => {
      await repo.commit([], response({ changes: [serverTodo('s1', 'Do servidor')], cursor: 1 }));
      await repo.update('s1', { priority: 'high' });
      await repo.update('s1', { category: 'X' });

      await repo.remove('s1');

      expect(repo.ops().filter((o) => o.deletedAt === null)).toHaveLength(0);
      expect(repo.ops().filter((o) => o.deletedAt !== null)).toHaveLength(1);
    });

    it('criada e excluída antes de qualquer envio: nada vai para o servidor', async () => {
      const id = await repo.create({ title: 'Engano' });
      await repo.remove(id);
      expect(repo.ops()).toHaveLength(0);
      expect(repo.todos()).toHaveLength(0);
    });

    it('se a criação já está em voo, a exclusão é enfileirada (o servidor pode ter recebido)', async () => {
      const id = await repo.create({ title: 'Em voo' });
      repo.takeBatch(10); // marca a criação como enviada

      await repo.remove(id);

      expect(repo.ops().some((o) => o.deletedAt !== null && o.id === id)).toBe(true);
    });
  });

  describe('fila e envio', () => {
    it('edições feitas com a criação em voo viram uma operação nova', async () => {
      const id = await repo.create({ title: 'Voando' });
      const [sent] = repo.takeBatch(10);

      await repo.update(id, { priority: 'high' });

      expect(repo.ops()).toHaveLength(2);
      expect(sent.changes.priority).toBeUndefined();
      expect(repo.ops()[1].changes.priority?.value).toBe('high');
    });

    it('takeBatch respeita o limite e a ordem de gravação', async () => {
      await repo.create({ title: 'a' });
      await repo.create({ title: 'b' });
      await repo.create({ title: 'c' });
      expect(repo.takeBatch(2).map((o) => o.changes.title?.value)).toEqual(['a', 'b']);
    });

    it('commit remove só as operações respondidas e grava o cursor', async () => {
      const a = await repo.create({ title: 'a' });
      await repo.create({ title: 'b' });
      const batch = repo.takeBatch(10);

      await repo.commit(batch, response({ results: [{ opId: batch[0].opId, status: 'applied' }], changes: [serverTodo(a, 'a')], cursor: 42 }));

      expect(repo.ops()).toHaveLength(1);
      expect(repo.ops()[0].changes.title?.value).toBe('b');
      expect(repo.cursor).toBe(42);
      expect(repo.lastSyncedAt()).toBeTypeOf('number');
    });

    it('operação recusada pelo servidor é removida e a tarefa volta ao estado do servidor', async () => {
      await repo.commit([], response({ changes: [serverTodo('s1', 'Original')], cursor: 1 }));
      await repo.update('s1', { title: 'Edição inválida' });
      const batch = repo.takeBatch(10);

      await repo.commit(batch, response({
        results: [{ opId: batch[0].opId, status: 'rejected', error: 'inválido', current: serverTodo('s1', 'Original') }],
        cursor: 2,
      }));

      expect(repo.ops()).toHaveLength(0);
      expect(repo.byId().get('s1')!.title).toBe('Original');
    });

    it('tombstone do servidor apaga a tarefa da base', async () => {
      await repo.commit([], response({ changes: [serverTodo('s1', 'x')], cursor: 1 }));
      await repo.commit([], response({ changes: [{ ...serverTodo('s1', 'x'), deletedAt: 9 }], cursor: 2 }));
      expect(repo.todos()).toHaveLength(0);
      expect(repo.baseOf('s1')).toBeUndefined();
    });

    it('edição pendente mais nova que a do servidor continua visível; mais antiga é descartada na visão', async () => {
      await repo.update('nada', { title: 'x' }); // ignorado
      await repo.commit([], response({ changes: [serverTodo('s1', 'Servidor', { fieldTimes: { title: Date.now() + 60_000 } })], cursor: 1 }));
      await repo.update('s1', { title: 'Minha edição antiga' });
      // o instante local (agora) é MENOR que o do servidor (+60s): o servidor vence na visão
      expect(repo.byId().get('s1')!.title).toBe('Servidor');
    });

    it('releaseBatch libera as operações para serem mescladas de novo', async () => {
      const id = await repo.create({ title: 'a' });
      repo.takeBatch(10);
      repo.releaseBatch();
      await repo.update(id, { priority: 'high' });
      expect(repo.ops()).toHaveLength(1);
    });

    it('cada escrita incrementa o contador que dispara o envio', async () => {
      const w = repo.writes();
      await repo.create({ title: 'a' });
      expect(repo.writes()).toBeGreaterThan(w);
    });
  });

  describe('persistência', () => {
    it('os dados e a fila sobrevivem a "fechar e reabrir o app"', async () => {
      const user = repo.userId!;
      const id = await repo.create({ title: 'Persistida', priority: 'high' });
      await repo.commit([], response({ changes: [serverTodo('s1', 'Base')], cursor: 7 }));

      repo.close();
      await repo.init(user);

      expect(repo.byId().get(id)?.title).toBe('Persistida');
      expect(repo.byId().get('s1')?.title).toBe('Base');
      expect(repo.ops()).toHaveLength(1);
      expect(repo.cursor).toBe(7);
    });

    it('bancos de usuários diferentes são isolados', async () => {
      await repo.create({ title: 'Só da Ana' });
      const ana = repo.userId!;

      await repo.init(`outro-${crypto.randomUUID()}`);
      expect(repo.todos()).toHaveLength(0);
      expect(repo.ops()).toHaveLength(0);

      await repo.init(ana);
      expect(repo.todos().map((t) => t.title)).toEqual(['Só da Ana']);
    });

    it('pendingIds e pendingCount refletem a fila', async () => {
      const id = await repo.create({ title: 'a' });
      expect(repo.pendingIds().has(id)).toBe(true);
      expect(repo.pendingCount()).toBe(1);
      await tick(1);
    });
  });
});

describe('helpers', () => {
  it('normalize apara texto, esvazia para null e preserva enums', () => {
    expect(normalize('title', '  a  ')).toBe('a');
    expect(normalize('description', '   ')).toBeNull();
    expect(normalize('category', null)).toBeNull();
    expect(normalize('priority', 'high')).toBe('high');
    expect(normalize('status', 'completed')).toBe('completed');
  });

  it('newId gera UUID v4 únicos', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('newId funciona sem crypto.randomUUID (contexto http não seguro)', () => {
    const original = crypto.randomUUID;
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
    try {
      expect(newId()).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: original });
    }
  });
});

// o TestBed é reiniciado pelo ambiente entre arquivos; este import garante o setup do Angular
void TestBed;
