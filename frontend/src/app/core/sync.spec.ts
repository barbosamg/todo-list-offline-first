import 'fake-indexeddb/auto';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from './auth.service';
import { blankTodo } from './merge';
import { SyncResponse, Todo } from './models';
import { NoticeService } from './notice.service';
import { SyncEngine } from './sync-engine';
import { TodoRepository } from './todo-repository';

function serverTodo(id: string, title: string, extra: Partial<Todo> = {}): Todo {
  return { ...blankTodo(id, 1), title, version: 1, seq: 1, fieldTimes: { title: 5 }, ...extra };
}

const empty = (cursor = 0): SyncResponse => ({ results: [], changes: [], cursor, hasMore: false });

describe('fila offline + sincronização', () => {
  let repo: TodoRepository;
  let engine: SyncEngine;
  let http: HttpTestingController;
  let notices: NoticeService;
  let online = true;

  beforeEach(async () => {
    online = true;
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideHttpClient(), provideHttpClientTesting()],
    });
    repo = TestBed.inject(TodoRepository);
    engine = TestBed.inject(SyncEngine);
    http = TestBed.inject(HttpTestingController);
    notices = TestBed.inject(NoticeService);
    TestBed.inject(AuthService);
    await repo.init(`user-${crypto.randomUUID()}`); // um IndexedDB novo por teste
  });

  it('tarefa criada offline aparece na hora e fica na fila — sem nenhuma chamada de rede', async () => {
    online = false;
    await repo.create({ title: 'Inspecionar poste 12' });

    expect(repo.todos().map((t) => t.title)).toEqual(['Inspecionar poste 12']);
    expect(repo.pendingCount()).toBe(1);

    await engine.run();
    expect(engine.state()).toBe('offline');
    http.expectNone('/api/sync');
  });

  it('tarefa que passa a conter "urgente" offline é marcada como urgente imediatamente', async () => {
    online = false;
    const id = await repo.create({ title: 'Trocar lâmpada' });
    expect(repo.byId().get(id)!.isUrgent).toBe(false);

    await repo.update(id, { description: 'Isso é URGENTE' });

    expect(repo.byId().get(id)!.isUrgent).toBe(true);
  });

  it('várias edições da mesma tarefa são mescladas em uma operação (menos tráfego ao reconectar)', async () => {
    online = false;
    const id = await repo.create({ title: 'A' });
    await repo.update(id, { priority: 'high' });
    await repo.update(id, { title: 'A editada', category: 'Campo' });

    expect(repo.ops()).toHaveLength(1);
    expect(repo.ops()[0].changes.title?.value).toBe('A editada');
    expect(repo.ops()[0].changes.priority?.value).toBe('high');
  });

  it('tarefa criada e removida offline some sem nunca ser enviada', async () => {
    online = false;
    const id = await repo.create({ title: 'Engano' });
    await repo.remove(id);

    expect(repo.todos()).toHaveLength(0);
    expect(repo.ops()).toHaveLength(0);
  });

  it('ao reconectar, envia a fila, remove as operações confirmadas e atualiza a base', async () => {
    online = false;
    const id = await repo.create({ title: 'Feita no campo', priority: 'high' });
    online = true;

    const pending = engine.run();
    await tick();
    const req = http.expectOne('/api/sync');
    expect(req.request.body.mutations).toHaveLength(1);
    expect(req.request.body.mutations[0].id).toBe(id);
    expect(engine.state()).toBe('syncing');

    req.flush({
      results: [{ opId: req.request.body.mutations[0].opId, status: 'applied' }],
      changes: [serverTodo(id, 'Feita no campo', { priority: 'high', version: 1, seq: 7 })],
      cursor: 7,
      hasMore: false,
    } satisfies SyncResponse);
    await pending;

    expect(repo.pendingCount()).toBe(0);
    expect(repo.baseOf(id)?.version).toBe(1);
    expect(repo.cursor).toBe(7);
    expect(engine.state()).toBe('synced');
  });

  it('falha de rede mantém a fila intacta e marca offline', async () => {
    await repo.create({ title: 'Sem sinal' });
    const pending = engine.run();
    await tick();
    http.expectOne('/api/sync').error(new ProgressEvent('error'), { status: 0 });
    await pending;

    expect(engine.state()).toBe('offline');
    expect(repo.pendingCount()).toBe(1);
  });

  it('edição feita durante o envio não é perdida nem mesclada na operação em voo', async () => {
    const id = await repo.create({ title: 'Em voo' });
    const pending = engine.run();
    await tick();
    const req = http.expectOne('/api/sync');
    const sentOpId = req.request.body.mutations[0].opId;

    await repo.update(id, { priority: 'high' }); // chega enquanto o lote está viajando

    req.flush({
      results: [{ opId: sentOpId, status: 'applied' }],
      changes: [serverTodo(id, 'Em voo')],
      cursor: 1,
      hasMore: false,
    } satisfies SyncResponse);
    await tick();
    // o laço de drain reenvia a edição nova
    const second = http.expectOne('/api/sync');
    expect(second.request.body.mutations[0].changes.priority.value).toBe('high');
    second.flush(empty(1));
    await pending.catch(() => undefined);
  });

  it('remove da base a tarefa apagada em outro dispositivo (tombstone)', async () => {
    const pull = engine.run();
    await tick();
    http.expectOne('/api/sync').flush({ ...empty(3), changes: [serverTodo('x', 'Remota')] });
    await pull;
    expect(repo.todos().map((t) => t.id)).toEqual(['x']);

    const pull2 = engine.run();
    await tick();
    http.expectOne('/api/sync').flush({ ...empty(4), changes: [{ ...serverTodo('x', 'Remota'), deletedAt: 9 }] });
    await pull2;
    expect(repo.todos()).toHaveLength(0);
  });

  it('avisa quando uma edição perdeu para outra mais recente (conflito resolvido)', async () => {
    const id = await repo.create({ title: 'Conflito' });
    const pending = engine.run();
    await tick();
    const req = http.expectOne('/api/sync');
    req.flush({
      results: [{ opId: req.request.body.mutations[0].opId, status: 'applied', rejectedFields: ['title'] }],
      changes: [serverTodo(id, 'Versão do outro dispositivo')],
      cursor: 2,
      hasMore: false,
    } satisfies SyncResponse);
    await pending;

    expect(repo.byId().get(id)!.title).toBe('Versão do outro dispositivo');
    expect(notices.notices().some((n) => n.kind === 'warn' && n.text.includes('título'))).toBe(true);
  });
});

/** deixa microtarefas/IndexedDB assentarem */
const tick = () => new Promise((r) => setTimeout(r, 25));
