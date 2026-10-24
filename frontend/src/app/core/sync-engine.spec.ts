import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from './auth.service';
import { blankTodo } from './merge';
import { SyncResponse, Todo } from './models';
import { NoticeService } from './notice.service';
import { SyncEngine } from './sync-engine';
import { setOnline, setupApp, tick } from './testing';
import { TodoRepository } from './todo-repository';

const serverTodo = (id: string, title: string): Todo => ({ ...blankTodo(id, 1), title, version: 1, seq: 1, fieldTimes: { title: 5 } });
const ok = (extra: Partial<SyncResponse> = {}): SyncResponse => ({ results: [], changes: [], cursor: 0, hasMore: false, ...extra });

describe('SyncEngine', () => {
  let repo: TodoRepository;
  let engine: SyncEngine;
  let http: HttpTestingController;
  let notices: NoticeService;
  let auth: AuthService;

  beforeEach(async () => {
    ({ repo, http } = await setupApp());
    engine = TestBed.inject(SyncEngine);
    notices = TestBed.inject(NoticeService);
    auth = TestBed.inject(AuthService);
  });

  afterEach(() => engine.stop());

  it('rótulos do indicador por estado e quantidade de pendências', async () => {
    expect(engine.label()).toBe('Sincronizado');
    setOnline(false);
    await repo.create({ title: 'a' });
    await engine.run();
    expect(engine.label()).toBe('Offline · 1 alteração pendente');
    await repo.create({ title: 'b' });
    expect(engine.label()).toBe('Offline · 2 alterações pendentes');
  });

  it('401 coloca o estado em "auth", mantém a fila e não agenda novas tentativas', async () => {
    await repo.create({ title: 'a' });
    const p = engine.run();
    await tick();
    http.expectOne('/api/sync').flush({}, { status: 401, statusText: 'Unauthorized' });
    await p;

    expect(engine.state()).toBe('auth');
    expect(repo.pendingCount()).toBe(1);
    expect(engine.label()).toContain('Sessão expirada');
  });

  it('depois de um novo login (sessão renovada), voltar ao app retoma o envio da fila guardada', async () => {
    await repo.create({ title: 'guardada durante a sessão expirada' });
    auth.markExpired();
    await engine.run();
    expect(engine.state()).toBe('auth');

    auth.expired.set(false); // novo login bem-sucedido
    engine.start(); // o guard chama start() ao entrar de novo na tela principal
    await tick();

    const req = http.expectOne('/api/sync');
    expect(req.request.body.mutations).toHaveLength(1);
    req.flush(ok({ results: [{ opId: req.request.body.mutations[0].opId, status: 'applied' }], cursor: 1 }));
    await tick();
    expect(engine.state()).toBe('synced');
    expect(repo.pendingCount()).toBe(0);
  });

  it('com a sessão marcada como expirada, nem tenta chamar o servidor', async () => {
    await repo.create({ title: 'a' });
    auth.markExpired();

    await engine.run();

    http.expectNone('/api/sync');
    expect(engine.state()).toBe('auth');
  });

  it('erro 500 marca falha, mantém a fila e agenda nova tentativa', async () => {
    await repo.create({ title: 'a' });
    const p = engine.run();
    await tick();
    http.expectOne('/api/sync').flush('boom', { status: 500, statusText: 'Server Error' });
    await p;

    expect(engine.state()).toBe('error');
    expect(repo.pendingCount()).toBe(1);
  });

  it.each([502, 503, 504])('gateway %i (proxy sem backend) conta como offline', async (status) => {
    await repo.create({ title: 'a' });
    const p = engine.run();
    await tick();
    http.expectOne('/api/sync').flush('', { status, statusText: 'Gateway' });
    await p;
    expect(engine.state()).toBe('offline');
  });

  it('baixa várias páginas enquanto houver hasMore', async () => {
    const p = engine.run();
    await tick();
    http.expectOne('/api/sync').flush(ok({ changes: [serverTodo('a', 'A')], cursor: 1, hasMore: true }));
    await tick();
    const second = http.expectOne('/api/sync');
    expect(second.request.body.cursor).toBe(1);
    second.flush(ok({ changes: [serverTodo('b', 'B')], cursor: 2, hasMore: false }));
    await p;

    expect(repo.todos().map((t) => t.title).sort()).toEqual(['A', 'B']);
    expect(repo.cursor).toBe(2);
    expect(engine.state()).toBe('synced');
  });

  it('o cursor enviado é o último confirmado', async () => {
    await repo.commit([], ok({ changes: [serverTodo('a', 'A')], cursor: 17 }));
    const p = engine.run();
    await tick();
    const req = http.expectOne('/api/sync');
    expect(req.request.body.cursor).toBe(17);
    req.flush(ok({ cursor: 17 }));
    await p;
  });

  it('envia no máximo 200 operações por requisição e continua até esvaziar a fila', async () => {
    for (let i = 0; i < 205; i++) await repo.create({ title: `t${i}` });
    const p = engine.run();
    await tick(60);
    const first = http.expectOne('/api/sync');
    expect(first.request.body.mutations).toHaveLength(200);
    first.flush(ok({ results: first.request.body.mutations.map((m: { opId: string }) => ({ opId: m.opId, status: 'applied' })), cursor: 1 }));
    await tick(60);
    const second = http.expectOne('/api/sync');
    expect(second.request.body.mutations).toHaveLength(5);
    second.flush(ok({ results: second.request.body.mutations.map((m: { opId: string }) => ({ opId: m.opId, status: 'applied' })), cursor: 2 }));
    await p;

    expect(repo.pendingCount()).toBe(0);
    expect(engine.state()).toBe('synced');
  });

  it('operação recusada gera um aviso de erro e some da fila', async () => {
    await repo.create({ title: 'a' });
    const p = engine.run();
    await tick();
    const req = http.expectOne('/api/sync');
    req.flush(ok({ results: [{ opId: req.request.body.mutations[0].opId, status: 'rejected', error: 'title é obrigatório.' }], cursor: 1 }));
    await p;

    expect(notices.notices().some((n) => n.kind === 'error' && n.text.includes('title é obrigatório'))).toBe(true);
    expect(repo.pendingCount()).toBe(0);
  });

  it('chamadas simultâneas a run() viram uma só requisição (sem corrida)', async () => {
    await repo.create({ title: 'a' });
    const a = engine.run();
    const b = engine.run();
    const c = engine.run();
    await tick();
    const req = http.expectOne('/api/sync'); // uma única
    req.flush(ok({ results: [{ opId: req.request.body.mutations[0].opId, status: 'applied' }], cursor: 1 }));
    await tick();
    http.match('/api/sync').forEach((r) => r.flush(ok())); // eventual repasse por "again"
    await Promise.all([a, b, c]);
    expect(engine.state()).toBe('synced');
  });

  it('syncNow reinicia o contador de falhas e executa', async () => {
    const p = engine.syncNow();
    await tick();
    http.expectOne('/api/sync').flush(ok());
    await p;
    expect(engine.state()).toBe('synced');
  });

  it('sem conexão, run() não chama o servidor e fica offline', async () => {
    setOnline(false);
    await repo.create({ title: 'a' });
    await engine.run();
    http.expectNone('/api/sync');
    expect(engine.state()).toBe('offline');
  });

  it('o evento "online" dispara a sincronização da fila', async () => {
    setOnline(false);
    await repo.create({ title: 'feita offline' });
    engine.start();
    await tick();
    http.expectNone('/api/sync');

    setOnline(true);
    window.dispatchEvent(new Event('online'));
    await tick();

    const req = http.expectOne('/api/sync');
    expect(req.request.body.mutations).toHaveLength(1);
    req.flush(ok({ results: [{ opId: req.request.body.mutations[0].opId, status: 'applied' }], cursor: 1 }));
    await tick();
    expect(engine.state()).toBe('synced');
  });

  it('o evento "offline" muda o estado imediatamente', () => {
    engine.start();
    window.dispatchEvent(new Event('offline'));
    expect(engine.state()).toBe('offline');
  });
});
